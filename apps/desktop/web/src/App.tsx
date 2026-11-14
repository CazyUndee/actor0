/* eslint-disable react/no-array-index-key -- The transcript is append-only: entries are added, never reordered or removed, so an entry's position is its identity. */
import type { UIEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessEvent } from "@actor0/harness";
import { AgentClient, type ConnectionState } from "./client";
import {
  applyEvent,
  entriesFromMessages,
  initialConversation,
  stateFace,
  withNotice,
  withUserInput,
  FACE_CHAR,
  type ConversationState,
} from "./conversation";
import { mascotDataUri, needsCustomControls, platform, setFavicon } from "./mascot";
import { SPINNER_FRAMES } from "./theme";
import { parseSlash } from "./slash";
import type { AgentInfo, ConfigSnapshot, McpStatus, ProviderKind, SessionSummary, UsageSnapshot } from "./protocol";
import { Composer } from "./components/Composer";
import { EntryView } from "./components/Entry";
import { McpPanel, ModelPanel, NoticeBar, ProviderPanel, SessionPanel, ThinkingPanel, UsagePanel } from "./components/Panels";

/**
 * The app.
 *
 * All of the interesting behaviour lives elsewhere — the reducer in
 * `conversation.ts`, the parser in `markdown.ts`, the commands in `slash.ts` —
 * and this file is the wiring: connect, route notifications into the reducer,
 * dispatch commands, and draw. Keeping it that way is what makes the streaming
 * contract testable without a browser, which matters because the things that go
 * wrong in a streaming UI (a retry that leaves the old text on screen, a tool
 * result that lands twice) are invisible in a screenshot and obvious in a test.
 */

type Mode = "chat" | "provider" | "model" | "thinking" | "session" | "usage" | "mcp";

export function App() {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [conversation, setConversation] = useState<ConversationState>(initialConversation);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [kinds, setKinds] = useState<ProviderKind[]>([]);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const clientRef = useRef<AgentClient | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const reasoningStartedAtRef = useRef<number | null>(null);
  const turnStartedAtRef = useRef<number | null>(null);

  const plat = useMemo(() => platform(), []);
  const showWindowControls = useMemo(() => needsCustomControls(), []);
  const [maximized, setMaximized] = useState(false);

  const minimizeWindow = useCallback(() => { void window.Neutralino?.window?.minimize?.(); }, []);
  const toggleMaximizeWindow = useCallback(async () => {
    const w = window.Neutralino?.window;
    if (!w?.isMaximized || !w.maximize || !w.unmaximize) return;
    const isMax = await w.isMaximized();
    if (isMax) await w.unmaximize(); else await w.maximize();
    setMaximized(!isMax);
  }, []);
  const closeWindow = useCallback(() => {
    const app = window.Neutralino?.app;
    if (app?.exit) { void app.exit(); return; }
    void window.Neutralino?.window?.close?.();
  }, []);

  // --- the client ----------------------------------------------------------

  const refreshConfig = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      setSnapshot(await client.call("config.get"));
    } catch (error) {
      setNotice({ tone: "error", text: String((error as Error).message) });
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      setSessions(await client.call("session.list"));
    } catch {
      /* a session list that cannot be read is not worth a banner */
    }
  }, []);

  useEffect(() => {
    const client = new AgentClient({
      onState: setConnection,
      onNotification: (notification) => {
        switch (notification.type) {
          case "turn.started": {
            setBusy(true);
            setBlocked(false);
            turnStartedAtRef.current = Date.now();
            setElapsed(0);
            return;
          }
          case "turn.event": {
            setConversation((state) => applyEvent(state, notification.event as HarnessEvent, {
              nowMs: Date.now(),
              reasoningStartedAtMs: reasoningStartedAtRef.current,
            }));
            return;
          }
          case "turn.finished": {
            setBusy(false);
            setBlocked(notification.result.blocked);
            turnStartedAtRef.current = null;
            reasoningStartedAtRef.current = null;
            void refreshSessions();
            return;
          }
          case "notice": {
            setNotice({ tone: notification.tone, text: notification.text });
            return;
          }
          case "state.changed": {
            void refreshConfig();
            return;
          }
          default:
            return;
        }
      },
    });
    clientRef.current = client;
    void (async () => {
      try {
        await client.connect();
        setAgentInfo(await client.call("agent.hello"));
        setSnapshot(await client.call("config.get"));
        // The sign-in options are data from the agent, which builds them from
        // the presets in @actor0/providers. A hard-coded list here is how a UI
        // comes to offer a flow this build does not implement.
        setKinds(await client.call("provider.kinds"));
        const { messages } = await client.call("conversation.get");
        if (Array.isArray(messages) && messages.length > 0) {
          setConversation({ entries: entriesFromMessages(messages as never), live: initialConversation().live });
        }
      } catch (error) {
        setNotice({ tone: "error", text: `Could not reach the agent: ${(error as Error).message}` });
      }
    })();
    return () => client.close();
  }, [refreshConfig, refreshSessions]);

  // The reasoning timer: started when reasoning begins streaming into the live
  // region, cleared when the reducer promotes it to a committed entry. Without
  // it the collapsed block's duration is guesswork.
  useEffect(() => {
    if (conversation.live.reasoning.trim() && reasoningStartedAtRef.current === null) {
      reasoningStartedAtRef.current = Date.now();
    }
    if (!conversation.live.reasoning.trim()) reasoningStartedAtRef.current = null;
  }, [conversation.live.reasoning]);

  // Frameless native window: register the title bar as the drag handle.
  // CSS -webkit-app-region works in WebView2; the API is the explicit fallback.
  useEffect(() => {
    if (window.NL_MODE !== "window" && !showWindowControls) return;
    const trySet = () => {
      const w = window.Neutralino?.window;
      if (w?.setDraggableRegion) void w.setDraggableRegion("titlebar").catch(() => {});
    };
    trySet();
    const t = setInterval(trySet, 500);
    const stop = setTimeout(() => clearInterval(t), 5000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [showWindowControls]);

  // Zoom stays off: a desktop app has a fixed layout, and pinch/ctrl+wheel
  // scaling breaks spacing and hit areas. Ctrl+/-/0 and pinch are eaten here;
  // plain scrolling keeps working, and selection-friendly keys are untouched.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const spinner = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 120);
    const clock = setInterval(() => {
      if (turnStartedAtRef.current) setElapsed(Math.floor((Date.now() - turnStartedAtRef.current) / 1000));
    }, 250);
    return () => {
      clearInterval(spinner);
      clearInterval(clock);
    };
  }, [busy]);

  // --- the transcript's scroll ---------------------------------------------
  //
  // The CLI keeps a scroll offset that survives streaming, and a desktop app
  // that snaps to the bottom on every token is not that — it takes the reader's
  // place away the moment they scroll up. So the transcript is *pinned* to the
  // bottom only while the reader is already at the bottom, and a deliberate
  // scroll up unpins it until the reader comes back down. This is the single
  // biggest difference between an app that streams well and one that fights the
  // person reading it.
  const [pinned, setPinned] = useState(true);

  /** Is the viewport at (or within a couple of rows of) the bottom? */
  function nearBottom(node: HTMLElement): boolean {
    return node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
  }

  function onTranscriptScroll(event: UIEvent<HTMLDivElement>): void {
    const node = event.currentTarget;
    setPinned(nearBottom(node));
  }

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node || !pinned) return;
    node.scrollTo({ top: node.scrollHeight });
    // A resize re-lands the bottom badly (the width change re-wraps every
    // entry), so re-pin explicitly rather than trusting the browser.
  }, [conversation, pinned]);

  // --- commands ------------------------------------------------------------

  const runCommand = useCallback(
    async (name: string, argument?: string) => {
      const client = clientRef.current;
      setDraft("");
      if (!client) return;
      try {
        switch (name) {
          case "provider":
          case "setup":
            setMode("provider");
            return;
          case "model":
            if (argument) {
              setSnapshot(await client.call("model.set", { model: argument }));
              return;
            }
            setMode("model");
            return;
          case "thinking":
            if (argument && ["low", "medium", "high"].includes(argument)) {
              setSnapshot(await client.call("thinking.set", { effort: argument as "low" | "medium" | "high" }));
              return;
            }
            setMode("thinking");
            return;
          case "session":
            if (argument) {
              const loaded = await client.call("session.load", { id: argument });
              setConversation((state) => ({ ...state, entries: entriesFromMessages(loaded.messages as never), live: initialConversation().live }));
              setNotice({ tone: "info", text: `resumed ${argument}` });
              return;
            }
            await refreshSessions();
            setMode("session");
            return;
          case "usage":
            setUsage(await client.call("usage.get", { period: "day" }));
            setMode("usage");
            return;
          case "mcp":
            setMcp(await client.call("mcp.status"));
            setMode("mcp");
            return;
          case "clear":
            await client.call("session.new");
            setConversation(initialConversation());
            setNotice({ tone: "info", text: "Started a new conversation." });
            return;
          case "quit":
            setNotice({ tone: "info", text: "Close the window to exit." });
            return;
          case "help":
            // A /help entry in the transcript, not a popup — it is a reference the
            // user goes back to, which is where the CLI keeps it too.
            setConversation((state) => ({ ...state, entries: [...state.entries, { kind: "help" }] }));
            return;
          default:
            setNotice({ tone: "warn", text: `Unknown command: /${name} — try /help` });
        }
      } catch (error) {
        setNotice({ tone: "error", text: (error as Error).message });
      }
    },
    [refreshSessions],
  );

  const submit = useCallback(async () => {
    const client = clientRef.current;
    const text = draft.trim();
    if (!client || !text || busy) return;
    const parsed = parseSlash(text);
    if (parsed) {
      await runCommand(parsed.name, parsed.argument);
      return;
    }
    // The user's own line goes into the transcript immediately: waiting for the
    // first token to echo it makes the app feel like it dropped the message.
    setConversation((state) => withUserInput(state, text));
    setDraft("");
    setNotice(null);
    try {
      await client.call(blocked ? "turn.reply" : "turn.send", { input: text });
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
      setConversation((state) => withNotice(state, "error", (error as Error).message));
    }
  }, [blocked, busy, draft, runCommand]);

  const cancel = useCallback(async () => {
    await clientRef.current?.call("turn.cancel");
  }, []);

  // Escape stops a turn; Ctrl+C copies a selection — the CLI's Ctrl+C, translated.
  //
  // The browser already copies selected text natively, so this handler's job is
  // the *other* Ctrl+C: with nothing selected and a turn running, it cancels —
  // the composer's stop affordance as a keyboard form. When something *is*
  // selected the browser's copy is the right behaviour and this stays out of the
  // way, so Ctrl+C never both copies and interrupts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && mode !== "chat") {
        setMode("chat");
        return;
      }
      if (event.key === "Escape" && busy) {
        void cancel();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && busy) {
        const selected = window.getSelection()?.toString() ?? "";
        if (!selected.trim()) {
          event.preventDefault();
          void cancel();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, cancel, mode]);

  // --- derived -------------------------------------------------------------

  const face = stateFace({
    live: conversation.live,
    lastEntry: conversation.entries[conversation.entries.length - 1],
    ...(conversation.notice ? { notice: conversation.notice } : {}),
    blocked,
    busy,
  });

  // The mascot is the app's identity: keep the favicon in lockstep with its
  // current state so the taskbar/tab reflects what the agent is doing.
  useEffect(() => { setFavicon(face); }, [face]);

  const providerLabel = snapshot?.provider?.model ?? snapshot?.config.model ?? "no provider";
  const providerName = snapshot?.activeProvider ?? "built-in";
  const bridgeLabel = agentInfo ? `${agentInfo.bridge} · ${agentInfo.shell}` : "";

  const statusLine = useMemo(() => {
    if (conversation.live.tool) return `${conversation.live.tool.name} ${conversation.live.tool.target}`;
    if (conversation.live.status) return conversation.live.status;
    if (conversation.live.readingToolOutput) return "reading tool output…";
    if (conversation.live.reasoning) return "thinking…";
    return "working…";
  }, [conversation.live]);

  const version = `v${agentInfo?.version ?? "—"}`;
  const mascotSrc = mascotDataUri(face);

  return (
    <div className="app">
      <div className="shell">
        <div className={`titlebar ${plat === "mac" ? "titlebar-mac" : "titlebar-win"}`} id="titlebar">
          {plat === "mac" ? (
            <>
              {showWindowControls ? (
                <div className="titlebar-controls titlebar-controls-mac">
                  <button type="button" className="wc wc-close" onClick={closeWindow} aria-label="Close" />
                  <button type="button" className="wc wc-min" onClick={minimizeWindow} aria-label="Minimize" />
                  <button type="button" className="wc wc-max" onClick={() => void toggleMaximizeWindow()} aria-label={maximized ? "Restore" : "Maximize"} />
                </div>
              ) : <div className="titlebar-controls-spacer-mac" />}
              <div className="titlebar-drag" />
              <span className="titlebar-version">{version}</span>
              <img className="titlebar-mascot" src={mascotSrc} alt="" aria-hidden="true" />
              <span className="titlebar-name">actor0</span>
              <div className="titlebar-drag" />
            </>
          ) : (
            <>
              <img className="titlebar-mascot" src={mascotSrc} alt="" aria-hidden="true" />
              <span className="titlebar-name">actor0</span>
              <div className="titlebar-drag" />
              <span className="titlebar-version">{version}</span>
              {showWindowControls ? (
                <div className="titlebar-controls titlebar-controls-win">
                  <button type="button" className="wc wc-min-win" onClick={minimizeWindow} aria-label="Minimize" title="Minimize">
                    <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
                  </button>
                  <button type="button" className="wc wc-max-win" onClick={() => void toggleMaximizeWindow()} aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"}>
                    {maximized ? (
                      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3v5h5V3H2zm1 1h3v3H3V4zm2-2h5v5H8V3H5V2z" fill="currentColor"/></svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>
                    )}
                  </button>
                  <button type="button" className="wc wc-close-win" onClick={closeWindow} aria-label="Close" title="Close">
                    <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2"/></svg>
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="bar-row">
          <div className="top-bar">
            <div className="selector-group">
              <button
                type="button"
                className="dropdown-trigger"
                onClick={() => setMode("provider")}
                title={snapshot?.provider?.endpoint ?? "no endpoint configured"}
              >
                <span className="dropdown-value">{providerName}</span>
                <span className="dropdown-caret">▾</span>
              </button>
              <button type="button" className="dropdown-trigger" onClick={() => setMode("model")}>
                <span className="dropdown-value">{providerLabel}</span>
                <span className="dropdown-caret">▾</span>
              </button>
            </div>
            <span className="status-meta" title={bridgeLabel}>
              {agentInfo?.cwd ?? ""}
            </span>
          </div>
          <div className={`mascot face-${face}`} title={face}>
            {FACE_CHAR[face]}
          </div>
        </div>

        {connection !== "open" ? (
          <div className="notices">
            <div className={`notice ${connection === "closed" ? "error" : "info"}`}>
              {connection === "closed" ? "Disconnected from the agent — retrying…" : "Connecting to the agent…"}
            </div>
          </div>
        ) : null}

        {(notice ?? conversation.notice) ? (
          <div className="notices">
            <NoticeBar notice={(notice ?? conversation.notice)!} onDismiss={() => setNotice(null)} />
          </div>
        ) : null}

        {snapshot?.providerError ? (
          <div className="notices">
            <NoticeBar notice={{ tone: "error", text: snapshot.providerError }} onDismiss={() => setMode("provider")} />
          </div>
        ) : null}

        <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
          {conversation.entries.length === 0 && !busy ? (
            <div className="empty-state">
              <div className="empty-title">actor0</div>
              <div className="empty-hint">Ask a question, or type / for commands.</div>
            </div>
          ) : null}
          {conversation.entries.map((entry, index) => (
            <EntryView entry={entry} key={`${entry.kind}-${index}`} />
          ))}
          {busy ? (
            <div className="live">
              <span className="spinner">{SPINNER_FRAMES[frame]}</span>
              <span className="live-status">{statusLine}</span>
              {elapsed > 0 ? <span className="live-time">{elapsed}s</span> : null}
              {conversation.live.retrying ? <span className="live-note">retry {conversation.live.retrying.attempt}</span> : null}
            </div>
          ) : null}
          {blocked ? (
            <div className="blocked-banner" role="status">
              <span className="blocked-title">needs you</span>
              <span className="blocked-text">
                {conversation.blocked?.message ?? "The agent stopped and can continue if you reply."}
              </span>
            </div>
          ) : null}
          {conversation.live.reasoning ? (
            <div className="live-reasoning">
              <pre>{conversation.live.reasoning}</pre>
            </div>
          ) : null}
          {conversation.live.text ? (
            <div className="entry assistant">
              <div className="assistant-box streaming">
                <pre className="stream-text">{conversation.live.text}</pre>
              </div>
            </div>
          ) : null}
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onCancel={() => void cancel()}
          busy={busy}
          blocked={blocked}
        />

        {mode === "provider" && snapshot ? (
          <ProviderPanel
            snapshot={snapshot}
            onClose={() => setMode("chat")}
            onActivate={async (name) => {
              setSnapshot(await clientRef.current!.call("provider.activate", { name }));
            }}
            onRemove={async (name) => {
              setSnapshot(await clientRef.current!.call("provider.remove", { name }));
            }}
            onTest={async (name) => {
              const result = await clientRef.current!.call("provider.test", name ? { name } : {});
              setNotice({ tone: result.ok ? "info" : "error", text: result.message });
            }}
            kinds={kinds}
            onSignIn={async (kind) => clientRef.current!.call("provider.signIn", { kind })}
            onDiscoverModels={async (baseUrl, apiKey) => {
              // The agent asks the candidate endpoint directly, so the models
              // offered are the ones it actually has — and a failure here is
              // the add flow's signal to fall back to naming one by hand.
              const found = await clientRef.current!.call("model.discoverFor", { baseUrl, ...(apiKey ? { apiKey } : {}) });
              return found.map((model) => model.id);
            }}
            onAdd={async (entry) => {
              setSnapshot(await clientRef.current!.call("provider.add", { entry }));
              setNotice({ tone: "info", text: `Added ${entry.name ?? entry.baseUrl}` });
            }}
          />
        ) : null}

        {mode === "model" && snapshot ? (
          <ModelPanel
            models={snapshot.models}
            current={snapshot.provider?.model ?? snapshot.config.model}
            onClose={() => setMode("chat")}
            onSet={async (model) => {
              setSnapshot(await clientRef.current!.call("model.set", { model }));
              setMode("chat");
            }}
            onDiscover={async () => {
              const found = await clientRef.current!.call("model.discover");
              await refreshConfig();
              setNotice({
                tone: found.length > 0 ? "info" : "warn",
                text: found.length > 0 ? `Found ${found.length} model${found.length === 1 ? "" : "s"}.` : "The endpoint listed no models.",
              });
            }}
          />
        ) : null}

        {mode === "thinking" ? (
          <ThinkingPanel
            current={snapshot?.provider?.reasoningEffort}
            onClose={() => setMode("chat")}
            onSet={async (effort) => {
              setSnapshot(await clientRef.current!.call("thinking.set", { effort }));
              setMode("chat");
            }}
          />
        ) : null}

        {mode === "session" ? (
          <SessionPanel
            sessions={sessions}
            onClose={() => setMode("chat")}
            onNew={async () => {
              await clientRef.current!.call("session.new");
              setConversation(initialConversation());
              setMode("chat");
            }}
            onLoad={async (id) => {
              const loaded = await clientRef.current!.call("session.load", { id });
              setConversation((state) => ({ ...state, entries: entriesFromMessages(loaded.messages as never), live: initialConversation().live }));
              setMode("chat");
              setNotice({ tone: "info", text: `resumed ${id}` });
            }}
          />
        ) : null}

        {mode === "usage" && usage ? (
          <UsagePanel
            usage={usage}
            onClose={() => setMode("chat")}
            onPeriod={async (period) => {
              setUsage(await clientRef.current!.call("usage.get", { period }));
            }}
          />
        ) : null}

        {mode === "mcp" && mcp ? <McpPanel status={mcp} onClose={() => setMode("chat")} /> : null}

      </div>
    </div>
  );
}
