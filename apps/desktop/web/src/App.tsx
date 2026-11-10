import { useEffect, useMemo, useRef, useState } from "react";
import { SPINNER_FRAMES } from "./theme";

type Mode =
  | "chat"
  | "slash"
  | "provider"
  | "manage"
  | "model"
  | "usage";

type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; streaming?: boolean }
  | { id: number; kind: "tool"; name: string; target: string; status: "ok" | "error"; output?: string };

type Face = "idle" | "draft" | "thinking" | "happy";

const VERSION = "0.1.1";
const MODEL_LABEL = "Anthropic API - Direct   example-provider/claude-opus-4-6   ⎇ main";
const FOOTER = "Actor0 is an experimental agent and may make mistakes.";

const SLASH_COMMANDS = [
  { name: "/provider  /p", desc: "switch, sign in, add or remove" },
  { name: "/setup  /s", desc: "re-run the setup wizard" },
  { name: "/model  /m", desc: "switch to a model" },
  { name: "/mcp  /mc", desc: "manage MCP servers" },
  { name: "/thinking  /t", desc: "reasoning effort" },
  { name: "/clear  /c", desc: "start a new conversation" },
  { name: "/session  /r", desc: "switch to a saved session" },
  { name: "/usage  /u", desc: "tokens and quota" },
  { name: "/quit  /q", desc: "exit" },
];

const MODELS = [
  "example-provider/claude-opus-4-6",
  ...Array.from({ length: 20 }, (_, i) => `example-provider/model-${String(i + 1).padStart(2, "0")}-preview`),
];

function initialDemo() {
  const p = new URLSearchParams(window.location.search).get("demo");
  if (p === "draft") return { entries: [] as Entry[], draft: "what is in the README?", mode: "chat" as Mode, busy: false, face: "idle" as Face };
  if (p === "streaming") return { entries: [{ id: 1, kind: "user", text: "what is in the README?" }, { id: 2, kind: "assistant", text: "Here is a short answer about the repository and what the", streaming: true }] as Entry[], draft: "", mode: "chat" as Mode, busy: true, face: "thinking" as Face };
  if (p === "committed") return { entries: [{ id: 1, kind: "user", text: "what is in the README?" }, { id: 2, kind: "assistant", text: "Here is a short answer about the repository and what the CLI does." }] as Entry[], draft: "", mode: "chat" as Mode, busy: false, face: "happy" as Face };
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
    if (!busy) setFace(draft.trim() ? "draft" : "idle");
  }, [draft, busy]);

  const filteredSlash = useMemo(() => {
    const q = draft.startsWith("/") ? draft.slice(1).toLowerCase() : "";
    return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
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
      setNotice({ tone: "info", text: "started a new conversation" });
      closeOverlay();
      return;
    }
    if (t === "/quit" || t === "/q") {
      setNotice({ tone: "info", text: "exit requested (desktop MVP mock)" });
      setDraft("");
      closeOverlay();
      return;
    }
    if (t.startsWith("/") && mode === "chat") {
      // if typed directly and not handled above, try opening matching panel or show unknown
      const known = ["/provider", "/p", "/model", "/m", "/usage", "/u", "/clear", "/c", "/quit", "/q", "/setup", "/s", "/mcp", "/mc", "/thinking", "/t", "/session", "/r"];
      if (!known.some((k) => t === k)) {
        setNotice({ tone: "warn", text: `unknown command: ${t}` });
      }
      setDraft("");
      return;
    }

    setEntries((e) => [...e, { id: nextId.current++, kind: "user", text: t }]);
    setDraft("");
    setBusy(true);
    setFace("thinking");
    closeOverlay();

    // Mock streaming answer to demonstrate parity
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

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mode === "slash") {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex((i) => Math.min(filteredSlash.length - 1, i + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex((i) => Math.max(0, i - 1)); return; }
      if (e.key === "Escape") { e.preventDefault(); setDraft(""); closeOverlay(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filteredSlash[slashIndex]?.name.split(/\s+/)[0];
        if (cmd) submitText(cmd);
        return;
      }
    }
    if (e.key === "Escape") {
      if (mode !== "chat") { e.preventDefault(); closeOverlay(); return; }
      if (busy) { e.preventDefault(); setBusy(false); setFace("idle"); setNotice({ tone: "warn", text: "interrupted" }); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (mode === "chat") submitText(draft);
    }
  }

  function onDraftChange(v: string) {
    setDraft(v);
    if (v.startsWith("/") && mode === "chat") openSlash();
    if (!v.startsWith("/") && mode === "slash") setMode("chat");
  }

  const faceChar = face === "happy" ? "ᵔᴥᵔ" : face === "thinking" ? "o_o" : "-_-";

  return (
    <div className="app">
      <div className="frame">
        <div className="frame-title">
          <div className="frame-title-left">╭── <span>actor0</span> ──────────────────────────────────────────────────────────</div>
          <div className="frame-title-right"> v{VERSION} ──╮</div>
        </div>
        <div className="frame-inner">
          <div className="top-row">
            <div className="status-box">{MODEL_LABEL}</div>
            <div className="face-box">{faceChar}</div>
          </div>

          {notice && <div className={`notice ${notice.tone}`}>{notice.text}</div>}

          <div className="transcript" ref={transcriptRef}>
            {entries.map((e) => (
              <div key={e.id} className={`entry ${e.kind}`}>
                {e.kind === "user" && <div className="user-bubble">{e.text}</div>}
                {e.kind === "assistant" && (
                  <div className="assistant-box">{e.text || (e.streaming ? " " : "")}</div>
                )}
                {e.kind === "tool" && (
                  <div className="tool-line">
                    <span className={e.status === "ok" ? "ok" : "err"}>{e.status === "ok" ? "✓" : "✗"}</span> {e.name} <span className="muted">{e.target}</span>
                  </div>
                )}
              </div>
            ))}
            {busy && entries[entries.length - 1]?.kind !== "assistant" && (
              <div className="live"><span className="spinner">{SPINNER_FRAMES[spinner]}</span> <span className="status">thinking…</span></div>
            )}
          </div>

          <div className="composer-wrap">
            <div className={`composer ${busy ? "busy" : ""}`}>
              <textarea
                ref={inputRef}
                className="composer-draft"
                value={draft}
                placeholder=""
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={onComposerKeyDown}
                rows={1}
                spellCheck={false}
                style={{ background: "transparent", color: "var(--text)", border: "none", resize: "none", font: "inherit", width: "100%", padding: 0 }}
              />
            </div>
            <div className="footer">{FOOTER}</div>
          </div>
        </div>

        {mode === "slash" && (
          <div className="slash-popup">
            {filteredSlash.map((c, i) => (
              <div key={c.name} className={`slash-item ${i === slashIndex ? "selected" : ""}`} onMouseEnter={() => setSlashIndex(i)} onClick={() => submitText(c.name.split(/\s+/)[0])}>
                <span className="name">{c.name}</span>
                <span className="desc">{c.desc}</span>
              </div>
            ))}
            {filteredSlash.length === 0 && <div className="slash-item"><span className="desc">no matches</span></div>}
          </div>
        )}

        {mode === "provider" && (
          <Panel title="Providers" onClose={closeOverlay} search="" footer="enter select · esc close">
            <PanelItem selected={providerIndex === 0} marker="●" label="claude" detail="Anthropic API - Direct" onClick={() => setMode("manage")} onMouseEnter={() => setProviderIndex(0)} />
            <Divider />
            <PanelItem selected={providerIndex === 1} marker="+" label="Add provider" detail="" onClick={() => setNotice({ tone: "info", text: "add provider (mock)" })} onMouseEnter={() => setProviderIndex(1)} />
          </Panel>
        )}

        {mode === "manage" && (
          <Panel title="Manage provider" onClose={() => setMode("provider")} search="claude" footer="enter select · esc back">
            <div className="panel-item" style={{ color: "var(--dim)" }}>  ↑ 1 above</div>
            <Divider />
            {["Change model", "Edit provider", "Test connection", "Remove provider"].map((label, i) => (
              <PanelItem key={label} selected={i === 0} marker={i === 0 ? "●" : "○"} label={label} detail="" />
            ))}
          </Panel>
        )}

        {mode === "model" && (
          <Panel title="models" onClose={closeOverlay} search={modelQuery} onSearch={setModelQuery} footer="enter select · esc close">
            {filteredModels.slice(0, 12).map((m, i) => (
              <PanelItem key={m} selected={i === modelIndex} marker={m === MODELS[0] ? "✓" : " "} label={m.length > 28 ? m.slice(0, 27) + "…" : m} detail={m === MODELS[0] ? "claude" : ""} onMouseEnter={() => setModelIndex(i)} onClick={() => { setNotice({ tone: "info", text: `model set to ${m}` }); closeOverlay(); }} />
            ))}
            {filteredModels.length === 0 && <div className="panel-item"><span className="desc">no matches</span></div>}
          </Panel>
        )}

        {mode === "usage" && (
          <Panel title="usage" onClose={closeOverlay} search="" footer="esc close">
            <div className="panel-item selected"><span className="key">[ today ]</span><span className="desc">   week      month      all</span></div>
            <Divider />
            <div className="panel-item">5.0k tokens · 2 turns</div>
            <Divider />
            <div className="panel-item" style={{ color: "var(--muted)" }}>by model</div>
            <Divider />
            <div className="panel-item">· agnes-3.0-flash<span style={{ flex: 1 }} /><span className="muted">5.0k</span></div>
            <Divider />
            <div className="panel-item">· example-provider/claude-o…<span style={{ flex: 1 }} /><span className="muted">0</span></div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Panel(props: { title: string; onClose: () => void; search: string; onSearch?: (v: string) => void; footer?: string; children: React.ReactNode }) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="panel">
        <div className="panel-header"><span>{props.title}</span></div>
        <div className="panel-search"><span className="prompt">⌕  search │ </span>
          {props.onSearch ? (
            <input value={props.search} onChange={(e) => props.onSearch?.(e.target.value)} autoFocus style={{ background: "transparent", color: "var(--text)", border: "none", outline: "none", font: "inherit", width: "70%" }} />
          ) : (
            <span>{props.search}</span>
          )}
        </div>
        <div className="panel-body">{props.children}</div>
        {props.footer && <div className="panel-footer">{props.footer}</div>}
      </div>
    </div>
  );
}

function PanelItem(props: { selected?: boolean; marker: string; label: string; detail?: string; onClick?: () => void; onMouseEnter?: () => void }) {
  return (
    <div className={`panel-item ${props.selected ? "selected" : ""}`} onClick={props.onClick} onMouseEnter={props.onMouseEnter}>
      <span className="key">{props.marker}</span>
      <span>{props.label}</span>
      <span style={{ flex: 1 }} />
      {props.detail ? <span className="desc" style={{ textAlign: "right" }}>{props.detail}</span> : null}
    </div>
  );
}

function Divider() { return <div className="panel-divider" />; }
