/* eslint-disable react/no-array-index-key -- The transcript is append-only: entries are added, never reordered or removed, so an entry's position is its identity. */
import type { UIEvent, WheelEvent as ReactWheelEvent } from "react";
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
import { EntryView, ReasoningEntry } from "./components/Entry";
import { Markdown } from "./components/Markdown";
import { ContextMenu, type MenuAction } from "./components/ContextMenu";
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
/**
 * Every row the pointer can land on, in one selector.
 *
 * The hover highlight is a radial that grows from the cursor, so the row has to
 * be found from the event target: this list is the contract between the CSS that
 * paints it and the handler that feeds it a position.
 */
const HOVER_ROWS =
  ".session-item, .panel-item, .context-item, .slash-item, .dropdown-trigger, .tool-header, .reasoning-header, .usage-row, .session-action";
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
  const [elapsed, setElapsed] = useState(0);

  const clientRef = useRef<AgentClient | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  /**
   * The right-click menu: where it was opened, and what was under the pointer.
   * `messageIndex` is present only when the entry came out of the stored
   * transcript, which is exactly what "branch from here" needs (see
   * entriesFromMessages).
   */
  const [contextMenu, setContextMenu] = useState<
    | { x: number; y: number; entry?: { messageIndex?: number; kind: string; text?: string } }
    | undefined
  >(undefined);
  /** Live drag state for the frameless-window title bar (saved between events). */
  const resizing = useRef<ResizeState | undefined>(undefined);
  const reasoningStartedAtRef = useRef<number | null>(null);
  const turnStartedAtRef = useRef<number | null>(null);

  const plat = useMemo(() => platform(), []);
  const showWindowControls = useMemo(() => needsCustomControls(), []);
  const [maximized, setMaximized] = useState(false);

  /**
   * The window is borderless, so the OS draws no minimise/restore animation for
   * it: DWM animates a frame that it owns, and there is no frame here. The
   * substitute is a short transform on the shell while the geometry changes,
   * content leaving downward on minimise and settling from 97% on maximise. It
   * is not the system's animation and does not pretend to be; it is the 140ms
   * that keep the window from teleporting.
   */
  const [animating, setAnimating] = useState<"window-out" | "window-in" | null>(null);
  const playWindowAnimation = useCallback((phase: "window-out" | "window-in", then: () => void): void => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      then();
      return;
    }
    setAnimating(phase);
    window.setTimeout(() => {
      // The shell is left at opacity 0 by `window-out` if this never runs, so
      // the clear is a finally: a native call that throws must not leave a
      // blank window behind.
      try {
        then();
      } finally {
        setAnimating(null);
      }
    }, 140);
  }, []);

  const minimizeWindow = useCallback(() => {
    playWindowAnimation("window-out", () => void window.Neutralino?.window?.minimize?.());
  }, [playWindowAnimation]);

  /**
   * Bounds to restore, when this app is the one that maximised.
   *
   * It has to be, because the window is borderless: `window.maximize()` is
   * `ShowWindow(SW_MAXIMIZE)` on a frame that is not a frame, and the result
   * covers the whole monitor, taskbar included. The work area is what a
   * maximised window is supposed to fill, and `screen.avail*` is the one
   * primitive that reports it on every platform — Windows subtracts the
   * taskbar, macOS the menu bar and dock, Linux the panel — so a maximised app
   * fills the space and nothing else.
   */
  const restoreBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const toggleMaximizeWindow = useCallback(async () => {
    const w = window.Neutralino?.window;
    // This Neutralino build has `move(x, y)`, not `setPosition({x, y})`: the
    // typed API follows the docs, the shipped binary follows its own version.
    const place = w?.move
      ? (x: number, y: number) => w.move!(x, y)
      : w?.setPosition
        ? (x: number, y: number) => w.setPosition!({ x, y })
        : undefined;
    if (!place || !w?.setSize) return;
    const dpr = window.devicePixelRatio || 1;
    setAnimating("window-in");

    if (restoreBoundsRef.current) {
      const bounds = restoreBoundsRef.current;
      restoreBoundsRef.current = null;
      await place(bounds.x, bounds.y);
      await w.setSize({ width: bounds.width, height: bounds.height });
      setMaximized(false);
    } else {
      // The OS position/size are in device pixels, the screen metrics in CSS
      // pixels; on a 125% display those are not the same number.
      const before: { x: number; y: number; width: number; height: number } = {
        x: 0,
        y: 0,
        width: Math.round(innerWidth * dpr),
        height: Math.round(innerHeight * dpr),
        ...(await w.getPosition?.()),
        ...(await w.getSize?.()),
      };
      restoreBoundsRef.current = before;
      // `availLeft`/`availTop` are real but absent from this TS lib version.
      const screenWork = window.screen as Screen & { availLeft?: number; availTop?: number };
      await place(
        Math.round((screenWork.availLeft ?? 0) * dpr),
        Math.round((screenWork.availTop ?? 0) * dpr),
      );
      await w.setSize({
        width: Math.round(window.screen.availWidth * dpr),
        height: Math.round(window.screen.availHeight * dpr),
      });
      setMaximized(true);
    }
    window.setTimeout(() => setAnimating(null), 180);
  }, []);

  // The glyph follows the *window*, not the last click on the button. It used to
  // be set only inside the toggle handler, so any other way of maximising
  // (double-click the title bar, the OS menu, a drag to the top edge) left it
  // showing the wrong icon — a single square while the window was maximised,
  // and two when it was not, which reads as an inconsistent button rather than
  // a stale one.
  useEffect(() => {
    const w = window.Neutralino?.window;
    if (!w?.isMaximized) return;
    const sync = (): void => {
      // While this app owns the maximised state, the OS flag is not the truth:
      // our maximise is a position and a size, so `isMaximized()` stays false
      // and trusting it would clear the glyph (and the square corners) one
      // second after they were set.
      if (restoreBoundsRef.current) return;
      void Promise.resolve(w.isMaximized?.())
        .then((value) => setMaximized(Boolean(value)))
        .catch(() => undefined);
    };
    sync();
    const timer = window.setInterval(sync, 1_000);
    window.addEventListener("resize", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", sync);
    };
  }, []);
  const closeWindow = useCallback(() => {
    const app = window.Neutralino?.app;
    playWindowAnimation("window-out", () => {
      if (app?.exit) { void app.exit(); return; }
      void window.Neutralino?.window?.close?.();
    });
  }, [playWindowAnimation]);

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
  //
  // The title bar does not count as outside. A menu is anchored to this window,
  // so moving the window is not a dismissal of it — and the caption's own
  // mousedown begins a native drag, which meant every attempt to move the
  // window while a menu was open closed the menu instead.
  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".session-dd") || target?.closest(".titlebar")) return;
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
    // No spinner: the label itself shimmers while the model works, which is the
    // same signal without a second thing moving. This clock is the turn's
    // elapsed time, which stays.
    const clock = setInterval(() => {
      if (turnStartedAtRef.current) setElapsed(Math.floor((Date.now() - turnStartedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(clock);
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
  /**
   * True while *the app* is moving the viewport.
   *
   * The scroll event cannot tell the reader's scroll from the one that follows
   * our own `scrollTop = scrollHeight`, so it used to treat its own landing as
   * a request to stay pinned — which is how a reader who scrolled up got dragged
   * back down a frame later.
   */
  const selfScroll = useRef(false);

  /** Is the viewport at (or within a couple of rows of) the bottom? */
  function nearBottom(node: HTMLElement): boolean {
    return node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
  }

  function landAtEnd(node: HTMLElement): void {
    selfScroll.current = true;
    node.scrollTo({ top: node.scrollHeight });
    requestAnimationFrame(() => {
      selfScroll.current = false;
    });
  }

  function onTranscriptScroll(event: UIEvent<HTMLDivElement>): void {
    if (selfScroll.current) return;
    setPinned(nearBottom(event.currentTarget));
  }

  /**
   * Scrolling up is a decision, and it is taken on the first notch.
   *
   * Deciding from the scroll event alone waited until the viewport was already
   * more than a couple of rows from the bottom, so a small upward flick was
   * undone by the next token — and a reader watching an agent about to do
   * something destructive could be pulled away from it. The wheel is the
   * earliest signal there is, so it unpins immediately; scrolling back down only
   * re-pins at the bottom, where the reader has caught up.
   */
  function onTranscriptWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (event.deltaY < 0) {
      setPinned(false);
      return;
    }
    if (event.deltaY > 0) setPinned(nearBottom(event.currentTarget));
  }

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node || !pinned) return;
    landAtEnd(node);
    // A resize re-lands the bottom badly (the width change re-wraps every
    // entry), so re-pin explicitly rather than trusting the browser.
    //
    // And land again on the next frame: a freshly mounted transcript reports a
    // scrollHeight that grows once fonts and code blocks have been laid out, so
    // the first scroll lands above the real end. One frame is enough — a second
    // would fight a reader who scrolled during it.
    const frame = requestAnimationFrame(() => {
      const settled = transcriptRef.current;
      if (settled && pinned) landAtEnd(settled);
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

  // The label moves for as long as the turn is live.
  //
  // It used to shimmer only while reasoning or while a tool result was being
  // read, because a braille spinner sitting beside it carried the rest of the
  // motion. With the spinner gone, the first seconds of a turn had nothing
  // moving at all, which reads as a hung app rather than a working one.
  const shimmering = busy;

  // "v0.5.7 (build: 125)" — the version is the user's to order, the build is
  // the number that moves on every commit, and the pair is the only way to tell
  // two packages built from the same version apart. Without it, a user cannot
  // know whether the window they are looking at is the build they were sent.
  /**
   * The right-click menu's contents. What it offers depends on what was
   * right-clicked, because a menu that offers "copy this message" over empty
   * space is a menu that lies about its subject.
   */
  const contextActions = useMemo((): MenuAction[] => {
    const client = clientRef.current;
    const entry = contextMenu?.entry;
    const index = entry?.messageIndex;
    const actions: MenuAction[] = [];

    if (entry?.text) {
      actions.push({
        label: "copy message",
        onSelect: () => void navigator.clipboard.writeText(entry.text ?? "").catch(() => undefined),
      });
    }
    if (entry) {
      // Branching at the first message keeps nothing, which is a new conversation
      // wearing a different name; and an entry with no index is a message that is
      // not in the saved transcript yet, so there is nothing to cut.
      const nothingBefore = index !== undefined && index < 1;
      actions.push({
        label: "branch from here",
        hint:
          index === undefined
            ? "only for a reopened conversation"
            : nothingBefore
              ? "nothing before this message"
              : `keeps the ${index} message${index === 1 ? "" : "s"} before this one`,
        disabled: index === undefined || nothingBefore || busy,
        onSelect: () => {
          if (index === undefined || !client) return;
          void (async () => {
            try {
              const forked = await client.call("session.branch", { fromIndex: index });
              setConversation({ entries: entriesFromMessages(forked.messages as never), live: initialConversation().live });
              setPinned(true);
              setSessionId(forked.id);
              setSessionTitle(undefined);
              setNotice({ tone: "info", text: `branched: ${forked.messages.length} messages kept` });
              void refreshSessions();
              // The fork is a different conversation with the same directory; the
              // header has to read the agent again rather than trust the old view.
              try {
                const info = await client.call("agent.hello");
                setAgentInfo(info);
              } catch {
                /* the banner already reports a dead agent */
              }
            } catch (error) {
              setNotice({ tone: "error", text: (error as Error).message });
            }
          })();
        },
      });
    }
    actions.push({
      label: "copy whole transcript",
      hint: `${conversation.entries.length} entries`,
      separatorBefore: actions.length > 0,
      onSelect: () => {
        const text = conversation.entries
          .map((item) => (item.kind === "user" || item.kind === "assistant" ? item.text : ""))
          .filter(Boolean)
          .join("\n\n");
        void navigator.clipboard.writeText(text).catch(() => undefined);
      },
    });
    actions.push({
      label: "new conversation",
      onSelect: () => void runCommand("clear"),
      disabled: busy,
      separatorBefore: true,
    });
    actions.push({ label: "conversations…", onSelect: () => setMode("session") });
    actions.push({ label: "providers…", onSelect: () => setMode("provider") });
    actions.push({ label: "models…", onSelect: () => setMode("model") });
    return actions;
  }, [contextMenu, conversation.entries, busy, runCommand]);

  /** A right-click anywhere in the app opens our menu instead of the WebView's. */
  const onContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-entry-index]");
    const index = target ? Number.parseInt(target.dataset.entryIndex ?? "", 10) : Number.NaN;
    const found = Number.isFinite(index) ? conversation.entries[index] : undefined;
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      ...(found
        ? {
            entry: {
              ...("messageIndex" in found && found.messageIndex !== undefined ? { messageIndex: found.messageIndex } : {}),
              kind: found.kind,
              ...("text" in found && typeof found.text === "string" ? { text: found.text } : {}),
            },
          }
        : {}),
    });
  }, [conversation.entries]);

  /**
   * The pointer's position inside whatever row it is over.
   *
   * One delegated listener for every list in the app (menus, panels, palettes,
   * tool rows): the highlight is painted as a radial gradient that fills from
   * this point, so each row needs to know where the pointer entered. Doing it per
   * component would be twelve listeners doing the same arithmetic; doing it here
   * is one.
   */
  const hoverRow = useRef<HTMLElement | null>(null);
  const trackPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(HOVER_ROWS);
    if (!row) return;
    if (row !== hoverRow.current) {
      hoverRow.current = row;
      const rect = row.getBoundingClientRect();
      row.style.setProperty("--row-w", `${rect.width}px`);
      row.style.setProperty("--row-h", `${rect.height}px`);
    }
    const rect = row.getBoundingClientRect();
    row.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    row.style.setProperty("--my", `${event.clientY - rect.top}px`);
  }, []);

  const version = `v${agentInfo?.version ?? "—"}${agentInfo?.build === undefined ? "" : ` (build: ${agentInfo.build})`}`;
  const mascotSrc = mascotDataUri(face);

  return (
    <div className="app" onPointerMove={trackPointer}>
      <div className={`shell ${maximized ? "maximized" : ""} ${animating ?? ""}`} onContextMenu={onContextMenu}>
        {/* The new-session blob: a slow crimson swell behind an empty
            conversation, gone the moment there is something to read. */}
        <div className={`new-session-blob ${conversation.entries.length === 0 && !busy ? "visible" : ""}`} aria-hidden="true" />
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
        <div
          className={`titlebar ${plat === "mac" ? "titlebar-mac" : "titlebar-win"}`}
          id="titlebar"
          // A double-click on the caption maximises and restores. The window has
          // no caption, so the gesture has to be put back — and a click on the
          // window controls is that control's own, not the caption's.
          onDoubleClick={(event) => {
            if (!showWindowControls) return;
            if ((event.target as HTMLElement).closest("button, .titlebar-controls")) return;
            void toggleMaximizeWindow();
          }}
        >
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
                    {/* Both states are drawn the same way: two 8px squares with
                        a 1px stroke, the second offset by 2px. The old pair
                        mixed a filled path with an outlined rect, so the button
                        changed weight as well as shape and read as two different
                        icons rather than one control in two states. */}
                    {maximized ? (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                        <rect x="0.5" y="2.5" width="7" height="7" />
                        <path d="M2.5 2.5V0.5h7v7h-2" />
                      </svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                        <rect x="1.5" y="1.5" width="7" height="7" />
                      </svg>
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
                kind="provider"
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
                kind="model"
                title="Model"
                open={openMenu === "model"}
                onOpenChange={(next) => setBarMenu("model", next)}
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

        <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll} onWheel={onTranscriptWheel}>
          {conversation.entries.length === 0 && !busy ? (
            <div className="empty-state">
              <div className="empty-title">actor0</div>
              <div className="empty-hint">Ask a question, or type / for commands.</div>
            </div>
          ) : null}
          {conversation.entries.map((entry, index) => (
            <div className="entry-slot" data-entry-index={index} key={`${entry.kind}-${index}`}>
              <EntryView entry={entry} />
            </div>
          ))}
          {busy ? (
            <div className="live">
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
              {/* The same block finished reasoning becomes: it streams into the
                  collapsed header, and expanding it while it arrives shows the
                  reasoning from the top rather than a second widget. */}
              <ReasoningEntry text={conversation.live.reasoning} live />
            </div>
          ) : null}
          {conversation.live.text ? (
            // The streaming answer *is* the answer: rendered as markdown, in the
            // card it is about to become. It used to be raw text in a bare div,
            // so at commit time it re-laid-out as rendered markdown inside a
            // bordered card that appeared underneath it — the "the card does not
            // render until the turn is done, then it snaps down" half of this.
            // Now the only thing that changes at the end is the border colour.
            <div className="entry assistant">
              <div className="assistant-box streaming">
                <Markdown text={conversation.live.text} />
              </div>
            </div>
          ) : null}
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onCancel={() => void cancel()}
          onCommand={(name) => void runCommand(name)}
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
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextActions}
          onClose={() => setContextMenu(undefined)}
        />
      ) : null}
    </div>
  );
}
