import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ConfigSnapshot,
  McpStatus,
  NamedProvider,
  ProviderKind,
  SessionSummary,
  SignInResult,
  UsageSnapshot,
} from "../protocol";
import { formatTokens } from "../conversation";

/**
 * The modal panels: providers, models, reasoning effort, sessions, usage, MCP.
 *
 * Every panel is the same object — a titled box with a search field, a list, and
 * a footer line of key hints — because that is what the CLI's menus are, and
 * because a user who learned one has learned them all. The differences are the
 * rows and the verbs.
 */

export function Panel(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: string;
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Keyboard navigation, everywhere a mouse also works.
   *
   * The CLI's menus are driven by arrows and Enter, and a desktop app that only
   * answers the mouse is a different app. Rather than thread a cursor through
   * every panel, this focuses the *rows* — which are real buttons — so arrow
   * keys move the focus and Enter activates whatever holds it. Disabled rows are
   * not focusable at all, which is exactly what a menu wants for its
   * non-selectable lines.
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const rows = (): HTMLButtonElement[] =>
      Array.from(body.querySelectorAll<HTMLButtonElement>("button.panel-item:not(:disabled)"));
    // Focus the first row so the arrows work the moment the panel opens; the
    // search field keeps its own focus when there is one, since typing is what
    // a search panel is for.
    if (!props.search) rows()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const list = rows();
      if (list.length === 0) return;
      event.preventDefault();
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (current === -1 ? (step === 1 ? 0 : list.length - 1) : current + step + list.length) % list.length;
      list[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.title, props.search]);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="panel" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="panel-header">
          <span className="panel-title">{props.title}</span>
          <button type="button" className="panel-close" onClick={props.onClose}>
            Esc
          </button>
        </div>
        {props.search ? (
          <div className="panel-search">
            <div className="search-field">
              <span className="search-icon">⌕</span>
              <input
                className="search-input"
                value={props.search.value}
                onChange={(event) => props.search!.onChange(event.target.value)}
                placeholder={props.search.placeholder ?? "Search"}
                autoFocus
                spellCheck={false}
              />
            </div>
          </div>
        ) : null}
        <div className="panel-body" ref={bodyRef}>{props.children}</div>
        {props.footer ? <div className="panel-footer">{props.footer}</div> : null}
      </div>
    </div>
  );
}

function Row(props: {
  marker?: string;
  label: string;
  detail?: string;
  mono?: boolean;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`panel-item ${props.selected ? "selected" : ""} ${props.onClick ? "" : "static"}`}
      onClick={props.onClick}
      disabled={!props.onClick}
    >
      <span className="marker">{props.marker ?? " "}</span>
      <span className={`label ${props.mono ? "mono" : ""}`}>{props.label}</span>
      {props.detail ? <span className="detail">{props.detail}</span> : null}
    </button>
  );
}

const Divider = () => <div className="panel-divider" />;

/** `/provider` — switch endpoints, add one, manage one. */
export function ProviderPanel(props: {
  snapshot: ConfigSnapshot;
  onActivate: (name: string | null) => void;
  onRemove: (name: string) => void;
  onTest: (name?: string) => void;
  onAdd: (entry: { name?: string; baseUrl: string; model?: string; apiKey?: string }) => void;
  /** Fetch the models the candidate endpoint offers; empty means it listed none. */
  onDiscoverModels: (baseUrl: string, apiKey?: string) => Promise<string[]>;
  /** The sign-in kinds, fetched once by the app from the agent. */
  kinds: ProviderKind[];
  onSignIn: (kind: string) => Promise<SignInResult>;
  onClose: () => void;
}) {
  /**
   * The add flow: what it is, then which model.
   *
   * Two phases, in the order the fields read. It used to be three — url, then
   * key and name, then the model list — which put an action row *above* the
   * field it acted on and asked for the name after the credential it has nothing
   * to do with. One form in reading order (name, endpoint, key), one button
   * under it, then the model list with its own search; the finish button sits at
   * the bottom, where the flow ends.
   *
   * A listing that fails is still a successful phase: the key may be right and
   * the list endpoint absent, so a manual model name is offered rather than the
   * flow being abandoned (the CLI behaves the same way).
   */
  type AddPhase = "details" | "model";
  const [adding, setAdding] = useState(false);
  const [phase, setPhase] = useState<AddPhase>("details");
  const [form, setForm] = useState({ name: "", baseUrl: "", model: "", apiKey: "" });
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const providers = props.snapshot.providers;

  if (adding) {
    const entry = () => ({
      baseUrl: form.baseUrl.trim(),
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      model: form.model.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    });

    const findModels = (): void => {
      const url = form.baseUrl.trim();
      if (!/^https?:\/\//i.test(url)) {
        setPhaseError("A base URL starting with http:// or https:// is required.");
        return;
      }
      setPhaseError(null);
      setSubmitting(true);
      void props
        .onDiscoverModels(url, form.apiKey.trim() || undefined)
        .then((models) => {
          setDiscovered(models);
          setModelQuery("");
          setPhase("model");
        })
        .catch((error: Error) => {
          setDiscovered([]);
          setPhase("model");
          setPhaseError(`Could not list models (${error.message}) — name one by hand.`);
        })
        .finally(() => setSubmitting(false));
    };

    const finish = (): void => {
      if (!form.model.trim()) {
        setPhaseError("Name the model this provider should use.");
        return;
      }
      props.onAdd(entry());
      setAdding(false);
    };

    const field = (
      label: string,
      key: "name" | "baseUrl" | "apiKey",
      placeholder: string,
      type?: string,
    ) => (
      <label className="form-field">
        <span className="form-label">{label}</span>
        <input
          className="form-input"
          type={type ?? "text"}
          value={form[key]}
          placeholder={placeholder}
          onChange={(event) => setForm({ ...form, [key]: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            findModels();
          }}
          spellCheck={false}
          autoFocus={key === "name"}
        />
      </label>
    );

    const matches = discovered.filter((model) => model.toLowerCase().includes(modelQuery.toLowerCase()));

    return (
      <Panel
        title={phase === "details" ? "Add provider" : "Add provider — model"}
        onClose={() => {
          // Esc in the first phase leaves the whole flow; the model phase steps
          // back to the details, so a bad endpoint is a correction and not a
          // restart.
          if (phase === "details") {
            setAdding(false);
            return;
          }
          setPhaseError(null);
          setPhase("details");
        }}
        footer={
          phase === "details"
            ? "Enter to find models · Esc to cancel"
            : "Enter to add · Esc to go back"
        }
        {...(phase === "model" && discovered.length > 0
          ? {
              search: {
                value: modelQuery,
                onChange: setModelQuery,
                placeholder: `search ${discovered.length} model${discovered.length === 1 ? "" : "s"}`,
              },
            }
          : {})}
      >
        <div className="panel-form">
          {phase === "details" ? (
            <>
              {field("name", "name", "optional — defaults to the host")}
              {field("base url", "baseUrl", "https://api.example.com/v1")}
              {field("api key", "apiKey", "stored in config.json, or ${ENV_VAR}", "password")}
              {phaseError ? <div className="form-error">{phaseError}</div> : null}
              <Row
                marker="→"
                label={submitting ? "finding models…" : "Find models"}
                onClick={() => !submitting && findModels()}
              />
            </>
          ) : (
            <>
              <div className="form-review">{form.baseUrl.trim()}</div>
              {phaseError ? <div className="form-error">{phaseError}</div> : null}
              {matches.map((model) => (
                <Row
                  key={model}
                  marker={form.model === model ? "✓" : " "}
                  label={model}
                  mono
                  onClick={() => setForm({ ...form, model })}
                />
              ))}
              {discovered.length > 0 && matches.length === 0 ? <Row label="no matches" /> : null}
              <label className="form-field">
                <span className="form-label">
                  model {discovered.length > 0 ? "(or name another)" : ""}
                </span>
                <input
                  className="form-input"
                  value={form.model}
                  placeholder="e.g. gpt-4o-mini"
                  onChange={(event) => setForm({ ...form, model: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    finish();
                  }}
                  autoFocus={discovered.length === 0}
                  spellCheck={false}
                />
              </label>
              <Row marker="+" label="Add this provider" onClick={finish} />
            </>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Providers" onClose={props.onClose} footer="Enter to switch · Esc to close">
      <Row marker="+" label="Add provider" onClick={() => setAdding(true)} />
      <Row marker="✓" label="Test the active connection" onClick={() => props.onTest()} />
      {props.snapshot.providers.map((provider) => (
        <Row key={`remove-${provider.name}`} marker="✗" label={`Remove ${provider.name}`} onClick={() => props.onRemove(provider.name)} />
      ))}
      <Divider />
      {props.kinds.length > 0 ? (
        <>
          {props.kinds.map((kind) => (
            <Row
              key={kind.kind}
              marker="●"
              label={kind.label}
              detail={signingIn === kind.kind ? "waiting for the browser…" : "opens a browser"}
              onClick={() => {
                setSignInError(null);
                setManualUrl(null);
                setSigningIn(kind.kind);
                void props
                  .onSignIn(kind.kind)
                  .then((result) => {
                    if (!result.ok) {
                      setSignInError(result.message);
                      return;
                    }
                    if (!result.opened) {
                      // No shell to open a browser: the flow has not happened
                      // yet, so the URL is shown rather than a sign-in being
                      // reported that the user never completed.
                      setManualUrl(result.authorizeUrl);
                      setSignInError(
                        "This build could not open a browser. Open the link below to finish signing in.",
                      );
                    }
                  })
                  .finally(() => setSigningIn(null));
              }}
            />
          ))}
          {signInError ? <Row label={signInError} /> : null}
          {manualUrl ? (
            <div className="panel-form">
              <span className="form-label">authorize link</span>
              <a className="form-link" href={manualUrl} target="_blank" rel="noreferrer">
                {manualUrl}
              </a>
            </div>
          ) : null}
          <Divider />
        </>
      ) : null}

      <Row
        marker={props.snapshot.activeProvider ? " " : "●"}
        label="built-in endpoint"
        detail={props.snapshot.activeProvider ? "" : "in use"}
        onClick={() => props.onActivate(null)}
      />
      <Divider />
      {providers.length === 0 ? <Row label="no providers registered" /> : null}
      {providers.map((provider: NamedProvider) => (
        <Row
          key={provider.name}
          marker={provider.name === props.snapshot.activeProvider ? "●" : " "}
          label={provider.name}
          detail={provider.model ?? provider.baseUrl}
          onClick={() => props.onActivate(provider.name)}
        />
      ))}
      {props.snapshot.providerError ? (
        <>
          <Divider />
          <Row label={props.snapshot.providerError} />
        </>
      ) : null}
    </Panel>
  );
}

/** `/model` — search the models this endpoint offers, and fetch them. */
export function ModelPanel(props: {
  models: string[];
  current: string;
  onSet: (model: string) => void;
  onDiscover: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return props.models.filter((model) => model.toLowerCase().includes(q));
  }, [props.models, query]);

  return (
    <Panel
      title="models"
      onClose={props.onClose}
      footer="Enter to select · Esc to close"
      search={{ value: query, onChange: setQuery, placeholder: "search models" }}
    >
      <Row marker="↻" label="Fetch models from this endpoint" onClick={props.onDiscover} />
      <Divider />
      {filtered.map((model) => (
        <Row
          key={model}
          marker={model === props.current ? "✓" : " "}
          label={model}
          mono
          onClick={() => props.onSet(model)}
        />
      ))}
      {filtered.length === 0 ? <Row label="no matches" /> : null}
    </Panel>
  );
}

/** `/thinking` — reasoning effort on the active provider. */
export function ThinkingPanel(props: {
  current?: string;
  onSet: (effort: "low" | "medium" | "high" | null) => void;
  onClose: () => void;
}) {
  const options: { label: string; value: "low" | "medium" | "high" | null }[] = [
    { label: "default (provider)", value: null },
    { label: "low", value: "low" },
    { label: "medium", value: "medium" },
    { label: "high", value: "high" },
  ];
  return (
    <Panel title="reasoning effort" onClose={props.onClose} footer="Enter to select · Esc to close">
      {options.map((option) => (
        <Row
          key={option.label}
          marker={(props.current ?? null) === option.value ? "✓" : " "}
          label={option.label}
          onClick={() => props.onSet(option.value)}
        />
      ))}
      <Divider />
      <Row label="Only some transports and models accept an effort." />
    </Panel>
  );
}

/** `/session` — resume a saved conversation. */
export function SessionPanel(props: {
  sessions: SessionSummary[];
  onLoad: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = props.sessions.filter((session) => session.id.toLowerCase().includes(query.toLowerCase()));
  return (
    <Panel
      title="sessions"
      onClose={props.onClose}
      footer="Enter to resume · Esc to close"
      search={{ value: query, onChange: setQuery, placeholder: "search sessions" }}
    >
      <Row marker="+" label="Start a new conversation" onClick={props.onNew} />
      <Divider />
      {filtered.length === 0 ? <Row label="no saved sessions" /> : null}
      {filtered.map((session) => (
        <Row
          key={session.id}
          label={session.id}
          detail={`${session.messageCount} message${session.messageCount === 1 ? "" : "s"}${session.model ? ` · ${session.model}` : ""}`}
          mono
          onClick={() => props.onLoad(session.id)}
        />
      ))}
    </Panel>
  );
}

/**
 * `/usage` — tokens and turns, from the local log.
 *
 * Two numbers and a breakdown, which is all this panel is. It used to be a row
 * of tabs, three dividers and a sentence — the same list rows as a picker, used
 * for something that is not a list of choices, so nothing read as a figure. The
 * period is a tab strip at the top, the totals are figures, and each model gets a
 * share of the widest one: the question "where did my tokens go" is a proportion,
 * and a proportion is a bar.
 */
export function UsagePanel(props: {
  usage: UsageSnapshot;
  onPeriod: (period: "day" | "week" | "month" | "all") => void;
  onClose: () => void;
}) {
  const periods: { key: "day" | "week" | "month" | "all"; label: string }[] = [
    { key: "day", label: "today" },
    { key: "week", label: "week" },
    { key: "month", label: "month" },
    { key: "all", label: "all" },
  ];
  const widest = Math.max(...props.usage.byModel.map((model) => model.tokens), 1);
  return (
    <Panel title="usage" onClose={props.onClose} footer="Esc to close">
      <div className="usage-head">
        <div className="usage-tabs" role="tablist" aria-label="Period">
          {periods.map((period) => (
            <button
              type="button"
              key={period.key}
              role="tab"
              aria-selected={props.usage.period === period.key}
              className={`usage-tab ${props.usage.period === period.key ? "active" : ""}`}
              onClick={() => props.onPeriod(period.key)}
            >
              {period.label}
            </button>
          ))}
        </div>
        <div className="usage-figures">
          <div className="usage-figure">
            <span className="usage-value">{formatTokens(props.usage.tokens)}</span>
            <span className="usage-label">tokens</span>
          </div>
          <div className="usage-figure">
            <span className="usage-value">{props.usage.turns}</span>
            <span className="usage-label">{props.usage.turns === 1 ? "turn" : "turns"}</span>
          </div>
        </div>
      </div>
      <div className="usage-list">
        <div className="usage-list-title">by model</div>
        {props.usage.byModel.length === 0 ? <div className="usage-empty">no usage recorded</div> : null}
        {props.usage.byModel.map((model) => (
          <div className="usage-row" key={model.model}>
            <span className="usage-model">{model.model}</span>
            <span className="usage-bar" aria-hidden="true">
              <span className="usage-bar-fill" style={{ width: `${Math.max(2, (model.tokens / widest) * 100)}%` }} />
            </span>
            <span className="usage-tokens">{formatTokens(model.tokens)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** `/mcp` — the MCP servers this host knows about. */
export function McpPanel(props: { status: McpStatus; onClose: () => void }) {
  return (
    <Panel title="MCP servers" onClose={props.onClose} footer="Esc to close">
      {props.status.configured === 0 ? (
        <>
          <Row label="No MCP servers configured." />
          <Row label="The desktop app hosts no MCP servers yet." />
        </>
      ) : (
        props.status.servers.map((server) => <Row key={server} label={server} />)
      )}
    </Panel>
  );
}

/** A one-line result banner, for a provider test or a failed call. */
export function NoticeBar({ notice, onDismiss }: { notice: { tone: "info" | "warn" | "error"; text: string }; onDismiss: () => void }) {
  return (
    <div className={`notice ${notice.tone}`} onClick={onDismiss} role="status">
      {notice.text}
    </div>
  );
}
