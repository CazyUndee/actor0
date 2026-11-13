import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConfigSnapshot, McpStatus, NamedProvider, SessionSummary, UsageSnapshot } from "../protocol";
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
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "", model: "", apiKey: "" });
  const providers = props.snapshot.providers;

  if (adding) {
    return (
      <Panel title="Add provider" onClose={props.onClose} footer="Enter to add · Esc to go back">
        <div className="panel-form">
          <label className="form-field">
            <span className="form-label">base URL</span>
            <input
              className="form-input"
              value={form.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              autoFocus
              spellCheck={false}
            />
          </label>
          <label className="form-field">
            <span className="form-label">name</span>
            <input
              className="form-input"
              value={form.name}
              placeholder="optional — defaults to the host"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="form-field">
            <span className="form-label">model</span>
            <input
              className="form-input"
              value={form.model}
              placeholder="optional — set it later with /model"
              onChange={(event) => setForm({ ...form, model: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="form-field">
            <span className="form-label">api key</span>
            <input
              className="form-input"
              type="password"
              value={form.apiKey}
              placeholder="stored in config.json, or ${ENV_VAR}"
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              spellCheck={false}
            />
          </label>
          <Divider />
          <Row
            marker="+"
            label="Add this provider"
            onClick={() => {
              if (!form.baseUrl.trim()) return;
              props.onAdd({
                baseUrl: form.baseUrl.trim(),
                ...(form.name.trim() ? { name: form.name.trim() } : {}),
                ...(form.model.trim() ? { model: form.model.trim() } : {}),
                ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
              });
              setAdding(false);
            }}
          />
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Providers" onClose={props.onClose} footer="Enter to switch · Esc to close">
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
      <Divider />
      <Row marker="+" label="Add provider" onClick={() => setAdding(true)} />
      <Divider />
      <Row marker="✓" label="Test the active connection" onClick={() => props.onTest()} />
      {props.snapshot.providers.map((provider) => (
        <Row key={`remove-${provider.name}`} marker="✗" label={`Remove ${provider.name}`} onClick={() => props.onRemove(provider.name)} />
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
      <Divider />
      <Row marker="↻" label="Fetch models from this endpoint" onClick={props.onDiscover} />
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

/** `/usage` — tokens and turns, from the local log. */
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
  return (
    <Panel title="usage" onClose={props.onClose} footer="Esc to close">
      <div className="panel-item static">
        <div className="usage-tabs">
          {periods.map((period) => (
            <button
              type="button"
              key={period.key}
              className={`usage-tab ${props.usage.period === period.key ? "active" : ""}`}
              onClick={() => props.onPeriod(period.key)}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>
      <Divider />
      <Row label={`${formatTokens(props.usage.tokens)} tokens · ${props.usage.turns} turn${props.usage.turns === 1 ? "" : "s"}`} />
      <Divider />
      <Row label="by model" />
      <Divider />
      {props.usage.byModel.length === 0 ? <Row label="no usage recorded" /> : null}
      {props.usage.byModel.map((model) => (
        <Row key={model.model} marker="·" label={model.model} detail={formatTokens(model.tokens)} mono />
      ))}
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
