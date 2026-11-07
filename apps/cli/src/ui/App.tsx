import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ModelClient } from "@actor0/harness";
import {
  activeNamedProvider,
  addProvider,
  addModels,
  namedProviders,
  removeProvider,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  withActiveReasoningEffort,
  withContextWindow,
  withModel,
  providerName,
  type CliConfig,
  type NamedProvider,
  type ResolvedProvider,
} from "../config.js";
import {
  applyEvent,
  entriesFromMessages,
  emptyLive,
  initialConversation,
  totalUsage,
  withHelp,
  withNotice,
  withUserInput,
  type ConversationState,
} from "../conversation.js";
import { loadSession, listSessions, newSessionId, saveSession, type StoredSession } from "../session.js";
import { refreshProvider } from "../sign-in.js";
import { recordAudit, recordUsage, formatTokens, contextBar, readUsage, startOfDay, startOfWeek, startOfMonth, usageSince, usageByModel } from "../usage.js";
import { gitBranch } from "../git.js";
import { contextWindowTokens } from "@actor0/harness";
import { parseSlash, matchSlashCommands, type SlashCommand } from "../slash.js";
import { color } from "../theme.js";
import { Screen } from "./term.js";
import { begin, emptySelection, extend, finish, hasSelection, selectedText, spans, type SelectionState } from "./selection.js";
import { copyToClipboard } from "./clipboard.js";
import { parseInput, type InputEvent } from "./input.js";

// The turn machinery is loaded lazily (bundled as turn.mjs) so the boot never
// loads tools.ts, whose module top level spawns a shell to detect it. Loaded
// once, on the first thing that needs a turn or a tool host.
type Turn = typeof import("./turn-entry.js");
let turnMod: Turn | undefined;
const loadTurn = async (): Promise<Turn> => {
  if (!turnMod) turnMod = await import("./turn-entry.js");
  return turnMod;
};
import {
  entryLines,
  liveLines,
  composerRows,
  providerPanelRows,
  managePanelRows,
  panel,
  modelPickerRows,
  thinkingPickerRows,
  usagePanelRows,
  sessionPickerRows,
  slashPopupRows,
  MENU_WIDTH,
  addKindRows,
  addUrlRows,
  addKeyRows,
  addWorkingRows,
  addErrorRows,
  addModelsRows,
  addManualRows,
  stateFace,
  topArea,
  windowRows,
  frameInnerWidth,
  topFrameBorder,
  bottomFrameBorder,
  paint,
  fitWidth,
  highlight,
  segWidth,
  type Face,
  type Seg,
} from "./render.js";
import { PROVIDER_KINDS, type ProviderKind } from "../provider-presets.js";
import { providerLabel } from "../provider-presets.js";
import { fetchModelInfos, fetchClaudePlan } from "../models.js";
import { runOAuthSignIn } from "../sign-in.js";
import { openBrowser } from "../oauth.js";
import type { OAuthTokens } from "../oauth.js";

/**
 * The app, as our own controller.
 *
 * It keeps every bit of the CLI's state and logic — the turn loop, config,
 * sessions, usage, onboarding, the slash commands, and the provider/model/
 * thinking/usage panels — but it does not render through Ink. Ink is the wrong
 * tool for this TUI: a full-height frame makes the terminal scroll on every
 * repaint and re-rendering the whole tree on every streamed token drops
 * characters. So this returns `null` (Ink writes nothing), draws the screen
 * itself through `Screen`, and reads input through its own parser. React is
 * used only for state and effects, which is all it is good for here.
 */

export type AppProps = {
  cwd: string;
  config: CliConfig;
  resumed?: { id: string; createdAt: string; updatedAt: string; messages: ChatMessage[] };
  /** Open the saved-session picker on start (the --resume flag). */
  openSessionPicker?: boolean;
  version?: string;
  transport?: ModelClient;
  /** Our renderer. */
  screen: Screen;
  /** The raw TTY stdin, already in raw mode. */
  stdin: NodeJS.ReadStream;
  /** Called on quit, after the screen is restored. */
  onExit: () => void;
};

type Mode = "chat" | "menu" | "manage" | "add" | "usage" | "model" | "thinking" | "session" | "mcp";

type AddPhase =
  | { kind: "kind" }
  | { kind: "url"; provider: ProviderKind }
  | { kind: "key"; provider: ProviderKind; baseUrl: string }
  | { kind: "working"; label: string; note: string }
  | { kind: "models"; label: string; base: Record<string, unknown>; models: string[]; cursor: number; chosen: Set<string>; windows: Record<string, number>; query: string; existingProvider?: string }
  | { kind: "error"; provider: ProviderKind; message: string; baseUrl?: string };

const THINKING = [
  { label: "default (provider)", effort: undefined },
  { label: "low", effort: "low" },
  { label: "medium", effort: "medium" },
  { label: "high", effort: "high" },
] as const;

const PERIODS: { key: string; label: string; since: (now: Date) => number }[] = [
  { key: "day", label: "today", since: startOfDay },
  { key: "week", label: "week", since: startOfWeek },
  { key: "month", label: "month", since: startOfMonth },
  { key: "all", label: "all", since: () => 0 },
];

function wrap(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

export function App({ cwd, config: initialConfig, resumed, version = "0.0.0", transport, screen, stdin, onExit, openSessionPicker }: AppProps) {
  const [config, setConfig] = useState<CliConfig>(initialConfig);
  const [conversation, setConversation] = useState<ConversationState>(() => resumed?.messages?.length ? { entries: entriesFromMessages(resumed.messages), live: emptyLive() } : initialConversation());
  // The draft is edited on every keystroke, and several keystrokes can land
  // in one React batch before a re-render — so a closure `caret` is stale and
  // insertions happen at the wrong offset, reordering characters (typing
  // "great" came out "rgeat"). Refs are the source of truth during editing,
  // updated synchronously; the mirrored state drives the render.
  const [draft, setDraftState] = useState("");
  const draftRef = useRef("");
  const [caret, setCaretState] = useState(0);
  const caretRef = useRef(0);
  const setDraft = (d: string): void => {
    draftRef.current = d;
    setDraftState(d);
  };
  const setCaret = (c: number): void => {
    caretRef.current = c;
    setCaretState(c);
  };
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  // The slash menu's search input: while the menu is open, typing lands here —
  // the composer keeps just the `/` and the list filters live below it.
  const [slashQuery, setSlashQuery] = useState("");
  const [_mcpQuery, setMcpQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // --resume boots straight into the session picker instead of a chat screen;
  // the saved sessions are loaded once here, not per render.
  const [mode, setMode] = useState<Mode>(openSessionPicker ? "session" : "chat");
  const [onboarding, setOnboarding] = useState(false);
  const [contextTokens, setContextTokens] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  // Momentum scrolling: velocity accumulates from wheel ticks (rows per frame,
  // signed, down = positive) and decays each frame so a fast flick coasts.
  const scrollVelocityRef = useRef(0);
  const lastWheelTimeRef = useRef(0);
  const scrollFrameRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollFrame = () => {
    scrollFrameRef.current = null;
    const velocity = scrollVelocityRef.current;
    if (Math.abs(velocity) < 0.5) {
      scrollVelocityRef.current = 0;
      return;
    }
    const maxOffset = Math.max(0, transcriptCountRef.current - transcriptVisibleBudgetRef.current);
    setScrollOffset((o) => {
      const next = o + velocity;
      const clamped = Math.min(maxOffset, Math.max(0, next));
      // Hitting a bound kills momentum (no bounce).
      if (clamped === maxOffset || clamped === 0) {
        scrollVelocityRef.current = 0;
        return clamped;
      }
      scrollVelocityRef.current = velocity * 0.88; // friction
      return clamped;
    });
    if (Math.abs(scrollVelocityRef.current) > 0.5) {
      scrollFrameRef.current = setTimeout(scrollFrame, 0);
    }
  };
  // The selection lives in terminal coordinates, like the mouse events that
  // set it, and is drawn over the finished grid rather than stored in it.
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const plainRowsRef = useRef<string[]>([]);
  // Full transcript content (committed + live), as plain inner rows and as
  // Seg rows, so a selection can be anchored to text rather than to the screen
  // and copied even when the selected rows are scrolled out of view.
  const transcriptPlainRef = useRef<string[]>([]);
  const transcriptAllSegsRef = useRef<Seg[][]>([]);
  const transcriptWindowStartRef = useRef(0);
  const transcriptStartRowRef = useRef(0); // visible index where transcript begins
  const transcriptCountRef = useRef(0);
  const transcriptVisibleBudgetRef = useRef(0);
  const popupStartRowRef = useRef(0);
  const popupCountRef = useRef(0);
  // Wall-clock ms when the current live reasoning segment began; used for the
  // running timer on the collapsed block and to stamp committed entries.
  const reasoningStartedAtRef = useRef<number | null>(null);
  const turnStartedAtRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  // Offsets of each committed entry within `entryRowList`, so a mouse click can
  // be mapped back to the entry (and its expanded state) it landed on.
  const entryOffsetsRef = useRef<number[]>([]);
  const entryRowListLengthRef = useRef(0);
  // Per-rendered-row item index for the open menu, so a mouse click/hover can
  // be mapped back to the menu item it landed on (-1 = not an item).
  const menuHitMapRef = useRef<number[]>([]);
  // Timestamp of the last wheel event, so a hover report that the terminal
  // emits right after a scroll can't clobber the cursor we just moved.
  const lastWheelAtRef = useRef(0);
  // Last hover pointer position, so a repeated hover report for the same cell
  // (common after a scroll) does not re-apply focus.
  const lastHoverRef = useRef<{ x: number; y: number } | null>(null);
  const slashHitMapRef = useRef<number[]>([]);
  // Inner-row index where the (centered) menu content begins this frame.
  const menuContentStartRowRef = useRef(0);
  const [justFinished, setJustFinished] = useState(false);
  const finishedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Menu cursors and the add-provider phase machine. Every picker shares
  // the same shape: a cursor over its (filtered) items and a search query.
  const [menuIndex, setMenuIndex] = useState(0);
  const [providerQuery, setProviderQuery] = useState("");
  const [expandedProvider, setExpandedProvider] = useState<number | null>(null);
  const [providerActionCursor, setProviderActionCursor] = useState(0);
  const [manageProvider, setManageProvider] = useState<string | null>(null);
  const [manageCursor, setManageCursor] = useState(0);
  const [manageConfirm, setManageConfirm] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Set<number>>(new Set());
  const [liveReasoningExpanded, setLiveReasoningExpanded] = useState(false);
  const [modelCursor, setModelCursor] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const [thinkingCursor, setThinkingCursor] = useState(0);
  const [thinkingQuery, setThinkingQuery] = useState("");
  const [usageIndex, setUsageIndex] = useState(0);
  // The session picker: a snapshot of the saved sessions, the cursor, and the
  // search filter. `filteredSessions` is derived from the query, exactly like
  // the model and provider pickers.
  const [sessionList, setSessionList] = useState<StoredSession[]>(() => openSessionPicker ? listSessions() : []);
  const [sessionCursor, setSessionCursor] = useState(0);
  const [sessionQuery, setSessionQuery] = useState("");
  const [add, setAdd] = useState<AddPhase>({ kind: "kind" });
  const [addKindCursor, setAddKindCursor] = useState(0);
  const [addKindQuery, setAddKindQuery] = useState("");
  const [addKey, setAddKey] = useState("");
  const [addUrl, setAddUrl] = useState("");;
  const [addManual, setAddManual] = useState("");
  const signInAbort = useRef<AbortController | null>(null);

  const messagesRef = useRef<ChatMessage[]>(resumed?.messages ?? []);
  const sessionIdRef = useRef<string>(resumed?.id ?? newSessionId());
  // When the current session was created, so a switch can persist the
  // conversation we are leaving with its own createdAt rather than today's.
  const sessionCreatedAtRef = useRef<string>(resumed?.createdAt ?? new Date().toISOString());
  const abortRef = useRef<AbortController | null>(null);
  const [ctrlCPressed, setCtrlCPressed] = useState(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [composerHint, setComposerHint] = useState<string | undefined>(undefined);
  const [composerHintColor, setComposerHintColor] = useState<string | undefined>(undefined);
  const composerHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashComposerHint = (text: string, ms = 2000, color?: string): void => {
    setComposerHint(text);
    setComposerHintColor(color);
    if (composerHintTimerRef.current) clearTimeout(composerHintTimerRef.current);
    composerHintTimerRef.current = setTimeout(() => { setComposerHint(undefined); setComposerHintColor(undefined); }, ms);
  };
  const liveRef = useRef<ChatMessage[]>(messagesRef.current);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const openedOnboarding = useRef(false);

  const updateLive = (messages: ChatMessage[]): void => {
    liveRef.current = messages;
  };

  // Sub-agents run through the same provider and endpoint as the parent turn
  // (or the injected test transport), so delegation never needs its own
  // credential path. turnMod is loaded by loadTurn before this is called.
  const taskDelegateHost = (activeProvider: ResolvedProvider): ReturnType<Awaited<ReturnType<typeof loadTurn>>["createToolHost"]> =>
    turnMod!.createToolHost({
      cwd,
      taskDelegate: turnMod!.createTaskDelegate({
        provider: activeProvider,
        cwd,
        ...(transport ? { client: transport } : {}),
      }),
    });

  const resolved = useMemo(() => {
    try {
      return { provider: resolveProvider(config), error: undefined } as const;
    } catch (error) {
      return { provider: null, error: (error as Error).message } as const;
    }
  }, [config]);
  const provider = resolved.provider;

  const active = activeNamedProvider(config);
  const endpoint = active ? providerLabel(active) : "not configured";
  const activeModel = active?.model ?? config.model;
  // The models `/model` may offer: the active provider's own list, never the
  // flat one. A name that belongs to another gateway is not a model this one
  // can serve, and offering it is how a request went to an endpoint that had
  // never heard of it. No provider active means the flat list is the endpoint.
  // Global model list across ALL providers (not just the active one). Each
  // entry keeps its provider identity so duplicate model IDs from different
  // providers stay distinct.
  const modelEntries: { model: string; provider: string }[] = [];
  const allNamed = namedProviders(config);
  if (allNamed.length === 0) {
    for (const m of config.models) modelEntries.push({ model: m, provider: "" });
  } else {
    for (const p of allNamed) {
      const ms = p.models?.length ? p.models : p.model ? [p.model] : [];
      for (const m of ms) modelEntries.push({ model: m, provider: p.name });
    }
  }
  const contextWindow = activeModel ? config.contextWindows?.[activeModel] : undefined;
  const { branch, tokensToday } = useMemo(
    () => ({ branch: gitBranch(cwd), tokensToday: usageSince(readUsage(), startOfDay()).tokens }),
    [cwd, contextTokens],
  );
  const context =
    contextTokens > 0
      ? contextWindow && contextTokens <= contextWindow * 4
        ? { text: `${contextBar(contextTokens / contextWindow)} ${Math.min(100, Math.round((contextTokens / contextWindow) * 100))}%` }
        : { text: `${formatTokens(contextTokens)} tokens` }
      : undefined;

  const notice = (tone: "info" | "warn" | "error", text: string): void => {
    setConversation((state) => withNotice(state, tone, text));
  };

  // Onboarding: with nothing configured, open the add flow as a welcome.
  useEffect(() => {
    if (openedOnboarding.current) return;
    if (!provider && /No provider is configured/.test(resolved.error ?? "")) {
      openedOnboarding.current = true;
      setOnboarding(true);
      setMode("add");
      setAdd({ kind: "kind" });
    }
  }, [provider, resolved.error]);

  // Redraw at the new size on resize. The render effect only runs on a state
  // change, and a resize is not one, so without this the old-size grid is left
  // on a resized terminal and everything after it is misaligned.
  const [, forceRedraw] = useState(0);
  useEffect(() => {
    const onResize = (): void => {
      screen.setSize(process.stdout.rows ?? 24, process.stdout.columns ?? 80);
      forceRedraw((n) => n + 1);
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, [screen]);

  // Spinner + elapsed clock.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => {
      setFrame((n) => n + 1);
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, 16);
    return () => clearInterval(id);
  }, [busy]);
  // Mouse capture stays on in all modes so selection works everywhere.

  // Start the reasoning clock when the model begins to stream reasoning, and
  // stop it when the live region is cleared (the turn committed or reset).
  useEffect(() => {
    const reasoning = conversation.live.reasoning.trim();
    if (reasoning && reasoningStartedAtRef.current === null) reasoningStartedAtRef.current = Date.now();
    if (!reasoning && reasoningStartedAtRef.current !== null) reasoningStartedAtRef.current = null;
  }, [conversation.live.reasoning]);

  // Persist the conversation we are leaving, then point the whole app — the
  // harness's live message list, the session id/createdAt, the rendered
  // transcript, and the context-window indicator — at the new session.
  const switchToSession = (target: StoredSession): void => {
    if (messagesRef.current.length > 0) {
      try {
        saveSession({
          id: sessionIdRef.current,
          createdAt: sessionCreatedAtRef.current,
          updatedAt: new Date().toISOString(),
          model: provider?.model ?? config.model,
          messages: liveRef.current,
        });
      } catch {
        notice("warn", "could not save the session you are leaving");
      }
    }
    sessionIdRef.current = target.id;
    sessionCreatedAtRef.current = target.createdAt || new Date().toISOString();
    messagesRef.current = target.messages;
    setConversation(target.messages?.length ? { entries: entriesFromMessages(target.messages), live: emptyLive() } : initialConversation());
    setContextTokens(0);
    setScrollOffset(0);
    setMode("chat");
    notice("info", `switched to session ${target.id}`);
  };

  // Open the session picker: snapshot the saved sessions and enter the mode.
  // Named `enter…` because the `openSessionPicker` prop is the --resume flag.
  const enterSessionPicker = (): void => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      notice("info", "no saved sessions yet");
      return;
    }
    setSessionList(sessions);
    setSessionQuery("");
    // Start the cursor on the session we are currently on, if it is saved.
    const current = sessions.findIndex((s) => s.id === sessionIdRef.current);
    setSessionCursor(current >= 0 ? current : 0);
    setMode("session");
  };

  const runCommand = (command: SlashCommand): void => {
    switch (command.name) {
      case "help":
        setConversation((state) => withHelp(state));
        return;
      case "clear":
        // A new conversation is a new session: fresh id, no messages, and the
        // context-window indicator wiped too — otherwise the header still
        // shows the previous session's context even though the model gets none.
        sessionIdRef.current = newSessionId();
        sessionCreatedAtRef.current = new Date().toISOString();
        messagesRef.current = [];
        setConversation(initialConversation());
        setContextTokens(0);
        setScrollOffset(0);
        notice("info", "started a new conversation");
        return;
      case "model":
        if (command.model) {
          const next = withModel(config, command.model);
          setConfig(next);
          saveConfig(next);
          notice("info", `model set to ${command.model}`);
          return;
        }
        if (modelEntries.length === 0) {
          notice("info", `model is ${config.model || provider?.model || "(none)"} — switch with /model <name>`);
          return;
        }
        setModelCursor(Math.max(0, modelEntries.findIndex((e) => e.model === (provider?.model ?? config.model))));
        setModelQuery("");
        setMode("model");
        return;
      case "provider":
        setMenuIndex(0);
        setProviderQuery("");
        setMode("menu");
        return;
      case "mcp":
        setMenuIndex(0);
        setMcpQuery("");
        setMode("mcp");
        return;
      case "setup":
        setOnboarding(true);
        setAdd({ kind: "kind" });
        setAddKindQuery("");
        setMode("add");
        return;
      case "usage":
        setUsageIndex(0);
        setMode("usage");
        return;
      case "thinking":
        if (command.effort === "low" || command.effort === "medium" || command.effort === "high") {
          const next = withActiveReasoningEffort(config, command.effort);
          setConfig(next);
          saveConfig(next);
          notice("info", `reasoning effort set to ${command.effort}`);
          return;
        }
        setThinkingCursor(Math.max(0, THINKING.findIndex((o) => o.effort === active?.reasoningEffort)));
        setThinkingQuery("");
        setMode("thinking");
        return;
      case "session":
        // /session <id> jumps straight to that saved session; /session opens
        // the picker over every saved session.
        if (command.id) {
          const target = loadSession(command.id);
          if (!target) {
            notice("error", `no saved session with id ${command.id}`);
            return;
          }
          switchToSession(target);
          return;
        }
        enterSessionPicker();
        return;
      case "quit":
        onExit();
        return;
      case "unknown":
        notice("warn", `unknown command ${command.input} — try /help`);
    }
  };

  const submit = (raw: string): void => {
    const input = raw.trim();
    if (!input) return;
    if (busy) {
      notice("warn", "still working — wait for the turn, or press Esc to cancel it");
      return;
    }
    setSlashQuery("");
    const command = parseSlash(input);
    if (command) {
      setDraft("");
      setCaret(0);
      setScrollOffset(0);
      if (finishedTimer.current) clearTimeout(finishedTimer.current);
      finishedTimer.current = null;
      setJustFinished(false);
      runCommand(command);
      return;
    }
    setDraft("");
    setCaret(0);
    setScrollOffset(0);
    if (finishedTimer.current) clearTimeout(finishedTimer.current);
    finishedTimer.current = null;
    setJustFinished(false);
    setConversation((state) => withUserInput(state, input));
    setBusy(true);
    if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current);
    thinkingTimerRef.current = null;
    setShowThinking(false);
    turnStartedAtRef.current = Date.now();
    setLiveReasoningExpanded(false);
    thinkingTimerRef.current = setTimeout(() => {
      setShowThinking(true);
      thinkingTimerRef.current = null;
    }, 200);
    if (!provider) {
      setOnboarding(true);
      setAdd({ kind: "kind" });
      setMode("add");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        // Let the just-committed message and the busy spinner render before the
        // turn's first synchronous work (loading the turn bundle, which spawns a
        // shell) blocks the event loop — so the message appears immediately even
        // on a cold cache rather than after the probe.
        await new Promise((r) => setTimeout(r, 0));
        let activeProvider = provider;
        if (provider.auth === "oauth") {
          const refreshed = await refreshProvider(provider, config).catch(() => undefined);
          if (refreshed) {
            activeProvider = refreshed.provider;
            setConfig(refreshed.config);
            saveConfig(refreshed.config);
          }
        }
        const T = await loadTurn();
        const { result, recovery } = await T.runTurn({
          model: activeProvider,
          ...(transport ? { client: transport } : {}),
          messages: messagesRef.current,
          input,
          toolHost: taskDelegateHost(activeProvider),
          signal: controller.signal,
          cwd,
          ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
          ...(config.maxToolRounds ? { maxToolRounds: config.maxToolRounds } : {}),
          onEvent: (event) =>
            setConversation((state) => {
              const next = applyEvent(state, event, {
                nowMs: Date.now(),
                reasoningStartedAtMs: reasoningStartedAtRef.current,
              });
              if (event.type === "done") {
                setScrollOffset(0);
                const answer = next.entries[next.entries.length - 1];
                if (answer?.kind === "assistant") updateLive([...messagesRef.current, { role: "assistant", content: answer.text }]);
              }
              return next;
            }),
        });
        messagesRef.current = T.forStorage(result.messages);
        updateLive(messagesRef.current);
        if (result.blocked) notice("warn", T.describeStop(conversationRef.current.blocked?.reason));
        if (result.truncated) notice("warn", T.describeTruncation());
        if (recovery) notice("warn", T.describeRecovery(recovery));
        const total = totalUsage(result.usage);
        recordUsage(provider.model, total);
        recordAudit(provider.model, result.audit);
        setContextTokens(total.prompt_tokens);
      } catch (error) {
        const learned = contextWindowTokens(error);
        if (learned !== undefined) {
          const next = withContextWindow(config, provider.model, learned);
          setConfig(next);
          saveConfig(next);
        }
        const recovered = (await loadTurn()).cancelledTurnMessages(error) ?? (await loadTurn()).failedTurnMessages(error);
        if (recovered) {
          messagesRef.current = recovered;
          updateLive(recovered);
        }
        if (controller.signal.aborted) {
          setConversation((state) => {
            const partial = state.live.text;
            const kept: ConversationState = partial.trim() ? { ...state, entries: [...state.entries, { kind: "assistant", text: partial, partial: true }] } : state;
            return withNotice({ ...kept, live: emptyLive() }, "warn", "cancelled — what you see above is all that was kept");
          });
        } else {
          setConversation((state) => {
            const partial = state.live.text;
            const kept: ConversationState = partial.trim() ? { ...state, entries: [...state.entries, { kind: "assistant", text: partial, partial: true }] } : state;
            return withNotice({ ...kept, live: emptyLive() }, "error", (error as Error).message);
          });
        }
      } finally {
        abortRef.current = null;
        if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
        setShowThinking(false);
        turnStartedAtRef.current = null;
        setBusy(false);
        setJustFinished(true);
        if (finishedTimer.current) clearTimeout(finishedTimer.current);
        finishedTimer.current = setTimeout(() => {
          setJustFinished(false);
          finishedTimer.current = null;
        }, 2200);
        try {
          saveSession({
            id: sessionIdRef.current,
            createdAt: sessionCreatedAtRef.current,
            updatedAt: new Date().toISOString(),
            model: provider?.model ?? config.model,
            messages: liveRef.current,
          });
        } catch (error) {
          notice("error", `could not save session: ${(error as Error).message}`);
        }
      }
    })();
  };

  // ---- add-provider flow ----
  const addSignIn = (kind: ProviderKind): void => {
    if (!kind.oauth) return;
    const controller = new AbortController();
    signInAbort.current = controller;
    setAdd({ kind: "working", label: kind.label, note: "opening your browser to authorize…" });
    void runOAuthSignIn(kind.oauth, {
      signal: controller.signal,
      openBrowser: (url) => {
        setAdd({ kind: "working", label: kind.label, note: `authorize in your browser (or open this URL):\n${url}` });
        openBrowser(url);
      },
    })
      .then(async (tokens: OAuthTokens) => {
        const withPlan = kind.transport === "anthropic" && !tokens.plan ? { ...tokens, plan: await fetchClaudePlan(tokens.accessToken).catch(() => undefined) } : tokens;
        addListModels(kind, buildBase(kind, kind.baseUrl, { auth: "oauth", oauth: withPlan }));
      })
      .catch((error: Error) => setAdd({ kind: "error", provider: kind, message: error.message }));
  };

  const addListModels = (kind: ProviderKind, base: Record<string, unknown>): void => {
    setAdd({ kind: "working", label: kind.label, note: "listing models…" });
    void fetchModelInfos(base as never)
      .then((infos) => {
        const windows: Record<string, number> = {};
        for (const info of infos) if (info.contextWindow !== undefined) windows[info.id] = info.contextWindow;
        setAdd({ kind: "models", label: kind.label, base, models: infos.map((i) => i.id), cursor: 0, chosen: new Set(), windows, query: "" });
      })
      .catch((error: Error) => setAdd({ kind: "error", provider: kind, message: error.message, baseUrl: String(base.baseUrl ?? "") }));
  };

  /**
   * Re-discover an already-configured provider's models and let the user pick
   * more to add — the same multi-select as the add flow, but it grows the
   * existing provider instead of registering a new one.
   */
  const manageModels = (name?: string): void => {
    const target = name ? namedProviders(config).find((p) => p.name === name) : activeNamedProvider(config);
    if (!target) {
      notice("warn", "no such provider — switch to one, or add a new one");
      return;
    }
    const label = providerLabel(target);
    setAdd({ kind: "working", label, note: `listing ${label} models…` });
    setMode("add");
    void fetchModelInfos(target as never)
      .then((infos) => {
        const windows: Record<string, number> = {};
        for (const info of infos) if (info.contextWindow !== undefined) windows[info.id] = info.contextWindow;
        setAdd({ kind: "models", label, base: target as never, models: infos.map((i) => i.id), cursor: 0, chosen: new Set(), windows, query: "", existingProvider: target.name });
      })
      .catch((error: Error) => {
        notice("error", `couldn't list ${label} models: ${error.message}`);
        setAdd({ kind: "kind" });
        setMode("menu");
      });
  };

  const addRegister = (chosen: string[]): void => {
    if (add.kind !== "models") return;
    // Managing an already-configured provider: add the chosen models to it
    // rather than registering a new endpoint.
    if (add.existingProvider) {
      const picked = [...new Set(chosen)];
      // Name the provider explicitly: the manage flow can target a provider
      // that is not the active one, and `addModels` must not guess.
      let next = addModels(config, picked, add.windows, add.existingProvider);
      const active = activeNamedProvider(next);
      if (active && !active.model && picked[0]) next = withModel(next, picked[0]!);
      setConfig(next);
      saveConfig(next);
      setMode("menu");
      setOnboarding(false);
      notice("info", picked.length ? `added ${picked.length} model${picked.length === 1 ? "" : "s"} to ${add.existingProvider}` : "no models added");
      return;
    }
    const activeModelName = chosen[0] ?? add.models[add.cursor];
    const remembered = [...new Set([activeModelName, ...chosen].filter((m): m is string => Boolean(m)))];
    // The chosen models belong to the provider being added, not to the flat
    // list — that one is the built-in endpoint's and another gateway's names
    // must not appear in it.
    const providerToAdd: NamedProvider = {
      ...(add.base as object),
      name: providerName(String(add.base.baseUrl ?? "")),
      ...(activeModelName ? { model: activeModelName } : {}),
      ...(remembered.length ? { models: remembered.slice(0, 20) } : {}),
    } as NamedProvider;
    let next = addProvider(config, providerToAdd);
    for (const [model, win] of Object.entries(add.windows)) next = withContextWindow(next, model, win);
    setConfig(next);
    saveConfig(next);
    setMode("chat");
    setOnboarding(false);
    const name = next.activeProvider ?? "provider";
    if (!onboarding) {
      notice("info", `added ${name}${remembered.length ? ` · ${remembered.length} model${remembered.length === 1 ? "" : "s"}` : ""}`);
      return;
    }
    let resolvedProvider: ResolvedProvider;
    try {
      resolvedProvider = resolveProvider(next);
    } catch {
      notice("info", `added ${name} — set a model with /model <name> to start.`);
      return;
    }
    notice("info", `verifying ${name}…`);
    void loadTurn().then((T) => T.verifyProvider(resolvedProvider)).then((result) => {
      if (result.ok) notice("info", `ready — ${name} works. Ask anything, or /provider to manage providers.`);
      else if (result.retriable) notice("warn", `added ${name}, but couldn't verify it (network) — it may still work.`);
      else notice("warn", `added ${name}, but it didn't answer: ${result.message}`);
    });
  };

  // ---- draft editing (the composer input, ours) ----
  const editDraft = (event: InputEvent): boolean => {
    // Read the refs, not the closure state: a batch of keystrokes reuses the
    // closure caret and inserts at the wrong place (the reordering bug).
    const at = caretRef.current;
    const d = draftRef.current;
    if (event.type === "text") {
      setDraft(d.slice(0, at) + event.text + d.slice(at));
      setCaret(at + event.text.length);
      return true;
    }
    if (event.type !== "key") return false;
    switch (event.key) {
      case "backspace":
        if (at > 0) {
          setDraft(d.slice(0, at - 1) + d.slice(at));
          setCaret(at - 1);
        }
        return true;
      case "delete":
        setDraft(d.slice(0, at) + d.slice(at + 1));
        return true;
      case "left":
        setCaret(Math.max(0, at - 1));
        return true;
      case "right":
        setCaret(Math.min(d.length, at + 1));
        return true;
      case "home":
        setCaret(0);
        return true;
      case "end":
        setCaret(d.length);
        return true;
      case "ctrl-u":
        setDraft("");
        setCaret(0);
        return true;
      default:
        return false;
    }
  };

  // The menu filters on its own search input, not on the composer draft:
  // typing goes into the search bar and the fixed "⌕  search" label above the
  // results never changes.
  const slashEngaged = mode === "chat" && /^\/$/.test(draft) && slashDismissed !== draft;
  const slashMatches = slashEngaged ? matchSlashCommands(slashQuery) : [];
  const slashSel = slashMatches.length > 0 ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  // The model picker filters on a search query; an empty query is every model.
  const filteredModels = modelQuery
    ? modelEntries.filter((e) => e.model.toLowerCase().includes(modelQuery.toLowerCase()))
    : modelEntries;
  // Every picker filters the same way — provider, reasoning effort, add-kind.
  const allProviders = namedProviders(config);
  const filteredProviders = providerQuery ? allProviders.filter((p) => `${p.name} ${providerLabel(p)}`.toLowerCase().includes(providerQuery.toLowerCase())) : allProviders;
  const filteredThinking = thinkingQuery ? THINKING.filter((o) => o.label.toLowerCase().includes(thinkingQuery.toLowerCase())) : THINKING;
  const filteredKinds = addKindQuery ? PROVIDER_KINDS.filter((k) => `${k.label} ${k.auth.join(" ")}`.toLowerCase().includes(addKindQuery.toLowerCase())) : PROVIDER_KINDS;
  const filteredSessions = sessionQuery
    ? sessionList.filter((s) => `${s.id} ${s.updatedAt}`.toLowerCase().includes(sessionQuery.toLowerCase()))
    : sessionList;

  // ---- input dispatch ----
  // One listener for the life of the stream; it calls the latest dispatch through
  // a ref. Re-subscribing on every render (no deps) is what let a buffered
  // chunk reach two closures during a turn's many re-renders and submit twice.
  const dispatchRef = useRef<(event: InputEvent) => void>(() => {});
  useEffect(() => {
    let rest = "";
    const onData = (chunk: Buffer | string): void => {
      rest += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parsed = parseInput(rest);
      rest = parsed.rest;
      for (const event of parsed.events) dispatchRef.current(event);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  const dispatch = (event: InputEvent): void => {
    if (event.type === "mouse") return handleMouse(event);
    if (event.type === "text") {
      // Always edit the draft in chat, even while the slash menu is open —
      // the menu filters on the draft, so blocking input here is what made
      // typing "/hel" print nothing and never update the list.
      if (mode === "chat") {
        // While the slash menu is open, input lands in its search input, not
        // the draft — that is what makes the search bar live.
        if (slashEngaged) {
          setSlashQuery((q) => q + event.text);
          setSlashIndex(0);
        } else editDraft(event);
      }
      else if (mode === "add") handleAddText(event.text);
      // In a picker, typing filters the list — the same behaviour everywhere.
      else if (mode === "model") {
        setModelQuery((q) => q + event.text);
        setModelCursor(0);
      } else if (mode === "menu") {
        setProviderQuery((q) => q + event.text);
        setMenuIndex(0);
        setExpandedProvider(null);
      } else if (mode === "thinking") {
        setThinkingQuery((q) => q + event.text);
        setThinkingCursor(0);
      } else if (mode === "session") {
        setSessionQuery((q) => q + event.text);
        setSessionCursor(0);
      } else if (mode === "mcp") {
        setMcpQuery((q) => q + event.text);
        setMenuIndex(0);
      }
      // In any other mode a bare character is a command key (a/d/k/j in a
      // menu), not text to type — routing it here is what made the vim keys
      // and the add/remove letters dead in every menu.
      else for (const ch of event.text) handleKey(ch);
      return;
    }
    handleKey(event.key);
  };
  dispatchRef.current = dispatch;

  const toggleReasoning = (index: number): void => {
    setExpandedReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleMouse = (event: InputEvent & { type: "mouse" }): void => {
    // A left press starts a selection; motion extends it; release copies it.
    // This is what makes native copy-paste unnecessary: mouse capture (which
    // the wheel needs) takes it away, so the app reimplements the gesture.
    // Coordinates arrive 1-based from the terminal.
    const cols = screen.size.cols;
    const innerW = Math.max(8, frameInnerWidth(cols));
    const count = transcriptCountRef.current;

    // Hover events (motion with no button held) must never start a transcript
    // selection — they are only meaningful over menus, handled above.
    if (event.hover && mode === "chat" && !slashEngaged) return;
    // A terminal often re-emits a hover report immediately after a wheel
    // scroll; applying it would snap the menu cursor back to wherever the
    // pointer happens to sit. Ignore hover reports that land within a short
    // window after a wheel event.
    if (event.hover && Date.now() - lastWheelAtRef.current < 150) return;

    // Slash popup (chat mode): clicking an entry selects and runs it.
    if (mode === "chat" && slashEngaged && event.button === "left") {
      const innerIndex = event.y - 2;
      const contentStart = menuContentStartRowRef.current;
      const mapIndex = innerIndex - contentStart;
      const hitMap = slashHitMapRef.current;
      const code = (mapIndex >= 0 && mapIndex < hitMap.length) ? hitMap[mapIndex]! : -1;
      if (code !== -1) {
        setSlashIndex(code);
        if (event.release) {
          const match = slashMatches[code];
          submit(match ? `/${match.name}` : draft);
        }
      }
      return;
    }

    // In any menu, the mouse drives the cursor (hover = focus) and a click
    // activates the item under the pointer — the same outcome as Enter.
    if (mode !== "chat" && event.button === "left") {
      const popupStart = popupStartRowRef.current;
      const popupCount = popupCountRef.current;
      // A drag begins/extends a text selection; the release that ends that
      // drag copies it. A plain click (no drag) must fall through to menu
      // activation below, so the release is only intercepted while a
      // selection is actually in progress (`selection.dragging`).
      if (popupCount > 0 && !event.hover && event.drag) {
        const pt = { col: Math.max(0, Math.min(innerW - 1, event.x - 1 - 2)), row: Math.max(popupStart, Math.min(popupStart + popupCount - 1, event.y - 1)) };
        setSelection((s) => s.anchor ? extend(s, pt, Math.max(1, popupStart + popupCount), innerW) : begin(pt, Math.max(1, popupStart + popupCount), innerW));
        return;
      }
      if (popupCount > 0 && event.release && selection.dragging) {
        setSelection((s) => finish(s));
        const sel = selection;
        if (hasSelection(sel)) {
          const text = selectedText(sel, plainRowsRef.current);
          if (text.trim()) {
            copyToClipboard(text);
            flashComposerHint(`copied ${text.split("\n").length} line${text.split("\n").length === 1 ? "" : "s"}`);
          }
        }
        setSelection(emptySelection());
        return;
      }
      // Dedup repeated hover reports for the same cell so a scroll-induced
      // re-report cannot snap the cursor back to the pointer's resting cell.
      if (event.hover) {
        const prev = lastHoverRef.current;
        if (prev && prev.x === event.x && prev.y === event.y) return;
        lastHoverRef.current = { x: event.x, y: event.y };
      } else {
        lastHoverRef.current = null;
      }
      const innerIndex = event.y - 2; // terminal row 1 is the top border
      const contentStart = menuContentStartRowRef.current;
      const mapIndex = innerIndex - contentStart;
      const hitMap = menuHitMapRef.current;
      const code = (mapIndex >= 0 && mapIndex < hitMap.length) ? hitMap[mapIndex]! : -1;
      if (code !== -1) {
        const isSub = code >= 100000;
        const itemIndex = isSub ? Math.floor((code - 100000) / 10) : code;
        const subIndex = isSub ? (code - 100000) % 10 : -1;
        // Neither hover nor drag may drive focus: any motion report (button held
        // or not) walks the cursor — and in windowed menus drags the view — to
        // wherever the pointer lands, including all the way to the top.
        // Focus changes via keyboard/wheel; a click (release) still activates.
        if (!event.hover && !event.drag) {
        if (mode === "menu") {
          setMenuIndex(itemIndex);
          if (isSub) setProviderActionCursor(subIndex);
          // Hover must mirror keyboard focus without collapsing an expanded
          // provider's action list, so leave expandedProvider untouched.
        } else if (mode === "manage") {
          if (!isSub) setManageCursor(Math.max(0, itemIndex - 1));
        } else if (mode === "model") {
          setModelCursor(itemIndex);
        } else if (mode === "thinking") {
          setThinkingCursor(itemIndex);
        } else if (mode === "add" && add.kind === "kind") {
          setAddKindCursor(itemIndex);
        } else if (mode === "add" && add.kind === "models" && add.models.length > 0) {
          const models = add.query ? add.models.filter((m) => m.toLowerCase().includes(add.query.toLowerCase())) : add.models;
          // itemIndex maps into the filtered? menuRows item index is into filtered list? addModelsRows uses models (filtered) list. filteredModels for app? Actually add uses add.models unfiltered passed to addModelsRows then filtered inside. The hit map item index is into the filtered list passed. Need consistency. Simpler: set cursor to itemIndex clamped.
          setAdd((a) => (a.kind === "models" ? { ...a, cursor: Math.min(itemIndex, Math.max(0, models.length - 1)) } : a));
        }
        }
        // Slash popup hover is handled by the dedicated branch above.
        // Activation on release (click).
        if (event.release) {
          if (mode === "menu") {
            if (itemIndex === filteredProviders.length) {
              // "Add provider" entry.
              setOnboarding(false);
              setAdd({ kind: "kind" });
              setAddKindCursor(0);
              setAddKindQuery("");
              setMode("add");
            } else if (isSub) {
              setProviderActionCursor(subIndex);
              const target = filteredProviders[itemIndex];
              if (target) {
                if (subIndex === 0) {
                  try {
                    const next = setActiveProvider(config, target.name);
                    setConfig(next);
                    saveConfig(next);
                    notice("info", `switched to ${target.name}`);
                  } catch (e) {
                    notice("error", `${target.name}: ${(e as Error).message}`);
                    return;
                  }
                  setExpandedProvider(null);
                  setProviderQuery("");
                  setMode("chat");
                } else {
                  setManageProvider(target.name);
                  setManageCursor(0);
                  setExpandedProvider(null);
                  setMode("manage");
                }
              }
            } else if (itemIndex < filteredProviders.length) {
              if (expandedProvider === itemIndex) {
                // Already expanded: a second click performs the highlighted action.
                const target = filteredProviders[itemIndex];
                if (target && providerActionCursor === 0) {
                  try {
                    const next = setActiveProvider(config, target.name);
                    setConfig(next);
                    saveConfig(next);
                    notice("info", `switched to ${target.name}`);
                  } catch (e) {
                    notice("error", `${target.name}: ${(e as Error).message}`);
                    return;
                  }
                  setExpandedProvider(null);
                  setProviderQuery("");
                  setMode("chat");
                } else if (target) {
                  setManageProvider(target.name);
                  setManageCursor(0);
                  setExpandedProvider(null);
                  setMode("manage");
                }
              } else {
                setExpandedProvider(itemIndex);
                setProviderActionCursor(0);
              }
            }
            setMenuIndex(itemIndex);
          } else if (mode === "manage") {
            const p = namedProviders(config).find((x) => x.name === manageProvider);
            if (p) {
              const idx = Math.max(0, itemIndex - 1);
              setManageCursor(idx);
              if (idx === 0) {
                const next = setActiveProvider(config, p.name);
                setConfig(next);
                saveConfig(next);
                setModelCursor(Math.max(0, next.models.indexOf(p.model ?? next.model)));
                setModelQuery("");
                setMode("model");
              } else if (idx === 1) {
                manageModels(p.name);
              } else if (idx === 2) {
                notice("info", `testing ${providerLabel(p)}…`);
                let resolved: ReturnType<typeof resolveProvider>;
                try {
                  resolved = resolveProvider({ ...config, activeProvider: p.name });
                } catch (error) {
                  notice("error", `${p.name}: ${(error as Error).message}`);
                  return;
                }
                void loadTurn().then((T) => T.verifyProvider(resolved)).then((result) => {
                  if (result.ok) notice("info", `${p.name} works.`);
                  else if (result.retriable) notice("warn", `${p.name}: couldn't reach it (network) — ${result.message}`);
                  else notice("error", `${p.name} didn't answer: ${result.message}`);
                });
              } else if (idx === 3) {
                if (!manageConfirm) setManageConfirm(true);
                else {
                  const next = removeProvider(config, p.name);
                  setConfig(next);
                  saveConfig(next);
                  notice("info", `removed ${p.name}`);
                  setManageConfirm(false);
                  setMode("menu");
                }
              }
            }
          } else if (mode === "model") {
            setModelCursor(itemIndex);
            const entry = filteredModels[itemIndex];
            if (entry) {
              try {
                let next = config;
                if (entry.provider && entry.provider !== active?.name) {
                  next = setActiveProvider(next, entry.provider);
                }
                next = withModel(next, entry.model);
                setConfig(next);
                saveConfig(next);
                notice("info", `model set to ${entry.model}`);
              } catch (e) {
                notice("error", `couldn't switch model: ${(e as Error).message}`);
                return;
              }
            }
            setMode("chat");
          } else if (mode === "thinking") {
            setThinkingCursor(itemIndex);
            const effort = filteredThinking[itemIndex]?.effort;
            if (effort) {
              const next = withActiveReasoningEffort(config, effort);
              setConfig(next);
              saveConfig(next);
              flashComposerHint(`reasoning effort: ${effort}`, 2000, color.info);
            } else {
              flashComposerHint("reasoning effort left to the provider", 2000, color.info);
            }
            setMode("chat");
          } else if (mode === "add" && add.kind === "kind") {
            setAddKindCursor(itemIndex);
            const chosen = filteredKinds[itemIndex];
            if (chosen) {
              setAddKindQuery("");
              if (chosen.auth.length === 1 && chosen.auth[0] === "oauth") addSignIn(chosen);
              else {
                setAddUrl(chosen.baseUrl);
                setAdd({ kind: "url", provider: chosen });
              }
            }
          } else if (mode === "add" && add.kind === "models" && add.models.length > 0) {
            const models = add.query ? add.models.filter((m) => m.toLowerCase().includes(add.query.toLowerCase())) : add.models;
            const model = models[itemIndex];
            if (model) {
              // A click ticks the model in (or out) rather than committing it, so
              // several can be chosen and entered together. Commit on Enter.
              setAdd((a) => {
                if (a.kind !== "models") return a;
                const next = new Set(a.chosen);
                if (next.has(model)) next.delete(model);
                else next.add(model);
                return { ...a, cursor: itemIndex, chosen: next };
              });
            }
          }
        }
      }
      // Wheel handling for menus already in the wheel branch below; but we
      // already returned? No, fall through to wheel check only if not left.
      // For left events over a menu, if it didn't hit an item, do nothing
      // (avoid starting a transcript selection in menu mode).
      return;
    }

    // Convert a terminal cell into content-row space: the selection is anchored
    // to the transcript text, not to screen rows, so it follows the text when
    // the transcript scrolls and can be copied even when scrolled off screen.
    const toContentPoint = (x: number, y: number): { col: number; row: number } => {
      const v = y - 1; // visible row index (top border is row 0)
      const startRow = transcriptStartRowRef.current;
      const winStart = transcriptWindowStartRef.current;
      const budget = Math.max(1, transcriptVisibleBudgetRef.current || 1);
      const visibleCount = Math.min(budget, count);
      let contentRow = 0;
      if (count > 0) {
        if (v < startRow) contentRow = 0;
        else if (v >= startRow + visibleCount) contentRow = count - 1;
        else contentRow = Math.max(0, Math.min(count - 1, winStart + (v - startRow)));
      }
      const innerCol = Math.max(0, Math.min(innerW - 1, x - 1 - 2));
      return { col: innerCol, row: contentRow };
    };
    if (event.button === "left") {
      const pt = toContentPoint(event.x, event.y);
      if (!event.drag && !event.release) {
        // A click on a committed reasoning block toggles it open to the full
        // chain-of-thought, rendered as any other long text with no truncation.
        const offsets = entryOffsetsRef.current;
        const entryLength = entryRowListLengthRef.current;
        let entryIndex: number | undefined;
        for (let i = 0; i < offsets.length; i += 1) {
          const start = offsets[i]!;
          const end = offsets[i + 1] ?? entryLength;
          if (pt.row >= start && pt.row < end) { entryIndex = i; break; }
        }
        if (entryIndex !== undefined && conversation.entries[entryIndex]?.kind === "reasoning") {
          toggleReasoning(entryIndex);
          return;
        }
        // A click on the live reasoning block (the only thing live while the
        // model is still thinking and nothing has been answered yet) expands
        // it to the full chain without truncation.
        if (
          mode === "chat" &&
          pt.row >= entryLength &&
          conversation.live.reasoning.trim() &&
          !conversation.live.text
        ) {
          setLiveReasoningExpanded((v) => !v);
          return;
        }
      }
      if (event.drag) {
        setSelection((s) => extend(s, pt, Math.max(1, count), innerW));
        return;
      }
      if (!event.release) {
        if (count <= 0) return;
        setSelection(() => begin(pt, Math.max(1, count), innerW));
        return;
      }
      let copiedText = "";
      setSelection((s) => {
        const done = finish(s);
        if (count > 0) copiedText = selectedText(done, transcriptPlainRef.current);
        return done;
      });
      if (copiedText.trim()) {
        copyToClipboard(copiedText);
        flashComposerHint(`copied ${copiedText.split("\n").length} line${copiedText.split("\n").length === 1 ? "" : "s"}`);
      }
      return;
    }
    if (event.button !== "wheel-up" && event.button !== "wheel-down") return;
    lastWheelAtRef.current = Date.now();
    const dir = event.button === "wheel-up" ? -1 : 1;
    // In chat the wheel scrolls the transcript; in a menu it moves the cursor
    // through the (windowed, possibly long) list — same direction as the keys.
    if (mode === "chat") {
      // The open slash menu owns the wheel: it moves through the command list.
      if (slashEngaged) return setSlashIndex((i) => wrapSlash(i, slashMatches.length, dir));
      const now = Date.now();
      const dt = Math.max(1, now - (lastWheelTimeRef.current ?? now));
      lastWheelTimeRef.current = now;
      // Faster ticks = more velocity per tick; cap so a single tick can't
      // jerk the transcript too far.
      const timeScale = Math.min(1, 16 / dt);
      scrollVelocityRef.current += dir * 3 * timeScale;
      scrollVelocityRef.current = Math.max(-30, Math.min(30, scrollVelocityRef.current));
      if (!scrollFrameRef.current) scrollFrameRef.current = setTimeout(scrollFrame, 0);
    }
    if (mode === "menu") return setMenuIndex((i) => wrap(i, filteredProviders.length + 2, dir));
    if (mode === "model") return setModelCursor((c) => wrap(c, Math.max(1, filteredModels.length), dir));
    if (mode === "thinking") return setThinkingCursor((c) => wrap(c, Math.max(1, filteredThinking.length), dir));
    if (mode === "session") return setSessionCursor((c) => wrap(c, Math.max(1, filteredSessions.length), dir));
  };

  const handleKey = (key: string): void => {
    // Ctrl+R expands or collapses every committed reasoning block at once.
    if (key === "ctrl-r") {
      const reasoningIndices = conversation.entries
        .map((e, i) => (e.kind === "reasoning" ? i : -1))
        .filter((i): i is number => i >= 0);
      if (reasoningIndices.length === 0) return;
      const allExpanded = reasoningIndices.every((i) => expandedReasoning.has(i));
      setExpandedReasoning((prev) => {
        const next = new Set(prev);
        if (allExpanded) reasoningIndices.forEach((i) => next.delete(i));
        else reasoningIndices.forEach((i) => next.add(i));
        return next;
      });
      return;
    }
    if (key === "ctrl-c") {
      // If there is a selection on screen, Ctrl+C copies it (native-terminal
      // habit) instead of exiting — the selection is the receipt the user just
      // made, and quitting would throw it away.
      if (hasSelection(selection)) {
        const text = selectedText(selection, transcriptPlainRef.current);
        if (text.trim()) {
          copyToClipboard(text);
          flashComposerHint(`copied ${text.split("\n").length} line${text.split("\n").length === 1 ? "" : "s"}`);
        }
        setSelection(emptySelection());
        return;
      }
      if (busy) { abortRef.current?.abort(); return; }
      if (ctrlCPressed) { onExit(); return; }
      setCtrlCPressed(true);
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = setTimeout(() => setCtrlCPressed(false), 2000);
      return;
    }
    if (key === "ctrl-d") {
      onExit();
      return;
    }
    if (mode === "chat") return chatKey(key);
    if (mode === "menu") return menuKey(key);
    if (mode === "manage") return manageKey(key);
    if (mode === "model") return modelKey(key);
    if (mode === "thinking") return thinkingKey(key);
    if (mode === "usage") return usageKey(key);
    if (mode === "session") return sessionKey(key);
    if (mode === "mcp") return mcpKey(key);
    if (mode === "add") return addKeyHandler(key);
  };

  // Move the caret up/down between lines of the draft, clamping the column to
  // the target line's length.
  const moveCaretVertical = (delta: number): void => {
    const draft = draftRef.current;
    const caret = caretRef.current;
    const lines = draft.split("\n");
    const before = draft.slice(0, Math.min(caret, draft.length));
    const line = before.split("\n").length - 1;
    const col = before.length - before.lastIndexOf("\n") - 1;
    const target = line + delta;
    if (target < 0 || target >= lines.length) return;
    let idx = 0;
    for (let i = 0; i < target; i += 1) idx += lines[i]!.length + 1;
    setCaret(idx + Math.min(col, lines[target]!.length));
  };

  const chatKey = (key: string): void => {
    if (slashEngaged) {
      if (key === "up") return setSlashIndex((n) => wrapSlash(n, slashMatches.length, -1));
      if (key === "down") return setSlashIndex((n) => wrapSlash(n, slashMatches.length, 1));
      if (key === "escape") {
        // First escape clears the search; a second closes the menu.
        if (slashQuery) {
          setSlashQuery("");
          setSlashIndex(0);
          return;
        }
        setSlashDismissed(draft);
        return;
      }
      // The draft is just the `/` itself — caret keys have nothing to do here.
      if (key === "left" || key === "right" || key === "home" || key === "end") return;
      if (key === "backspace") {
        if (slashQuery) {
          setSlashQuery((q) => q.slice(0, -1));
          setSlashIndex(0);
          return;
        }
      } else if (key === "delete") {
        if (slashQuery) {
          setSlashQuery("");
          setSlashIndex(0);
          return;
        }
      } else if (key === "ctrl-u") {
        if (slashQuery) {
          setSlashQuery("");
          setSlashIndex(0);
          return;
        }
      }
      if (key === "tab") {
        const match = slashMatches[slashSel];
        if (match) {
          setDraft(`/${match.name}`);
          setCaret(match.name.length + 1);
          setSlashQuery("");
        }
        return;
      }
      if (key === "return") {
        const match = slashMatches[slashSel];
        submit(match ? `/${match.name}` : draft);
        return;
      }
    }
    if (key === "escape") {
      if (busy) abortRef.current?.abort();
      return;
    }
    if (key === "return") return submit(draft);
    // Up/down move the caret between lines of a multi-line draft — never load
    // past prompts, which made editing impossible (the draft was replaced).
    if (key === "up" || key === "down") return moveCaretVertical(key === "up" ? -1 : 1);
    if (key === "pageup") return setScrollOffset((o) => o + 5);
    if (key === "pagedown") return setScrollOffset((o) => Math.max(0, o - 5));
    editDraft({ type: "key", key: key as never });
  };

  const menuKey = (key: string): void => {
    const providers = filteredProviders;
    // The list is the (filtered) providers plus a trailing "Add provider" entry.
    const itemCount = providers.length + 1;
    // Expanded state handling.
    const isExpanded = expandedProvider !== null && expandedProvider === menuIndex && menuIndex < providers.length;
    if (isExpanded) {
      if (key === "up" || key === "k") return setProviderActionCursor((c) => (c <= 0 ? 1 : c - 1));
      if (key === "down" || key === "j") return setProviderActionCursor((c) => (c >= 1 ? 0 : c + 1));
      if (key === "escape") {
        setExpandedProvider(null);
        return;
      }
      if (key === "return") {
        const target = providers[menuIndex];
        if (!target) return;
        if (providerActionCursor === 0) {
          // Use provider
          try {
            const next = setActiveProvider(config, target.name);
            setConfig(next);
            saveConfig(next);
            notice("info", `switched to ${target.name}`);
          } catch (e) {
            notice("error", `${target.name}: ${(e as Error).message}`);
            return;
          }
          setExpandedProvider(null);
          setProviderQuery("");
          setMode("chat");
          return;
        }
        // Edit provider
        setManageProvider(target.name);
        setManageCursor(0);
        setExpandedProvider(null);
        setMode("manage");
        return;
      }
      return;
    }
    if (key === "up" || key === "k") return setMenuIndex((i) => wrap(i, itemCount, -1));
    if (key === "down" || key === "j") return setMenuIndex((i) => wrap(i, itemCount, 1));
    if (key === "escape") {
      // First escape clears the search; a second closes the menu.
      if (providerQuery) {
        setProviderQuery("");
        setMenuIndex(0);
        setExpandedProvider(null);
        return;
      }
      setExpandedProvider(null);
      return setMode("chat");
    }
    if (key === "backspace") {
      setProviderQuery((q) => q.slice(0, -1));
      setMenuIndex(0);
      setExpandedProvider(null);
      return;
    }
    // Right arrow opens the highlighted provider's manage screen.
    if ((key === "right" || key === "l") && menuIndex < providers.length) {
      const target = providers[menuIndex];
      if (target) {
        setManageProvider(target.name);
        setManageCursor(0);
        setMode("manage");
      }
      return;
    }
    if (key === "return") {
      if (menuIndex === providers.length) {
        setOnboarding(false);
        setAdd({ kind: "kind" });
        setAddKindCursor(0);
        setAddKindQuery("");
        setMode("add");
        return;
      }
      // Expand inline action section instead of switching.
      if (menuIndex < providers.length) {
        setExpandedProvider(menuIndex);
        setProviderActionCursor(0);
      }
      return;
    }
    if (key === "d") {
      const target = providers[menuIndex];
      if (target) {
        const next = removeProvider(config, target.name);
        setConfig(next);
        saveConfig(next);
        notice("info", `removed ${target.name}`);
        setMenuIndex(0);
      }
    }
  };

  // The manage screen for one provider: its details, then four actions.
  const MANAGE_ACTIONS = 4;
  const manageKey = (key: string): void => {
    const provider = namedProviders(config).find((p) => p.name === manageProvider);
    if (!provider) {
      setMode("menu");
      return;
    }
    if (key === "escape") {
      if (manageConfirm) return setManageConfirm(false);
      setMode("menu");
      return;
    }
    if (key === "up" || key === "k") {
      setManageConfirm(false);
      return setManageCursor((c) => wrap(c, MANAGE_ACTIONS, -1));
    }
    if (key === "down" || key === "j") {
      setManageConfirm(false);
      return setManageCursor((c) => wrap(c, MANAGE_ACTIONS, 1));
    }
    if (key !== "return") return;
    if (manageCursor === 0) {
      // Change model: make this provider active, then open the picker.
      const next = setActiveProvider(config, provider.name);
      setConfig(next);
      saveConfig(next);
      setModelCursor(Math.max(0, next.models.indexOf(provider.model ?? next.model)));
      setModelQuery("");
      setMode("model");
      return;
    }
    if (manageCursor === 1) return manageModels(provider.name);
    if (manageCursor === 2) {
      // Test connection: resolve this provider and verify it answers.
      notice("info", `testing ${providerLabel(provider)}…`);
      let resolved: ReturnType<typeof resolveProvider>;
      try {
        resolved = resolveProvider({ ...config, activeProvider: provider.name });
      } catch (error) {
        notice("error", `${provider.name}: ${(error as Error).message}`);
        return;
      }
      void loadTurn().then((T) => T.verifyProvider(resolved)).then((result) => {
        if (result.ok) notice("info", `${provider.name} works.`);
        else if (result.retriable) notice("warn", `${provider.name}: couldn't reach it (network) — ${result.message}`);
        else notice("error", `${provider.name} didn't answer: ${result.message}`);
      });
      return;
    }
    // Remove provider: the first enter arms it, the second removes.
    if (!manageConfirm) return setManageConfirm(true);
    const next = removeProvider(config, provider.name);
    setConfig(next);
    saveConfig(next);
    notice("info", `removed ${provider.name}`);
    setManageConfirm(false);
    setMode("menu");
  };

  const modelKey = (key: string): void => {
    const count = Math.max(1, filteredModels.length);
    if (key === "up" || key === "k") return setModelCursor((c) => wrap(c, count, -1));
    if (key === "down" || key === "j") return setModelCursor((c) => wrap(c, count, 1));
    if (key === "escape") {
      // First escape clears the search; a second closes the picker.
      if (modelQuery) {
        setModelQuery("");
        setModelCursor(0);
      } else setMode("chat");
      return;
    }
    if (key === "backspace") {
      setModelQuery((q) => q.slice(0, -1));
      setModelCursor(0);
      return;
    }
    if (key === "return") {
      const entry = filteredModels[modelCursor];
      if (entry) {
        try {
          let next = config;
          if (entry.provider && entry.provider !== active?.name) {
            next = setActiveProvider(next, entry.provider);
          }
          next = withModel(next, entry.model);
          setConfig(next);
          saveConfig(next);
          notice("info", `model set to ${entry.model}`);
        } catch (e) {
          notice("error", `couldn't switch model: ${(e as Error).message}`);
          return;
        }
      }
      setMode("chat");
    }
  };

  const thinkingKey = (key: string): void => {
    const count = Math.max(1, filteredThinking.length);
    if (key === "up" || key === "k") return setThinkingCursor((c) => wrap(c, count, -1));
    if (key === "down" || key === "j") return setThinkingCursor((c) => wrap(c, count, 1));
    if (key === "escape") {
      if (thinkingQuery) {
        setThinkingQuery("");
        setThinkingCursor(0);
      } else setMode("chat");
      return;
    }
    if (key === "backspace") {
      setThinkingQuery((q) => q.slice(0, -1));
      setThinkingCursor(0);
      return;
    }
    if (key === "return") {
      const effort = filteredThinking[thinkingCursor]?.effort;
      if (effort) {
        const next = withActiveReasoningEffort(config, effort);
        setConfig(next);
        saveConfig(next);
        notice("info", `reasoning effort set to ${effort}`);
      } else {
        notice("info", "reasoning effort left to the provider");
      }
      setMode("chat");
    }
  };

  const usageKey = (key: string): void => {
    if (key === "tab" || key === "right") return setUsageIndex((n) => (n + 1) % PERIODS.length);
    if (key === "left") return setUsageIndex((n) => (n - 1 + PERIODS.length) % PERIODS.length);
    if (key === "1") return setUsageIndex(0);
    if (key === "2") return setUsageIndex(1);
    if (key === "3") return setUsageIndex(2);
    if (key === "4") return setUsageIndex(3);
    if (key === "escape") return setMode("chat");
  };

  // The session picker: move through (filtered) saved sessions, type to filter
  // (the text dispatch routes it into sessionQuery), and enter switches.
  const sessionKey = (key: string): void => {
    const count = Math.max(1, filteredSessions.length);
    if (key === "up" || key === "k") return setSessionCursor((c) => wrap(c, count, -1));
    if (key === "down" || key === "j") return setSessionCursor((c) => wrap(c, count, 1));
    if (key === "escape") {
      if (sessionQuery) {
        setSessionQuery("");
        setSessionCursor(0);
      } else setMode("chat");
      return;
    }
    if (key === "backspace") {
      setSessionQuery((q) => q.slice(0, -1));
      setSessionCursor(0);
      return;
    }
    if (key === "return") {
      const target = filteredSessions[Math.min(sessionCursor, filteredSessions.length - 1)];
      if (target) switchToSession(target);
      else setMode("chat");
    }
  };

  const mcpKey = (key: string): void => {
    if (key === "escape") return setMode("chat");
    if (key === "backspace") {
      setMcpQuery((q) => q.slice(0, -1));
      return;
    }
  };

  const handleAddText = (text: string): void => {
    if (add.kind === "kind") {
      setAddKindQuery((q) => q + text);
      setAddKindCursor(0);
      return;
    }
    if (add.kind === "url") {
      const next = addUrl + text;
      setAddUrl(next);
      return;
    }
    if (add.kind === "key") {
      setAddKey((k) => k + text);
      return;
    }
    if (add.kind === "models") {
      // With a model list on screen, typing filters it; with none (the manual
      // fallback), typing enters the model name.
      if (add.models.length === 0) setAddManual((m) => m + text);
      else setAdd((a) => (a.kind === "models" ? { ...a, query: a.query + text, cursor: 0 } : a));
    }
  };

  const addKeyHandler = (key: string): void => {
    if (key === "escape") {
      // In a searchable phase, the first escape clears the search; a second leaves.
      if (add.kind === "models" && add.query) return setAdd({ ...add, query: "", cursor: 0 });
      if (add.kind === "kind" && addKindQuery) {
        setAddKindQuery("");
        setAddKindCursor(0);
        return;
      }
      signInAbort.current?.abort();
      setMode(onboarding ? "chat" : "menu");
      return;
    }
    if (add.kind === "kind") {
      const count = Math.max(1, filteredKinds.length);
      if (key === "up" || key === "k") return setAddKindCursor((n) => wrap(n, count, -1));
      if (key === "down" || key === "j") return setAddKindCursor((n) => wrap(n, count, 1));
      if (key === "backspace") {
        setAddKindQuery((q) => q.slice(0, -1));
        setAddKindCursor(0);
        return;
      }
      if (key === "return") {
        const chosen = filteredKinds[addKindCursor];
        if (!chosen) return;
        setAddKindQuery("");
        if (chosen.auth.length === 1 && chosen.auth[0] === "oauth") return addSignIn(chosen);
        setAddUrl(chosen.baseUrl);
        setAdd({ kind: "url", provider: chosen });
      }
      return;
    }
    if (add.kind === "url") {
      if (key === "return") {
        const baseUrl = addUrl.trim();
        let ok = false;
        try {
          const parsed = new URL(baseUrl);
          ok = parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          ok = false;
        }
        if (!ok) return setAdd({ kind: "error", provider: add.provider, message: `"${baseUrl}" is not a valid http(s) URL` });
        setAddKey("");
        setAdd({ kind: "key", provider: add.provider, baseUrl });
      }
      if (key === "backspace") setAddUrl((u) => u.slice(0, -1));
      return;
    }
    if (add.kind === "key") {
      if (key === "return") {
        const apiKey = addKey.trim();
        if (!apiKey) return setAdd({ kind: "error", provider: add.provider, message: "an API key is required", baseUrl: add.baseUrl });
        addListModels(add.provider, buildBase(add.provider, add.baseUrl, { auth: "api-key", apiKey }));
      }
      if (key === "backspace") setAddKey((k) => k.slice(0, -1));
      return;
    }
    if (add.kind === "error") {
      if (key === "return") {
        const retry = add.provider;
        if (retry.auth.includes("oauth") && retry.oauth && retry.auth.length === 1) return addSignIn(retry);
        if (add.baseUrl) {
          setAddKey("");
          setAdd({ kind: "key", provider: retry, baseUrl: add.baseUrl });
        } else {
          setAddUrl(retry.baseUrl);
          setAdd({ kind: "url", provider: retry });
        }
      }
      return;
    }
    if (add.kind === "models") {
      if (add.models.length === 0) {
        if (key === "return") addRegister(addManual.trim() ? [addManual.trim()] : []);
        if (key === "backspace") setAddManual((m) => m.slice(0, -1));
        return;
      }
      // Navigation and selection act on the filtered list, so a search narrows
      // what the cursor can reach without reindexing the whole model set.
      const models = add.query ? add.models.filter((m) => m.toLowerCase().includes(add.query.toLowerCase())) : add.models;
      const count = Math.max(1, models.length);
      if (key === "up" || key === "k") return setAdd({ ...add, cursor: wrap(add.cursor, count, -1) });
      if (key === "down" || key === "j") return setAdd({ ...add, cursor: wrap(add.cursor, count, 1) });
      if (key === "backspace") return setAdd({ ...add, query: add.query.slice(0, -1), cursor: 0 });
      if (key === " ") {
        const model = models[add.cursor];
        if (!model) return;
        const chosen = new Set(add.chosen);
        if (chosen.has(model)) chosen.delete(model);
        else chosen.add(model);
        setAdd({ ...add, chosen });
        return;
      }
      if (key === "a") return addRegister(add.models);
      if (key === "n") return addRegister([]);
      if (key === "return") {
        const model = models[add.cursor];
        addRegister(add.chosen.size ? [...add.chosen] : (model ? [model] : []));
      }
      return;
    }
  };

  function wrapSlash(current: number, count: number, delta: number): number {
    if (count <= 0) return 0;
    return (((current + delta) % count) + count) % count;
  }

  // ---- the face ----
  const liveQuiet = !(conversation.live.text || conversation.live.reasoning.trim() || conversation.live.tool || conversation.live.status || conversation.live.retrying);
  const face: Face = justFinished ? "happy" : busy && liveQuiet ? "startled" : stateFace({ live: conversation.live, lastEntry: conversation.entries[conversation.entries.length - 1], blocked: Boolean(conversation.blocked), busy });

  // ---- build the screen and draw it ----
  const entryRowList = useMemo(() => {
    const offsets: number[] = [];
    const rows: Seg[][] = [];
    conversation.entries.forEach((entry, i) => {
      const prev = i > 0 ? conversation.entries[i - 1] : undefined;
      const tight = prev?.kind === "reasoning" && entry.kind === "assistant";
      offsets.push(rows.length);
      rows.push(...entryLines(entry, frameInnerWidth(screen.size.cols), expandedReasoning.has(i), tight));
    });
    entryOffsetsRef.current = offsets;
    entryRowListLengthRef.current = rows.length;
    return rows;
  }, [conversation.entries, screen.size.cols, expandedReasoning]);

  const buildGrid = (): { grid: string[]; plain: string[] } => {
    const cols = screen.size.cols;
    const rows = screen.size.rows;
    const innerW = frameInnerWidth(cols);
    const menuOpen = mode !== "chat";

    // The composer (the draft input) is always pinned to the bottom — even
    // while a menu is open; the menu renders above it, never in its place.
    const composerMaxH = Math.max(3, Math.min(12, rows - 9));
    const composer = composerRows({ cols: innerW, draft, caret, busy, maxHeight: composerMaxH, topRight: ctrlCPressed ? "press ctrl c again to exit actor0" : composerHint, topRightColor: ctrlCPressed ? color.warning : composerHintColor }).rows;
    const blockedRow = conversation.blocked ? [[{ text: `the agent needs you: ${conversation.blocked.message} — reply to continue, or /clear`, color: color.warning }]] : [];

    // Human-readable header: the provider label, the model, branch, context, session.
    const headerInfo = [endpoint, provider?.model ?? config.model, branch ? `⎇ ${branch}` : undefined, context?.text, tokensToday > 0 ? `≡ ${formatTokens(tokensToday)} today` : undefined]
      .filter((p): p is string => Boolean(p))
      .join("   ");
    const top = topArea(cols, headerInfo, face);

    const disclaimer = "Actor0 is an experimental agent and may make mistakes.";
    const dPad = Math.max(0, Math.floor((frameInnerWidth(cols) - disclaimer.length) / 2));
    const disclaimerRow: Seg[] = [{ text: " ".repeat(dPad) + disclaimer, color: color.dim }];

    const blankRow: Seg[] = [{ text: " ".repeat(innerW), dim: true }];

    // All menus share one static slot: a fixed top edge just under the top
    // area, the same height every time, the composer pinned beneath it. The
    // budget is the rows between the blank line and the composer — every menu
    // box pads or windows to exactly it.
    const menuHeight = Math.max(6, rows - 2 - top.length - blockedRow.length - composer.length - 2);
    // Menus sit in the middle of the frame. panel() already centres its box
    // (segWidth(row) === innerW there), so this is a no-op on those rows.
    const centerRows = (r: Seg[][]): Seg[][] =>
      r.map((row) => {
        const pad = Math.max(0, Math.floor((innerW - segWidth(row)) / 2));
        return pad > 0 ? [{ text: " ".repeat(pad), dim: true }, ...row] : row;
      });
    const menuContent = menuOpen ? centerRows(menuContentRows(menuHeight)) : [];
    const slashHitMap: number[] = [];
    const slashPopup =
      !menuOpen && slashEngaged && slashMatches.length > 0
        ? centerRows(slashPopupRows(slashMatches.map((c) => ({ name: c.name, description: c.description, alias: c.aliases[0] })), slashSel, slashQuery, Math.min(MENU_WIDTH, innerW - 2), menuHeight, slashHitMap))
        : [];
    slashHitMapRef.current = slashHitMap;
    const menuSlot = menuContent.length > 0 || slashPopup.length > 0;

    // The chrome (top, blocked notice, menu slot, composer) may leave no
    // room for the transcript on a short terminal; the transcript yields
    // completely rather than clipping the pinned composer.
    const chromeH = top.length + blockedRow.length + (menuSlot ? 1 : 0) + slashPopup.length + menuContent.length + composer.length + 1;
    const transcriptV = menuSlot ? 0 : Math.max(0, rows - 2 - chromeH);
    const live = menuSlot ? [] : liveLines(conversation.live, frame, elapsed, innerW, transcriptV, Boolean(conversation.blocked), liveReasoningExpanded, reasoningStartedAtRef.current, 16, turnStartedAtRef.current, showThinking);

    // One layout for every menu: the top area, a blank line, the menu in its
    // static slot, blank fill, the pinned composer. Menus of every kind sit
    // on the same rows, so opening a different menu — or typing a filter in
    // the search bar — never moves the search bar itself; chat mode swaps
    // the slot for the transcript.
    const allTranscript: Seg[][] = menuSlot ? [] : [...entryRowList, ...live];
    const transcriptWindowStart = menuSlot ? 0 : Math.max(0, allTranscript.length - transcriptV - Math.min(Math.max(0, scrollOffset), Math.max(0, allTranscript.length - transcriptV)));
    const transcript: Seg[][] = menuSlot ? [] : windowRows(allTranscript, transcriptV, scrollOffset);
    while (!menuSlot && transcript.length < transcriptV) transcript.push(blankRow);

    // Keep refs in sync for selection (content-row anchoring + off-screen copy).
    transcriptAllSegsRef.current = allTranscript;
    transcriptPlainRef.current = allTranscript.map((r) => r.map((seg) => seg.text).join(""));
    transcriptCountRef.current = allTranscript.length;
    transcriptWindowStartRef.current = transcriptWindowStart;
    transcriptStartRowRef.current = top.length + blockedRow.length;
    transcriptVisibleBudgetRef.current = transcriptV;
    menuContentStartRowRef.current = top.length + blockedRow.length + 1;

    const inner: Seg[][] = menuSlot
      ? [...top, ...blockedRow, blankRow, ...menuContent, ...slashPopup, ...composer]
      : [...top, ...blockedRow, ...transcript, ...composer];
    if (menuSlot) {
      const popupStart = top.length + blockedRow.length + 1;
      const popupRows = menuContent.length > 0 ? menuContent : slashPopup;
      popupStartRowRef.current = popupStart;
      popupCountRef.current = popupRows.length;
    } else {
      popupStartRowRef.current = 0;
      popupCountRef.current = 0;
    }
    const contentH = rows - 2;
    // The disclaimer owns the last row; fill everything above it.
    const fitted: Seg[][] = inner.map((r) => fitWidth(r, innerW));
    while (fitted.length < contentH - 1) fitted.push(fitWidth(blankRow, innerW));
    fitted.push(fitWidth(disclaimerRow, innerW));
    const visible = fitted.slice(0, contentH);

    // Terminal row 0 is the top border; content starts one row down, and each
    // content row is `│ ` (2 columns) before the inner text. The selection is
    // in terminal coordinates, so shift it into this inner space once, here,
    // where both numbers are known.
    const sel = selection;
    const winStart = transcriptWindowStartRef.current;
    const startRow = transcriptStartRowRef.current;
    const budget = Math.max(1, transcriptVisibleBudgetRef.current || 1);
    const visibleCount = Math.min(budget, transcriptCountRef.current);
    const popupStart = popupStartRowRef.current;
    const popupCount = popupCountRef.current;
    const selRows = hasSelection(sel)
      ? spans(sel, innerW)
          .map((sp) => {
            const contentIndex = sp.row;
            if (contentIndex >= winStart && contentIndex < winStart + visibleCount) {
              const visibleIndex = startRow + (contentIndex - winStart);
              return { row: visibleIndex, from: sp.from, to: sp.to };
            }
            if (contentIndex >= popupStart && contentIndex < popupStart + popupCount) {
              return { row: contentIndex, from: sp.from, to: sp.to };
            }
            return null;
          })
          .filter((x): x is { row: number; from: number; to: number } => x !== null)
      : [];
    const painted = visible.map((row, i) => {
      const sp = selRows.find((x) => x.row === i);
      if (!sp) return paint(row);
      const from = Math.max(0, sp.from);
      const to = Math.min(innerW - 1, sp.to);
      return to >= from ? paint(highlight(row, from, to, color.selectionBg)) : paint(row);
    });
    const plain = visible.map((row) => row.map((s) => s.text).join(""));
    const grid: string[] = [topFrameBorder("actor0", version, cols)];
    for (const line of painted) grid.push(`│ ${line} │`);
    grid.push(bottomFrameBorder(cols));

    return { grid, plain };
  };

  function menuContentRows(height: number): Seg[][] {
    const innerW = frameInnerWidth(screen.size.cols);
    const hitMap: number[] = [];
    let rows: Seg[][] = [];
    switch (mode) {
      case "menu": {
        const providers = filteredProviders.map((p) => ({ name: p.name, label: providerLabel(p), active: p.name === config.activeProvider }));
        // The cursor may sit on the trailing "Add provider" entry.
        const w = Math.min(MENU_WIDTH, innerW - 2);
        rows = panel(providerPanelRows(providers, Math.min(menuIndex, providers.length), providerQuery, w, expandedProvider, providerActionCursor, height, hitMap), innerW, w, hitMap, hitMap);
        break;
      }
      case "manage": {
        const p = namedProviders(config).find((x) => x.name === manageProvider);
        if (!p) { rows = []; break; }
        const auth = p.auth === "oauth" ? `Subscription${p.oauth?.plan ? ` · ${p.oauth.plan}` : ""}` : "API key";
        rows = panel(managePanelRows({ name: p.name, label: providerLabel(p), model: p.model ?? "", endpoint: p.baseUrl, auth }, manageConfirm ? 3 : manageCursor, Math.min(MENU_WIDTH, innerW - 2), height, hitMap), innerW, Math.min(MENU_WIDTH, innerW - 2), hitMap, hitMap);
        break;
      }
      case "model":
        rows = modelPickerRows(filteredModels, Math.min(modelCursor, Math.max(0, filteredModels.length - 1)), height, modelQuery, Math.min(MENU_WIDTH, innerW - 2), activeModel, active?.name, hitMap);
        break;
      case "thinking":
        rows = thinkingPickerRows(filteredThinking.map((o) => ({ label: o.label, effort: o.effort })), Math.min(thinkingCursor, Math.max(0, filteredThinking.length - 1)), thinkingQuery, Math.min(MENU_WIDTH, innerW - 2), height, hitMap);
        break;
      case "usage": {
        const entries = readUsage();
        const stats = PERIODS.map((p) => {
          const since = p.since(new Date());
          const bucket = usageSince(entries, since);
          return { label: p.label, tokens: bucket.tokens, turns: bucket.turns, byModel: usageByModel(entries, since) };
        });
        rows = usagePanelRows(stats, usageIndex, Math.min(MENU_WIDTH, innerW - 2), height, hitMap);
        break;
      }
      case "session":
        rows = sessionPickerRows(
          filteredSessions.map((s) => ({ id: s.id, updatedAt: s.updatedAt, messageCount: s.messages.length, active: s.id === sessionIdRef.current })),
          Math.min(sessionCursor, Math.max(0, filteredSessions.length - 1)),
          height,
          sessionQuery,
          Math.min(MENU_WIDTH, innerW - 2),
        );
        break;
      case "mcp":
        rows = panel(
          [
            [{ text: "MCP servers", color: color.info, bold: true }],
            [],
            [{ text: "No MCP servers configured.", color: color.muted }],
            [{ text: "Configure MCP servers in your config file.", color: color.dim }],
          ],
          innerW,
          Math.min(MENU_WIDTH, innerW - 2),
        );
        break;
      case "add":
        rows = addRows(height, hitMap);
        break;
      default:
        rows = [];
    }
    menuHitMapRef.current = hitMap;
    return rows;
  }

  function addRows(height: number, hitMapOut?: number[]): Seg[][] {
    if (add.kind === "kind") return addKindRows(onboarding, filteredKinds.map((k) => ({ id: k.id, label: k.label, auth: k.auth })), Math.min(addKindCursor, Math.max(0, filteredKinds.length - 1)), addKindQuery, height, hitMapOut);
    if (add.kind === "url") return addUrlRows(add.provider.label, addUrl, height, hitMapOut).rows;
    if (add.kind === "key") return addKeyRows(add.provider.label, addKey, height, hitMapOut).rows;
    if (add.kind === "working") return addWorkingRows(add.label, add.note, height, hitMapOut);
    if (add.kind === "error") return addErrorRows(add.message, height, hitMapOut);
    if (add.kind === "models") {
      if (add.models.length === 0) return addManualRows(add.label, addManual, height, hitMapOut).rows;
      const models = add.query ? add.models.filter((m) => m.toLowerCase().includes(add.query.toLowerCase())) : add.models;
      return addModelsRows(add.label, models, Math.min(add.cursor, Math.max(0, models.length - 1)), add.chosen, height, add.query, hitMapOut);
    }
    return [];
  }

  // Draw on every state change. A full-screen grid is small; rewriting it each
  // frame is cheap and — unlike re-reconciling an Ink tree — never drops a byte.
  // The blinking terminal caret is never shown: the composer draws its own
  // block cursor into the grid, so the app owns the whole frame like a GUI.
  useEffect(() => {
    const { grid, plain } = buildGrid();
    plainRowsRef.current = plain;
    screen.render(grid);
  });

  // Restore the terminal on unmount.
  useEffect(
    () => () => {
      screen.dispose();
      if (scrollFrameRef.current) clearTimeout(scrollFrameRef.current);
    },
    [screen],
  );

  return null;
}

function buildBase(provider: ProviderKind, baseUrl: string, auth: { auth: "api-key"; apiKey: string } | { auth: "oauth"; oauth: OAuthTokens }): Record<string, unknown> {
  return { baseUrl, transport: provider.transport, ...(provider.path ? { path: provider.path } : {}), ...auth };
}
