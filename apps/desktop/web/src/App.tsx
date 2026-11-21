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
  type Entry,
} from "./conversation";
import { mascotDataUri, needsCustomControls, platform, setFavicon } from "./mascot";
import { SPINNER_FRAMES } from "./theme";
import { parseSlash } from "./slash";
import type { AgentInfo, ConfigSnapshot, McpStatus, ProviderKind, SessionSummary, UsageSnapshot } from "./protocol";

/** One in-progress resize gesture (frameless window, edge handles). */
type ResizeState = {
  edge: string;
  startX: number;
  startY: number;
  origin?: { x: number; y: number; width: number; height: number };
};
import { BarDropdown } from "./components/BarDropdown";
import { Composer } from "./components/Composer";
import { SessionDropdown } from "./components/SessionDropdown";
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
/** Which top-bar menu is open. At most one — a panel is separate and modal. */
type BarMenu = "session" | "provider" | "model";

export function App() {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [conversation, setConversation] = useState<ConversationState>(initialConversation);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [openMenu, setOpenMenu] = useState<BarMenu | null>(null);
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
  /** Live drag state for the frameless-window title bar (saved between events). */
  const resizing = useRef<ResizeState | undefined>(undefined);
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

  const [sessionId, setSessionId] = useState<string | null>(null);
  /** Sessions the agent stopped on (needs_user) while this app was open — a dot in the picker. */
  const [stoppedSessions, setStoppedSessions] = useState<Set<string>>(new Set());
  /** The model's title for the current conversation, when it has one. */
  const [sessionTitle, setSessionTitle] = useState<string | undefined>(undefined);

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

  /**
   * Open one top-bar menu, closing the others. The `next` flag is honoured
   * rather than treated as a toggle: a menu that reads it as "flip" opens
   * itself when something above it asked it to close.
   */
  const setBarMenu = useCallback((menu: BarMenu, next: boolean) => {
    setOpenMenu(next ? menu : null);
    // A bar menu and a modal panel never coexist; opening the menu dismisses
    // the panel instead of leaving it behind the overlay.
    if (next) setMode("chat");
  }, []);

  // Opening a panel closes any bar menu. Without this the session picker stayed
  // open behind the overlay and was still there when the panel closed.
  useEffect(() => {
    if (mode !== "chat") setOpenMenu(null);
  }, [mode]);

  // A click outside every top-bar menu closes it. The picker used to close only
  // when an item was chosen, so it sat open over the transcript.
  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".session-dd")) return;
      setOpenMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openMenu]);

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
            // A session the agent stopped on keeps its dot until the user
            // resumes it; a clean turn clears any stale dot.
            if (sessionId !== null) {
              setStoppedSessions((prev) => {
                const next = new Set(prev);
                if (notification.result.blocked) next.add(sessionId);
                else next.delete(sessionId);
                return next;
              });
            }
            void refreshSessions();
            return;
          }
          case "notice": {
            setNotice({ tone: notification.tone, text: notification.text });
            return;
          }
          case "state.changed": {
            void refreshConfig();
            // The agent names the conversation (titleConversation) right after
            // the first turn, so the title may have appeared since the last look.
            void (async () => {
              try {
                const list = await clientRef.current?.call("session.list");
                if (!list || sessionId === null) return;
                setSessionTitle(list.find((s) => s.id === sessionId)?.title);
              } catch { /* the title is cosmetic */ }
            })();
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
        const current = await client.call("conversation.get");
        setSessionId(current.sessionId);
        const currentSummary = (await client.call("session.list")).find((s) => s.id === current.sessionId);
        setSessionTitle(currentSummary?.title);
        setSessions(await client.call("session.list"));
        if (Array.isArray(current.messages) && current.messages.length > 0) {
          showConversation(entriesFromMessages(current.messages as never));
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

  // Frameless native window: dragging the title bar.
  //
  // -webkit-app-region is a no-op under Neutralino's WebView2 host (the window
  // never becomes a system drag region) and setDraggableRegion needs the
  // element to exist before the client connects, which raced. Moving the window
  // from JS on every pointermove also lags: one WebSocket round trip per event,
  // so the window trails the pointer. beginDrag hands the gesture to Windows
  // (ReleaseCapture + WM_SYSCOMMAND/SC_MOVE), which runs the system modal drag
  // loop — it tracks the cursor exactly and at frame rate.
  useEffect(() => {
    if (window.NL_MODE !== "window" && !showWindowControls) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(".titlebar")) return;
      if (target.closest("button, a, input, .titlebar-controls")) return;
      if (e.button !== 0) return;
      const w = window.Neutralino?.window;
      if (!w?.beginDrag) return;
      e.preventDefault();
      void w.beginDrag({ screenX: e.screenX, screenY: e.screenY }).catch(() => undefined);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [showWindowControls]);

  // Frameless window: resize by dragging the edges.
  //
  // The window deliberately has no WS_THICKFRAME: the native thick frame is
  // what painted the 7px light strip around the app (and DWM will not give it
  // up — DWMWA_NCRENDERING_POLICY and DWMWA_BORDER_COLOR both leave it drawn,
  // and DwmExtendFrameIntoClientArea does not move the client rect). Without
  // it the client area is the whole window, so the only border is the CSS
  // hairline. The cost is that the OS resize edges are gone, so they are
  // rebuilt here: invisible strips on each edge/corner that move and size the
  // window through the same Neutralino calls.
  useEffect(() => {
    if (window.NL_MODE !== "window" && !showWindowControls) return;
    const MIN_W = 420;
    const MIN_H = 320;
    const onDown = (edge: string) => (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const state: ResizeState = { edge, startX: e.screenX, startY: e.screenY };
      resizing.current = state;
      void (async () => {
        try {
          const [pos, size] = await Promise.all([
            window.Neutralino?.window?.getPosition?.(),
            window.Neutralino?.window?.getSize?.(),
          ]);
          if (pos && size && resizing.current === state) state.origin = { ...pos, ...size };
        } catch { /* ignore */ }
      })();
    };
    const onMove = (e: PointerEvent) => {
      const r = resizing.current;
      if (!r?.origin) return;
      const w = window.Neutralino?.window;
      if (!w?.move || !w.setSize) return;
      const dx = e.screenX - r.startX;
      const dy = e.screenY - r.startY;
      const o = r.origin;
      let { x, y, width, height } = o;
      if (r.edge.includes("e")) width = Math.max(MIN_W, o.width + dx);
      if (r.edge.includes("s")) height = Math.max(MIN_H, o.height + dy);
      if (r.edge.includes("w")) {
        width = Math.max(MIN_W, o.width - dx);
        x = o.x + (o.width - width);
      }
      if (r.edge.includes("n")) {
        height = Math.max(MIN_H, o.height - dy);
        y = o.y + (o.height - height);
      }
      void (async () => {
        try {
          await w.move?.(x, y);
          await w.setSize?.({ width, height });
        } catch { /* ignore */ }
      })();
    };
    const onUp = (): void => { resizing.current = undefined; };
    const edges = Array.from(document.querySelectorAll<HTMLElement>("[data-resize-edge]"));
    const bindings: Array<{ el: HTMLElement; handler: (e: PointerEvent) => void }> = [];
    for (const el of edges) {
      const handler = onDown(el.dataset.resizeEdge ?? "");
      el.addEventListener("pointerdown", handler as EventListener);
      bindings.push({ el, handler });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      for (const { el, handler } of bindings) el.removeEventListener("pointerdown", handler as EventListener);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
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
    //
    // And land again on the next frame: a freshly mounted transcript reports a
    // scrollHeight that grows once fonts and code blocks have been laid out, so
    // the first scroll lands above the real end. One frame is enough — a second
    // would fight a reader who scrolled during it.
    const frame = requestAnimationFrame(() => {
      const settled = transcriptRef.current;
      if (settled && pinned) settled.scrollTo({ top: settled.scrollHeight });
    });
    return () => cancelAnimationFrame(frame);
  }, [conversation, pinned]);

  /**
   * Show a transcript in place of the current one, at its end.
   *
   * Two things have to happen together, which is why this is one function and
   * not a `setConversation` per call site: the entries are replaced, *and* the
   * viewport is re-pinned. `pinned` is deliberately sticky while a turn streams
   * — a reader who scrolled up must not be dragged back down — but it must not
   * outlive the conversation it was chosen in. Opening a saved session with the
   * previous one's pin still off landed on the *top* of the transcript, which
   * reads as "only the first few tool rows came back".
   */
  const showConversation = useCallback((entries: Entry[]) => {
    setPinned(true);
    setConversation({ entries, live: initialConversation().live });
  }, []);

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
              showConversation(entriesFromMessages(loaded.messages as never));
              try {
                const info = await client.call("agent.hello");
                setAgentInfo(info);
              } catch { /* the banner already reports a dead agent */ }
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
            showConversation([]);
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
      if (event.key === "Escape" && openMenu !== null) {
        setOpenMenu(null);
        return;
      }
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
  }, [busy, cancel, mode, openMenu]);

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

  // The window's own icon (taskbar, hover preview, alt-tab) is the mascot too.
  // The favicon covers the in-page mark; setIcon covers everything the OS shows.
  // Behind window.setIcon is the OS's own big+small icon pair — one call sets
  // both. It needs the client connected, so it retries briefly rather than
  // racing the socket (a silently-dropped call is what left the taskbar on
  // defaults before).
  useEffect(() => {
    if (window.NL_MODE !== "window") return;
    let cancelled = false;
    const trySet = async (attempt = 0): Promise<void> => {
      if (cancelled) return;
      try {
        await window.Neutralino?.window?.setIcon?.("/icon.png");
      } catch {
        if (attempt < 10) setTimeout(() => void trySet(attempt + 1), 500);
        return;
      }
    };
    void trySet();
    return () => { cancelled = true; };
  }, []);

  const providerLabel = snapshot?.provider?.model ?? snapshot?.config?.model ?? "no provider";
  const providerName = snapshot?.activeProvider ?? "built-in";
  const providerOptions = snapshot?.providers ?? [];
  const modelOptions = snapshot?.models ?? [];

  /** Switch the active provider from the bar menu, closing the menu either way. */
  const activateProvider = useCallback(async (name: string) => {
    setOpenMenu(null);
    try {
      setSnapshot(await clientRef.current!.call("provider.activate", { name }));
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    }
  }, []);

  /** Switch the model from the bar menu, closing the menu either way. */
  const chooseModel = useCallback(async (model: string) => {
    setOpenMenu(null);
    try {
      setSnapshot(await clientRef.current!.call("model.set", { model }));
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    }
  }, []);

  const bridgeLabel = agentInfo ? `${agentInfo.bridge} · ${agentInfo.shell}` : "";

  const statusLine = useMemo(() => {
    if (conversation.live.tool) return `${conversation.live.tool.name} ${conversation.live.tool.target}`;
    if (conversation.live.status) return conversation.live.status;
    if (conversation.live.readingToolOutput) return "reading tool output…";
    if (conversation.live.reasoning) return "thinking…";
    return "working…";
  }, [conversation.live]);

  // The TUI shimmers the label exactly when the model is thinking or reading
  // (not for every status line), so the shimmer keys off those two.
  const shimmering = Boolean(conversation.live.reasoning || conversation.live.readingToolOutput);

  // "v0.5.7 (build: 125)" — the version is the user's to order, the build is
  // the number that moves on every commit, and the pair is the only way to tell
  // two packages built from the same version apart. Without it, a user cannot
  // know whether the window they are looking at is the build they were sent.
  const version = `v${agentInfo?.version ?? "—"}${agentInfo?.build === undefined ? "" : ` (build: ${agentInfo.build})`}`;
  const mascotSrc = mascotDataUri(face);

  return (
    <div className="app">
      <div className="shell">
        {showWindowControls ? (
          <div className="resize-edges" aria-hidden="true">
            <span className="resize-edge resize-n" data-resize-edge="n" />
            <span className="resize-edge resize-s" data-resize-edge="s" />
            <span className="resize-edge resize-e" data-resize-edge="e" />
            <span className="resize-edge resize-w" data-resize-edge="w" />
            <span className="resize-edge resize-ne" data-resize-edge="ne" />
            <span className="resize-edge resize-nw" data-resize-edge="nw" />
            <span className="resize-edge resize-se" data-resize-edge="se" />
            <span className="resize-edge resize-sw" data-resize-edge="sw" />
          </div>
        ) : null}
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
              <SessionDropdown
                open={openMenu === "session"}
                onOpenChange={(next) => setBarMenu("session", next)}
                title={sessionTitle}
                sessions={sessions}
                currentId={sessionId}
                busy={busy}
                stopped={stoppedSessions}
                onLoad={(id) => {
                  void (async () => {
                    await clientRef.current?.call("session.load", { id });
                    setSessionId(id);
                    setSessionTitle(sessions.find((s) => s.id === id)?.title);
                    setBlocked(false);
                    showConversation([]);
                    const current = await clientRef.current?.call("conversation.get");
                    if (current && current.messages.length > 0) {
                      showConversation(entriesFromMessages(current.messages as never));
                    }
                    try {
                      const info = await clientRef.current?.call("agent.hello");
                      if (info) setAgentInfo(info);
                    } catch { /* the banner already reports a dead agent */ }
                    void refreshSessions();
                  })().catch((error) => setNotice({ tone: "error", text: String((error as Error).message) }));
                }}
                onNew={(cwd) => {
                  void (async () => {
                    await clientRef.current?.call("session.new", cwd ? { cwd } : {});
                    showConversation([]);
                    setBlocked(false);
                    void refreshSessions();
                    // The agent moved its working directory, so the header's
                    // cwd label has to be re-read rather than left showing the
                    // launch directory.
                    try {
                      const info = await clientRef.current?.call("agent.hello");
                      if (info) setAgentInfo(info);
                    } catch { /* the banner already reports a dead agent */ }
                    const current = await clientRef.current?.call("conversation.get");
                    setSessionId(current?.sessionId ?? null);
                    setSessionTitle(undefined);
                  })().catch((error) => setNotice({ tone: "error", text: String((error as Error).message) }));
                }}
                onDelete={(ids) => {
                  void (async () => {
                    const result = await clientRef.current?.call("session.delete", { ids });
                    if (result?.missing.length) {
                      setNotice({ tone: "warn", text: `${result.missing.length} conversation(s) were already gone.` });
                    }
                    void refreshSessions();
                  })().catch((error) => setNotice({ tone: "error", text: String((error as Error).message) }));
                }}
                onPickFolder={async () => {
                  return window.Neutralino?.os?.showFolderDialog
                    ? await window.Neutralino.os.showFolderDialog("Choose a directory")
                    : undefined;
                }}
              />
              <BarDropdown
                label={providerName}
                title={snapshot?.provider?.endpoint ?? "no endpoint configured"}
                open={openMenu === "provider"}
                onOpenChange={(next) => setBarMenu("provider", next)}
              >
                <div className="session-menu-actions">
                  <button
                    type="button"
                    role="menuitem"
                    className="session-action"
                    onClick={() => {
                      setOpenMenu(null);
                      setMode("provider");
                    }}
                  >
                    manage providers…
                  </button>
                </div>
                {providerOptions.length === 0 ? <div className="session-empty">no saved providers</div> : null}
                {providerOptions.map((provider) => (
                  <button
                    type="button"
                    key={provider.name}
                    role="menuitem"
                    className="session-item"
                    onClick={() => void activateProvider(provider.name)}
                  >
                    <span className="session-item-status">
                      {provider.name === snapshot?.activeProvider ? <span className="tick" title="active">✓</span> : <span className="tick-spacer" />}
                    </span>
                    <span className="session-item-title">{provider.name}</span>
                  </button>
                ))}
              </BarDropdown>
              <BarDropdown
                label={providerLabel}
                title="Model"
                open={openMenu === "model"}
                onOpenChange={(next) => setBarMenu("model", next)}
                align="end"
              >
                <div className="session-menu-actions">
                  <button
                    type="button"
                    role="menuitem"
                    className="session-action"
                    onClick={() => {
                      setOpenMenu(null);
                      setMode("model");
                    }}
                  >
                    search &amp; discover…
                  </button>
                </div>
                {modelOptions.length === 0 ? <div className="session-empty">the endpoint listed no models</div> : null}
                {modelOptions.map((model) => (
                  <button
                    type="button"
                    key={model}
                    role="menuitem"
                    className="session-item"
                    onClick={() => void chooseModel(model)}
                  >
                    <span className="session-item-status">
                      {model === providerLabel ? <span className="tick" title="current">✓</span> : <span className="tick-spacer" />}
                    </span>
                    <span className="session-item-title">{model}</span>
                  </button>
                ))}
              </BarDropdown>
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
              {/* The ChatGPT-style shimmer from the TUI: a soft highlight sweeping
                  across the label while the model is thinking/reading. */}
              <span className={`live-status${shimmering ? " shimmer" : ""}`}>{statusLine}</span>
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
            // Streaming text renders *without* the answer card. A card drawn
            // around text that is still arriving reads as an empty outlined box
      // sitting under the transcript (and then becomes the answer, which is
      // the "weird border that stays until the answer block"). The card is the
      // committed answer's chrome; the live text is just text, like the CLI's
      // live region.
      <div className="stream-text-live">{conversation.live.text}</div>
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
            current={snapshot.provider?.model ?? snapshot.config?.model ?? ""}
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
              showConversation([]);
              setMode("chat");
            }}
            onLoad={async (id) => {
              const loaded = await clientRef.current!.call("session.load", { id });
              showConversation(entriesFromMessages(loaded.messages as never));
              try {
                const info = await clientRef.current?.call("agent.hello");
                if (info) setAgentInfo(info);
              } catch { /* the banner already reports a dead agent */ }
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
