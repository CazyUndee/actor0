import { useEffect, useMemo, useRef, useState } from "react";
import { SPINNER_FRAMES } from "./theme";

type Mode = "chat" | "slash" | "provider" | "manage" | "model" | "usage";
type TopDropdown = "provider" | "model" | null;

type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; streaming?: boolean }
  | { id: number; kind: "tool"; name: string; target: string; status: "ok" | "error"; output?: string };

type Face = "idle" | "draft" | "thinking" | "happy";

const VERSION = "0.1.1";
const BRANCH = "main";
const FOOTER = "Actor0 is an experimental agent and may make mistakes.";

const PROVIDERS = [{ id: "claude", name: "claude", detail: "Anthropic API - Direct" }];

const SLASH_COMMANDS = [
  { name: "/provider", alias: "/p", desc: "switch, sign in, add or remove" },
  { name: "/setup", alias: "/s", desc: "re-run the setup wizard" },
  { name: "/model", alias: "/m", desc: "switch to a model" },
  { name: "/mcp", alias: "/mc", desc: "manage MCP servers" },
  { name: "/thinking", alias: "/t", desc: "reasoning effort" },
  { name: "/clear", alias: "/c", desc: "start a new conversation" },
  { name: "/session", alias: "/r", desc: "switch to a saved session" },
  { name: "/usage", alias: "/u", desc: "tokens and quota" },
  { name: "/quit", alias: "/q", desc: "exit" },
];

const MODELS = [
  "example-provider/claude-opus-4-6",
  ...Array.from({ length: 20 }, (_, i) => `example-provider/model-${String(i + 1).padStart(2, "0")}-preview`),
];

function initialDemo() {
  const p = new URLSearchParams(window.location.search).get("demo");
  if (p === "draft")
    return { entries: [] as Entry[], draft: "what is in the README?", mode: "chat" as Mode, busy: false, face: "draft" as Face };
  if (p === "streaming")
    return {
      entries: [
        { id: 1, kind: "user", text: "what is in the README?" },
        {
          id: 2,
          kind: "assistant",
          text: "Here is a short answer about the repository and what the",
          streaming: true,
        },
      ] as Entry[],
      draft: "",
      mode: "chat" as Mode,
      busy: true,
      face: "thinking" as Face,
    };
  if (p === "committed")
    return {
      entries: [
        { id: 1, kind: "user", text: "what is in the README?" },
        { id: 2, kind: "assistant", text: "Here is a short answer about the repository and what the CLI does." },
      ] as Entry[],
      draft: "",
      mode: "chat" as Mode,
      busy: false,
      face: "happy" as Face,
    };
  if (p === "provider") return { entries: [] as Entry[], draft: "", mode: "provider" as Mode, busy: false, face: "idle" as Face };
  if (p === "manage") return { entries: [] as Entry[], draft: "", mode: "manage" as Mode, busy: false, face: "idle" as Face };
  if (p === "model") return { entries: [] as Entry[], draft: "", mode: "model" as Mode, busy: false, face: "idle" as Face };
  if (p === "usage") return { entries: [] as Entry[], draft: "", mode: "usage" as Mode, busy: false, face: "idle" as Face };
  return { entries: [] as Entry[], draft: "", mode: "chat" as Mode, busy: false, face: "idle" as Face };
}

export function App() {
  const demo = useMemo(initialDemo, []);
  const [entries, setEntries] = useState<Entry[]>(demo.entries);
  const [draft, setDraft] = useState(demo.draft);
  const [mode, setMode] = useState<Mode>(demo.mode);
  const [slashIndex, setSlashIndex] = useState(0);
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const [busy, setBusy] = useState(demo.busy);
  const [face, setFace] = useState<Face>(demo.face);
  const [spinner, setSpinner] = useState(0);
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "error"; text: string } | null>(null);
  const [selectedProvider, setSelectedProvider] = useState(PROVIDERS[0].id);
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [openDropdown, setOpenDropdown] = useState<TopDropdown>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(Math.max(0, ...demo.entries.map((e) => e.id)) + 1);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSpinner((s) => (s + 1) % SPINNER_FRAMES.length), 150);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [entries, busy]);

  useEffect(() => {
    if (!busy) setFace(draft.trim() ? "draft" : face === "happy" && entries.length > 0 ? "happy" : "idle");
  }, [draft, busy, entries.length, face]);

  useEffect(() => {
    if (!openDropdown) return;
    function onDown(e: MouseEvent) {
      if (topBarRef.current && !topBarRef.current.contains(e.target as Node)) setOpenDropdown(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openDropdown]);

  const currentProvider = PROVIDERS.find((p) => p.id === selectedProvider) ?? PROVIDERS[0];

  const filteredSlash = useMemo(() => {
    const q = draft.startsWith("/") ? draft.slice(1).toLowerCase() : "";
    return SLASH_COMMANDS.filter(
      (c) => c.name.toLowerCase().includes(q) || c.alias.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q),
    );
  }, [draft]);

  const filteredModels = useMemo(() => {
    const q = modelQuery.toLowerCase();
    return MODELS.filter((m) => m.toLowerCase().includes(q));
  }, [modelQuery]);

  function openSlash() {
    setMode("slash");
    setSlashIndex(0);
  }

  function closeOverlay() {
    setMode("chat");
    setModelQuery("");
    inputRef.current?.focus();
  }

  function submitText(text: string) {
    const t = text.trim();
    if (!t) return;
    if (t === "/provider" || t === "/p") {
      setDraft("");
      setMode("provider");
      setProviderIndex(0);
      return;
    }
    if (t === "/model" || t === "/m") {
      setDraft("");
      setMode("model");
      setModelIndex(0);
      setModelQuery("");
      return;
    }
    if (t === "/usage" || t === "/u") {
      setDraft("");
      setMode("usage");
      return;
    }
    if (t === "/clear" || t === "/c") {
      setEntries([]);
      setDraft("");
      setNotice({ tone: "info", text: "Started a new conversation." });
      closeOverlay();
      return;
    }
    if (t === "/quit" || t === "/q") {
      setNotice({ tone: "info", text: "Exit requested (desktop MVP mock)." });
      setDraft("");
      closeOverlay();
      return;
    }
    if (t.startsWith("/") && mode === "chat") {
      const known = ["/provider", "/p", "/model", "/m", "/usage", "/u", "/clear", "/c", "/quit", "/q", "/setup", "/s", "/mcp", "/mc", "/thinking", "/t", "/session", "/r"];
      if (!known.some((k) => t === k)) {
        setNotice({ tone: "warn", text: `Unknown command: ${t}` });
      }
      setDraft("");
      return;
    }

    setEntries((e) => [...e, { id: nextId.current++, kind: "user", text: t }]);
    setDraft("");
    setBusy(true);
    setFace("thinking");
    closeOverlay();

    const answer = "Here is a short answer about the repository and what the CLI does.";
    const words = answer.split(" ");
    let i = 0;
    setEntries((e) => [...e, { id: nextId.current++, kind: "assistant", text: "", streaming: true }]);
    const iv = setInterval(() => {
      i++;
      const partial = words.slice(0, i).join(" ") + (i < words.length ? " " : "");
      setEntries((e) => {
        const copy = [...e];
        const last = copy[copy.length - 1];
        if (last && last.kind === "assistant") copy[copy.length - 1] = { ...last, text: partial, streaming: i < words.length };
        return copy;
      });
      if (i >= words.length) {
        clearInterval(iv);
        setBusy(false);
        setFace("happy");
      }
    }, 45);
  }

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (mode === "slash") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(filteredSlash.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDraft("");
        closeOverlay();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filteredSlash[slashIndex]?.name;
        if (cmd) submitText(cmd);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const cmd = filteredSlash[slashIndex]?.name;
        if (cmd) setDraft(cmd + " ");
        return;
      }
    }
    if (e.key === "Escape") {
      if (openDropdown) {
        e.preventDefault();
        setOpenDropdown(null);
        return;
      }
      if (mode !== "chat") {
        e.preventDefault();
        closeOverlay();
        return;
      }
      if (busy) {
        e.preventDefault();
        setBusy(false);
        setFace("idle");
        setNotice({ tone: "warn", text: "Interrupted." });
        return;
      }
    }
    if (e.key === "Enter" && mode === "chat") {
      e.preventDefault();
      submitText(draft);
    }
  }

  function onDraftChange(v: string) {
    setDraft(v);
    if (v.startsWith("/") && mode === "chat") openSlash();
    if (!v.startsWith("/") && mode === "slash") setMode("chat");
  }

  const faceChar = face === "happy" ? "ᵔᴥᵔ" : face === "thinking" ? "o_o" : "-_-";
  const faceLabel =
    face === "happy" ? "Ready" : face === "thinking" ? "Thinking" : draft.trim() ? "Typing" : "Idle";

  return (
    <div className="app">
      <div className="shell">
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark">actor0</span>
            <span className="brand-version">v{VERSION}</span>
          </div>
          <div className="header-hint">Desktop preview · cronixui</div>
        </header>

        <div className="top-bar" ref={topBarRef}>
          <div className="status-area">
            <div className="selector-group">
              <div className="dropdown">
                <button
                  type="button"
                  className={`dropdown-trigger ${openDropdown === "provider" ? "open" : ""}`}
                  onClick={() => setOpenDropdown(openDropdown === "provider" ? null : "provider")}
                  aria-haspopup="listbox"
                  aria-expanded={openDropdown === "provider"}
                >
                  <span className="dropdown-label">Provider</span>
                  <span className="dropdown-value">{currentProvider.name}</span>
                  <span className="dropdown-caret">▾</span>
                </button>
                {openDropdown === "provider" && (
                  <div className="dropdown-menu" role="listbox" aria-label="Provider">
                    {PROVIDERS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`dropdown-item ${p.id === selectedProvider ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedProvider(p.id);
                          setOpenDropdown(null);
                          setNotice({ tone: "info", text: `Provider set to ${p.name}` });
                        }}
                      >
                        <span className="dropdown-item-main">{p.name}</span>
                        <span className="dropdown-item-detail">{p.detail}</span>
                      </button>
                    ))}
                    <div className="dropdown-divider" />
                    <button
                      type="button"
                      className="dropdown-item action"
                      onClick={() => {
                        setOpenDropdown(null);
                        setNotice({ tone: "info", text: "Add provider (mock)" });
                      }}
                    >
                      <span className="dropdown-item-main">Add provider</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="dropdown">
                <button
                  type="button"
                  className={`dropdown-trigger ${openDropdown === "model" ? "open" : ""}`}
                  onClick={() => setOpenDropdown(openDropdown === "model" ? null : "model")}
                  aria-haspopup="listbox"
                  aria-expanded={openDropdown === "model"}
                >
                  <span className="dropdown-label">Model</span>
                  <span className="dropdown-value">{selectedModel}</span>
                  <span className="dropdown-caret">▾</span>
                </button>
                {openDropdown === "model" && (
                  <div className="dropdown-menu dropdown-menu-wide" role="listbox" aria-label="Model">
                    {MODELS.slice(0, 10).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`dropdown-item ${m === selectedModel ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedModel(m);
                          setOpenDropdown(null);
                          setNotice({ tone: "info", text: `Model set to ${m}` });
                        }}
                      >
                        <span className="dropdown-item-main mono">{m}</span>
                      </button>
                    ))}
                    <div className="dropdown-divider" />
                    <button
                      type="button"
                      className="dropdown-item action"
                      onClick={() => {
                        setOpenDropdown(null);
                        setNotice({ tone: "info", text: "Add model (mock)" });
                      }}
                    >
                      <span className="dropdown-item-main">Add model</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
            <span className="status-meta">⎇ {BRANCH}</span>
          </div>
          <div className="mascot" title={faceLabel} aria-label={`Mascot: ${faceLabel}`}>
            {faceChar}
          </div>
        </div>

        {notice && (
          <div className="notices">
            <div className={`notice ${notice.tone}`}>{notice.text}</div>
          </div>
        )}

        <div className="transcript" ref={transcriptRef}>
          {entries.map((e) => (
            <div key={e.id} className={`entry ${e.kind}`}>
              {e.kind === "user" && <div className="user-bubble">{e.text}</div>}
              {e.kind === "assistant" && <div className="assistant-box">{e.text || (e.streaming ? " " : "")}</div>}
              {e.kind === "tool" && (
                <div className="tool-line">
                  <span className={e.status === "ok" ? "ok" : "err"}>{e.status === "ok" ? "✓" : "✗"}</span>{" "}
                  {e.name} <span className="muted">{e.target}</span>
                </div>
              )}
            </div>
          ))}
          {busy && entries[entries.length - 1]?.kind !== "assistant" && (
            <div className="live">
              <span className="spinner">{SPINNER_FRAMES[spinner]}</span>
              <span>thinking…</span>
            </div>
          )}
        </div>

        <div className="composer-area">
          {mode === "slash" && (
            <div className="slash-popup" role="listbox" aria-label="Commands">
              {filteredSlash.map((c, i) => (
                <div
                  key={c.name}
                  role="option"
                  aria-selected={i === slashIndex}
                  className={`slash-item ${i === slashIndex ? "selected" : ""}`}
                  onMouseEnter={() => setSlashIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    submitText(c.name);
                  }}
                >
                  <span className="name">
                    {c.name} <span className="muted">{c.alias}</span>
                  </span>
                  <span className="desc">{c.desc}</span>
                </div>
              ))}
              {filteredSlash.length === 0 && (
                <div className="slash-item">
                  <span className="desc">No matching commands</span>
                </div>
              )}
            </div>
          )}

          <div className={`composer ${busy ? "busy" : ""}`}>
            <input
              ref={inputRef}
              className="composer-input"
              value={draft}
              placeholder="Ask anything, or type / for commands…"
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onComposerKeyDown}
              spellCheck={false}
              aria-label="Message"
            />
            <button
              type="button"
              className="send-btn"
              onClick={() => submitText(draft)}
              disabled={busy || !draft.trim()}
              title="Send"
            >
              Send
            </button>
          </div>
          <div className="footer">{FOOTER}</div>
        </div>

        {mode === "provider" && (
          <Panel title="Providers" onClose={closeOverlay} footer="Enter to select · Esc to close">
            <PanelItem
              selected={providerIndex === 0}
              marker=" "
              label="claude"
              detail="Anthropic API - Direct"
              onClick={() => setMode("manage")}
              onMouseEnter={() => setProviderIndex(0)}
            />
            <Divider />
            <PanelItem
              selected={providerIndex === 1}
              marker="+"
              label="Add provider"
              detail=""
              onClick={() => setNotice({ tone: "info", text: "Add provider (mock)" })}
              onMouseEnter={() => setProviderIndex(1)}
            />
          </Panel>
        )}

        {mode === "manage" && (
          <Panel title="Manage provider" onClose={() => setMode("provider")} searchValue="claude" footer="Enter to select · Esc to go back">
            <div className="panel-item static">
              <span className="marker muted">↑</span>
              <span className="label muted">1 above</span>
            </div>
            <Divider />
            {["Change model", "Edit provider", "Test connection", "Remove provider"].map((label, i) => (
              <PanelItem key={label} selected={i === 0} marker={i === 0 ? " " : " "} label={label} detail="" />
            ))}
          </Panel>
        )}

        {mode === "model" && (
          <Panel
            title="Models"
            onClose={closeOverlay}
            searchValue={modelQuery}
            onSearch={setModelQuery}
            footer="Enter to select · Esc to close"
          >
            {filteredModels.slice(0, 12).map((m, i) => (
              <PanelItem
                key={m}
                selected={i === modelIndex}
                marker={m === selectedModel ? "✓" : " "}
                label={m}
                labelMono
                detail={m === MODELS[0] ? "claude" : ""}
                onMouseEnter={() => setModelIndex(i)}
                onClick={() => {
                  setSelectedModel(m);
                  setNotice({ tone: "info", text: `Model set to ${m}` });
                  closeOverlay();
                }}
              />
            ))}
            {filteredModels.length === 0 && (
              <div className="panel-item static">
                <span className="label muted">No matches</span>
              </div>
            )}
          </Panel>
        )}

        {mode === "usage" && (
          <Panel title="Usage" onClose={closeOverlay} footer="Esc to close">
            <div className="panel-item static selected">
              <div className="usage-tabs">
                <span className="usage-tab active">Today</span>
                <span className="usage-tab">Week</span>
                <span className="usage-tab">Month</span>
                <span className="usage-tab">All</span>
              </div>
            </div>
            <Divider />
            <div className="panel-item static">
              <div className="usage-row">
                <span className="label">5.0k tokens · 2 turns</span>
              </div>
            </div>
            <Divider />
            <div className="panel-item static">
              <span className="label muted">By model</span>
            </div>
            <Divider />
            <div className="panel-item static">
              <div className="usage-row">
                <span className="label mono">agnes-3.0-flash</span>
                <span className="usage-note">5.0k</span>
              </div>
            </div>
            <div className="panel-item static">
              <div className="usage-row">
                <span className="label mono">example-provider/claude-opus-4-6</span>
                <span className="usage-note">0</span>
              </div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Panel(props: {
  title: string;
  onClose: () => void;
  searchValue?: string;
  onSearch?: (v: string) => void;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="panel" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="panel-header">
          <span className="panel-title">{props.title}</span>
          <button type="button" className="panel-close" onClick={props.onClose}>
            Close
          </button>
        </div>
        {(props.onSearch !== undefined || props.searchValue !== undefined) && (
          <div className="panel-search">
            <div className="search-field">
              <span className="search-icon">⌕</span>
              {props.onSearch ? (
                <input
                  className="search-input"
                  value={props.searchValue ?? ""}
                  onChange={(e) => props.onSearch?.(e.target.value)}
                  placeholder="Search"
                  autoFocus
                />
              ) : (
                <span className="search-input">{props.searchValue ?? ""}</span>
              )}
            </div>
          </div>
        )}
        <div className="panel-body">{props.children}</div>
        {props.footer && <div className="panel-footer">{props.footer}</div>}
      </div>
    </div>
  );
}

function PanelItem(props: {
  selected?: boolean;
  marker: string;
  label: string;
  labelMono?: boolean;
  detail?: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
}) {
  return (
    <button
      type="button"
      className={`panel-item ${props.selected ? "selected" : ""}`}
      onClick={props.onClick}
      onMouseEnter={props.onMouseEnter}
    >
      <span className="marker">{props.marker}</span>
      <span className={`label ${props.labelMono ? "mono" : ""}`}>{props.label}</span>
      {props.detail ? <span className="detail">{props.detail}</span> : null}
    </button>
  );
}

function Divider() {
  return <div className="panel-divider" />;
}
