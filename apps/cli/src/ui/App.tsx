import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ModelClient } from "@actor0/harness";
import {
  addProvider,
  activeNamedProvider,
  namedProviders,
  removeProvider,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  withActiveReasoningEffort,
  withModel,
  type CliConfig,
  type ResolvedProvider,
} from "../config.js";
import {
  applyEvent,
  emptyLive,
  initialConversation,
  totalUsage,
  withHelp,
  withNotice,
  withUserInput,
  type ConversationState,
} from "../conversation.js";
import { cancelledTurnMessages, describeRecovery, describeStop, describeTruncation, failedTurnMessages, forStorage, runTurn, usageSummary } from "../turn.js";
import { newSessionId, saveSession } from "../session.js";
import { refreshProvider } from "../sign-in.js";
import { verifyProvider } from "../turn.js";
import { recordUsage, formatTokens, contextBar, readUsage, startOfDay, usageSince } from "../usage.js";
import { gitBranch } from "../git.js";
import { withContextWindow } from "../config.js";
import { contextWindowTokens } from "@actor0/harness";
import { parseSlash, type SlashCommand } from "../slash.js";
import { color, timing } from "../theme.js";
import { createToolHost } from "../tools.js";
import { Banner, LiveView, StatusBar, Transcript, bannerActivity, useTerminalSize } from "./parts.js";
import { Composer } from "./prompts.js";
import { AddProvider } from "./AddProvider.js";
import { UsagePanel } from "./UsagePanel.js";
import { ModelPicker } from "./ModelPicker.js";
import { ThinkingPicker } from "./ThinkingPicker.js";
import { ProviderMenu } from "./ProviderMenu.js";
import { SlashPopup } from "./SlashPopup.js";
import { providerLabel } from "../provider-presets.js";
import { matchSlashCommands } from "../slash.js";

/**
 * The root component, and the only place the CLI holds state.
 *
 * The division of labour is the point of the whole exercise: this file knows
 * about React, keys and spinners, and knows nothing about retries, tool rounds
 * or stream parsing. Those belong to the harness, which reports them as events
 * and this file merely reflects.
 */

export type AppProps = {
  cwd: string;
  config: CliConfig;
  /** Session restored from disk at launch. */
  resumed?: { id: string; createdAt: string; updatedAt: string; messages: ChatMessage[] };
  /** Printed in the opening card. */
  version?: string;
  /**
   * Replaces the fixed endpoint for the duration of this render.
   *
   * The endpoint is not configurable, so the only way to exercise the UI
   * without a network is the harness's own `ModelClient` port — which is what
   * the headless preview driver does. Nothing a user can set reaches this.
   */
  transport?: ModelClient;
};

/** Move `current` by `delta`, wrapping at both ends — for the `/` popup. */
function wrapSlash(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

export function App({ cwd, config: initialConfig, resumed, version = "0.0.0", transport }: AppProps) {
  const { exit } = useApp();

  const [config, setConfig] = useState<CliConfig>(initialConfig);
  const [conversation, setConversation] = useState<ConversationState>(() => initialConversation());
  const [draft, setDraft] = useState("");
  // The `/` command popup. `slashDismissed` holds the token the user pressed Esc
  // on — a per-token dismissal, so editing the command reopens the popup
  // (Codex's behaviour) rather than a sticky global hide. The derived filter is
  // computed below, once `mode` exists.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // Which interactive region owns the keyboard. "chat" is the composer; the
  // other two are the provider menu and its add form, which replace the
  // composer while open — one region at a time, so no two `useInput`s fight
  // over the same key. A menu never opens mid-turn (see `runCommand`).
  const [mode, setMode] = useState<"chat" | "menu" | "add" | "usage" | "model" | "thinking">("chat");
  // True only during the first-run welcome, so the add flow is framed as a
  // welcome and its completion is confirmed as "you're ready".
  const [onboarding, setOnboarding] = useState(false);
  // Context tokens in the latest request (the input the model just saw), for the
  // status line's "Context N% used". Zero until the first turn.
  const [contextTokens, setContextTokens] = useState(0);

  // Session state lives in refs: it changes on every turn but must never
  // trigger a re-render, because nothing on screen depends on it.
  const messagesRef = useRef<ChatMessage[]>(resumed?.messages ?? []);
  const sessionIdRef = useRef<string>(resumed?.id ?? newSessionId());
  const abortRef = useRef<AbortController | null>(null);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  // What the transcript would show if the turn ended right now: the last
  // settled state, plus any partial text the current attempt has streamed.
  // `finally` persists from this mirror, so a cancel saves the exchange the
  // user watched instead of silently rewinding the session file.
  const liveRef = useRef<ChatMessage[]>(messagesRef.current);
  const updateLive = useCallback((messages: ChatMessage[]) => {
    liveRef.current = messages;
  }, []);

  const toolHost = useMemo(() => createToolHost({ cwd }), [cwd]);

  // The endpoint the next turn will actually use, and the display name for it.
  //
  // Resolved here rather than at submit so the status bar can show where
  // requests go — the whole point of a configurable endpoint is that it is
  // never a surprise, and a constant host in the footer is a lie the moment
  // the endpoint is anything but the built-in one.
  //
  // Resolution never throws, because a config that cannot resolve is a fact
  // about this session rather than a reason to fail to draw it: the user has
  // to be able to *see* the broken endpoint in order to fix it. The message is
  // carried alongside and shown when a turn is submitted.
  const resolved = useMemo(() => {
    try {
      return { provider: resolveProvider(config), error: undefined } as const;
    } catch (error) {
      return { provider: null, error: (error as Error).message } as const;
    }
  }, [config]);
  const provider = resolved.provider;
  // The active provider, as a readable label — "Claude Code - Pro subscription",
  // "Anthropic API - Direct" — not a URL. Shown in the banner's endpoint row and
  // the status bar, so several providers are recognisable at a glance.
  const active = activeNamedProvider(config);
  const endpoint = active ? providerLabel(active) : "not configured";
  // Context usage for the status line: "Context 42% used" when the active
  // model's window is known (from /models or a past overflow), else the absolute
  // count — never a guessed percentage from a hardcoded window.
  const activeModel = active?.model;
  const window = activeModel ? config.contextWindows?.[activeModel] : undefined;
  // Status chips for the bottom bar, each with a tone. The context chip is
  // coloured by how full the window is — green, then amber, then red — so the
  // gauge is readable at a glance, not just numeric.
  const context = contextTokens > 0
    ? window && contextTokens <= window * 4
      ? { text: `${contextBar(contextTokens / window)} ${Math.min(100, Math.round((contextTokens / window) * 100))}%`, tone: (contextTokens / window >= 0.85 ? "error" : contextTokens / window >= 0.6 ? "warning" : "success") as "error" | "warning" | "success" }
      : { text: `${formatTokens(contextTokens)} tokens`, tone: "muted" as const }
    : undefined;
  // Read once per render; the branch read is a single stat.
  const branch = gitBranch(cwd);
  const tokensToday = usageSince(readUsage(), startOfDay()).tokens;
  const chips: { text: string; tone: "accent" | "success" | "warning" | "error" | "muted" | "dim" }[] = [
    { text: endpoint, tone: "accent" },
  ];
  if (context) chips.push(context);
  if (branch) chips.push({ text: `⎇ ${branch}`, tone: "muted" });
  if (active?.reasoningEffort) chips.push({ text: `◆ ${active.reasoningEffort}`, tone: "muted" });
  if (tokensToday > 0) chips.push({ text: `≡ ${formatTokens(tokensToday)} today`, tone: "dim" });

  // Onboarding. BYOK means there is nothing to talk to until a provider is
  // configured, so on launch — rather than presenting a composer that cannot
  // send anything — open the menu that adds one. Once only: the user may dismiss
  // it, and a config that merely becomes invalid later is not a reason to reopen.
  const openedOnboarding = useRef(false);
  useEffect(() => {
    if (openedOnboarding.current) return;
    if (!provider && /No provider is configured/.test(resolved.error ?? "")) {
      openedOnboarding.current = true;
      // Open the add flow as a welcome, not the empty management menu — the
      // first thing a new user should see is how to bring their own provider.
      setOnboarding(true);
      setMode("add");
    }
  }, [provider, resolved.error]);


  /** Push a notice without depending on the current state. */
  const notice = useCallback((tone: "info" | "warn" | "error", text: string) => {
    setConversation((state) => withNotice(state, tone, text));
  }, []);

  // Spinner frame and elapsed clock, driven by CronixUI's own transition
  // durations so the cadence belongs to the design system.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => {
      setFrame((n) => n + 1);
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, timing.spinnerMs);
    return () => clearInterval(id);
  }, [busy]);

  const runCommand = useCallback(
    (command: SlashCommand) => {
      switch (command.name) {
        case "help":
          setConversation((state) => withHelp(state));
          return;
        case "clear": {
          // A cleared conversation is a new session, not a truncated one, so
          // the old transcript stays on disk and can be resumed by hand.
          sessionIdRef.current = newSessionId();
          messagesRef.current = [];
          setConversation(initialConversation());
          notice("info", "started a new conversation");
          return;
        }
        case "model": {
          if (command.model) {
            const next = withModel(config, command.model);
            setConfig(next);
            saveConfig(next);
            notice("info", `model set to ${command.model}`);
            return;
          }
          // No argument: open the interactive picker over the remembered models
          // rather than dumping the list as a text notice.
          if (config.models.length === 0) {
            notice("info", `model is ${config.model || provider?.model || "(none)"} — switch with /model <name>`);
            return;
          }
          setMode("model");
          return;
        }
        case "provider": {
          // Open the interactive menu. `/provider` used to print the endpoint as
          // text; the menu is the same information, plus the ability to act on
          // it — switch, add, remove — which a printed block cannot do.
          setMode("menu");
          return;
        }
        case "setup": {
          // Re-run the first-run wizard at any time.
          setOnboarding(true);
          setMode("add");
          return;
        }
        case "usage": {
          setMode("usage");
          return;
        }
        case "thinking": {
          const effort = command.effort;
          if (effort === "low" || effort === "medium" || effort === "high") {
            const next = withActiveReasoningEffort(config, effort);
            setConfig(next);
            saveConfig(next);
            notice("info", `reasoning effort set to ${effort}`);
            return;
          }
          setMode("thinking");
          return;
        }
        case "quit":
          exit();
          return;
        case "unknown":
          notice("warn", `unknown command ${command.input} — try /help`);
      }
    },
    [config, exit, notice, provider, resolved.error],
  );

  const submit = useCallback(
    (raw: string) => {
      const input = raw.trim();
      if (!input) return;

      // A turn is already running. The text stays in the composer and the
      // user is told why: it is not cleared, and it is not sent. The composer
      // used to be made inactive for the duration of a turn, which discarded
      // every keystroke typed while the agent worked — a user who starts the
      // next question during a long tool call watches it disappear, character
      // by character, with nothing on screen saying the input is off. Found by
      // the TUI preview typing the next question during a turn and losing it.
      // Type-ahead is ordinary; losing what someone typed is not.
      if (busy) {
        notice("warn", "still working — wait for the turn, or press Esc to cancel it");
        return;
      }

      const command = parseSlash(input);
      if (command) {
        // Clear the composer first. A command that leaves its own text behind
        // turns the next keystroke into `/helpwhatever`.
        setDraft("");
        runCommand(command);
        return;
      }

      setDraft("");
      setHistory((prev) => [input, ...prev.filter((item) => item !== input)].slice(0, 50));
      setConversation((state) => withUserInput(state, input));
      setBusy(true);

      // Resolved at submit so a configuration that only just became invalid is
      // reported here, in front of the user, instead of failing the first
      // request with a transport error about a URL they cannot see.
      if (!provider) {
        // No provider yet: walk into setup rather than dead-ending on an error.
        setOnboarding(true);
        setMode("add");
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        try {
          // Refresh an expired OAuth token before the turn and persist the new
          // one, so a long session does not 401 the moment the access token
          // ages out. A failed refresh is ignored here — the turn proceeds with
          // the stale token and the endpoint's 401 tells the user to sign in
          // again, which is clearer than a silent retry.
          let activeProvider = provider;
          if (provider.auth === "oauth") {
            const refreshed = await refreshProvider(provider, config).catch(() => undefined);
            if (refreshed) {
              activeProvider = refreshed.provider;
              setConfig(refreshed.config);
              saveConfig(refreshed.config);
            }
          }
          const { result, recovery } = await runTurn({
            model: activeProvider,
            ...(transport ? { client: transport } : {}),
            messages: messagesRef.current,
            input,
            toolHost,
            signal: controller.signal,
            cwd,
            ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
            onEvent: (event) =>
              setConversation((state) => {
                const next = applyEvent(state, event);
                if (event.type === "done") {
                  // The turn's answer is final: this is the state a save
                  // should capture if the turn ends from here on.
                  const answer = next.entries[next.entries.length - 1];
                  if (answer?.kind === "assistant") {
                    updateLive([
                      ...messagesRef.current,
                      { role: "assistant", content: answer.text },
                    ]);
                  }
                }
                return next;
              }),
          });

          messagesRef.current = forStorage(result.messages);
          updateLive(messagesRef.current);

          // A turn that stopped on `needs_user` is resumable, not finished, so
          // say so rather than letting it look like a completed answer. The
          // reason travels on the event, not on the result: `RunResult.blocked`
          // is a bare boolean, and guessing from it meant a turn that ran out
          // of tool rounds claimed its tools had been failing.
          if (result.blocked) {
            notice("warn", describeStop(conversationRef.current.blocked?.reason));
          }
          // The answer rendered above is marked partial, but the reader is
          // looking at a finished-looking conversation: a warning has to name
          // the fact that the model's reply stopped at the output cap, and
          // that asking again is the way to get the rest of it.
          if (result.truncated) {
            notice("warn", describeTruncation());
          }
          // The overflow recovery rewrote what the model can read, and the
          // rows above still show the real contents it can no longer see.
          // That divergence is the whole reason this exists: the turn looks
          // like it succeeded, so nothing else would ever mention it.
          if (recovery) {
            notice("warn", describeRecovery(recovery));
          }
          const total = totalUsage(result.usage);
          // Log the turn locally for /usage, and remember the context size so
          // the status line can show how full the window is.
          recordUsage(provider.model, total);
          setContextTokens(total.prompt_tokens);
          const tokens = usageSummary(result.usage);
          if (tokens) notice("info", tokens);
        } catch (error) {
          // Learn the context window from an overflow the recovery could not
          // clear: the error names it, and remembering it means the status line
          // can show "Context N% used" on the next turn instead of a bare count.
          const learned = contextWindowTokens(error);
          if (learned !== undefined) {
            const next = withContextWindow(config, provider.model, learned);
            setConfig(next);
            saveConfig(next);
          }
          // The harness hands the transcript back on abort (AbortedTurnError)
          // and on any other turn failure (FailedTurnError): the input,
          // every finished round, honest answers for the calls a cancel cut
          // short, and the partial answer marked interrupted or failed.
          // Adopting it is what makes the turn survive a restart — without
          // this, messagesRef still holds the state from before the turn and
          // the save below quietly rewinds the session to it, losing an
          // exchange the user watched happen. The save reads the live
          // mirror, so the adoption has to advance it too: skipping that
          // step is how the abort path once promised a restart-surviving
          // cancel the TUI never actually delivered.
          const recovered = cancelledTurnMessages(error) ?? failedTurnMessages(error);
          if (recovered) {
            messagesRef.current = recovered;
            updateLive(recovered);
          }

          if (controller.signal.aborted) {
            // Keep whatever streamed before the cancel — discarding it would
            // throw away text the user already read.
            setConversation((state) => {
              const partial = state.live.text;
              const kept: ConversationState = partial.trim()
                ? { ...state, entries: [...state.entries, { kind: "assistant", text: partial, partial: true }] }
                : state;
              // "cancelled" on its own says only that the turn stopped. What a
              // person who pressed Esc needs to know is what they have left, and
              // the answer is everything above: the interrupted call is now a row
              // of its own, because the harness reports it, and anything that
              // had streamed is kept below it.
              return withNotice(
                { ...kept, live: emptyLive() },
                "warn",
                "cancelled \u2014 what you see above is all that was kept",
              );
            });
          } else {
            // A failed turn keeps its fragment on screen the way a cancel
            // does: the text above the error is the part of the answer
            // that made it out, and it is saved — marked failed — in the
            // transcript adopted above. The live region must still be
            // cleared here, or the streamed text, the tool spinner and
            // the status line freeze on screen above the error.
            setConversation((state) => {
              const partial = state.live.text;
              const kept: ConversationState = partial.trim()
                ? { ...state, entries: [...state.entries, { kind: "assistant", text: partial, partial: true }] }
                : state;
              return withNotice({ ...kept, live: emptyLive() }, "error", (error as Error).message);
            });
          }
        } finally {
          abortRef.current = null;
          setBusy(false);
          try {
            saveSession({
              id: sessionIdRef.current,
              // The original creation time, not the last time it was touched.
              // These drifted because this read `updatedAt`, so a session that
              // had been resumed once reported a creation time equal to its
              // most recent save.
              createdAt: resumed?.createdAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              model: provider.model,
              // The live region's mirror: this ref advances only when the
              // conversation is adopting new history — a completed turn's
              // result, or a cancelled turn's recovered transcript. Saving it
              // instead of reading React state is what keeps the file matching
              // what the user actually saw, including a turn they stopped.
              messages: liveRef.current,
            });
          } catch (error) {
            notice("error", `could not save session: ${(error as Error).message}`);
          }
        }
      })();
    },
    [busy, config, notice, provider, resolved.error, resumed?.updatedAt, runCommand, toolHost, updateLive],
  );

  // Global keys. Deliberately narrow: the composer owns text entry and the
  // approval dialog owns y/n.
  //
  // Scrolling is absent here on purpose. The transcript lives in the terminal's
  // scrollback now, so the wheel and Shift+PageUp reach it without the app
  // intercepting anything — and no key here can swallow a scroll the user is
  // trying to make, which is what the old PageUp handler did.
  const slashToken = /^\/([a-z]*)$/i.exec(draft)?.[1];
  const slashEngaged = mode === "chat" && slashToken !== undefined && slashDismissed !== slashToken;
  const slashMatches = slashEngaged ? matchSlashCommands(slashToken!) : [];
  const slashSel = slashMatches.length > 0 ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  useInput((input, key) => {
    // While a `/` command is being typed, the popup owns the keys — Codex-style:
    // arrows/1-9 move and run, Tab completes into the draft, Esc dismisses this
    // token. Enter runs the highlighted command (or submits the raw text when
    // nothing matches), never a half-typed string to the model.
    if (slashEngaged) {
      if (key.upArrow || input === "k") {
        if (slashMatches.length > 0) setSlashIndex((n) => wrapSlash(n, slashMatches.length, -1));
        return;
      }
      if (key.downArrow || input === "j") {
        if (slashMatches.length > 0) setSlashIndex((n) => wrapSlash(n, slashMatches.length, 1));
        return;
      }
      if (key.escape) {
        setSlashDismissed(slashToken!);
        return;
      }
      if (key.tab) {
        const match = slashMatches[slashSel];
        if (match) setDraft(`/${match.name}`);
        return;
      }
      if (input >= "1" && input <= "9") {
        const match = slashMatches[Number(input) - 1];
        if (match) submit(`/${match.name}`);
        return;
      }
      if (key.return) {
        const match = slashMatches[slashSel];
        submit(match ? `/${match.name}` : draft);
        return;
      }
    }
    if (key.escape) {
      if (busy) {
        abortRef.current?.abort();
        return;
      }
      return;
    }
    // Ctrl+C cancels a run, and exits when there is nothing to cancel.
    if (key.ctrl && input === "c") {
      if (busy) {
        abortRef.current?.abort();
        return;
      }
      exit();
      return;
    }
    if (key.ctrl && input === "d") exit();
  }, { isActive: true });

  const { columns, rows } = useTerminalSize();
  // Live text, the blocked banner, the 5-row composer (bordered box) and the
  // two-line footer all have to fit in the terminal at the same time. The
  // composer grew from a single line to a 3-content-row box, so this budget
  // grew with it.
  const CHROME_ROWS = 12;

  // The footer must describe the key that is actually live. While an approval
  // dialog is open, Esc is *not* cancelling the turn — the dialog is denying the
  // write, and the global handler is disabled. Telling the user otherwise is
  // the kind of small lie that costs a wrong overwrite.
  const footerHint = busy
    ? "Esc cancels a running turn · Ctrl+D quits"
    : mode === "usage"
      ? "tab or 1/2/3 switches period · esc closes · Ctrl+D quits"
      : mode !== "chat"
        ? "esc closes · Ctrl+D quits"
        : "/help for commands · Ctrl+D quits";
  return (
    // The top margin is the gap between the scrollback and the part of the UI
    // that still moves. `<Static>` is positioned absolutely, so this is the only
    // thing separating the last transcript entry from the composer — without it
    // the input line is glued to the answer above it. Every entry carries its
    // own `marginTop`, so this single row is the same rhythm the transcript
    // already uses internally.
    <Box flexDirection="column" marginTop={1}>
      <Transcript
        entries={conversation.entries}
        columns={columns}
        banner={
          <Banner
            title="actor0"
            version={version}
            model={provider?.model ?? config.model}
            endpoint={endpoint}
            directory={cwd}
            activity={bannerActivity(conversation.live)}
            hint="/provider to switch"
            columns={columns}
          />
        }
      />

      {/* The only part of the tree that still moves. Its text is trimmed to the
          rows the chrome leaves free — see `fitTail` — because Ink's `Box` has
          no `maxHeight`, and without that trim a streaming answer grows until
          the frame is taller than the terminal.

          That is not a cosmetic concern. A frame as tall as the terminal is the
          condition under which Ink abandons its normal path and does
          `clearTerminal` followed by a full repaint on every frame that
          produces output, which is precisely what destroyed the terminal's
          scrollback and left earlier messages unreachable. Keeping the frame
          shorter than the terminal is what makes Ink write each committed entry
          once and let it scroll into the scrollback, where the wheel can reach
          it. It is also why the root Box carries no `height` of its own. */}
      <Box flexDirection="column" overflow="hidden">
        <LiveView
          live={conversation.live}
          frame={frame}
          elapsed={elapsed}
          rows={Math.max(1, rows - CHROME_ROWS)}
          columns={columns}
        />

        {conversation.blocked ? (
          <Box marginTop={1}>
            <Text color={color.warning} wrap="truncate-end">
              the agent needs you: {conversation.blocked.message}
            </Text>
            <Text color={color.dim}> reply to continue, or /clear to start over</Text>
          </Box>
        ) : null}
      </Box>

      {mode === "menu" ? (
        <ProviderMenu
          providers={namedProviders(config)}
          activeName={config.activeProvider}
          onActivate={(name) => {
            const next = setActiveProvider(config, name);
            setConfig(next);
            saveConfig(next);
            setMode("chat");
            notice("info", `switched to ${name}`);
          }}
          onAdd={() => setMode("add")}
          onRemove={(name) => {
            // Stays in the menu so the list can be pruned more than once; the
            // menu resets its selection when the row count changes.
            const next = removeProvider(config, name);
            setConfig(next);
            saveConfig(next);
            notice("info", `removed ${name}`);
          }}
          onCancel={() => setMode("chat")}
        />
      ) : mode === "add" ? (
        <AddProvider
          onboarding={onboarding}
          onDone={(provider, models, windows) => {
            // Register the one provider, then remember the chosen models the way
            // `/model` does — the active one first, capped, de-duplicated.
            let next = addProvider(config, provider);
            const remembered = [...new Set([provider.model, ...models].filter((m): m is string => Boolean(m)))];
            const rest = next.models.filter((m) => !remembered.includes(m));
            next = { ...next, models: [...remembered, ...rest].slice(0, 20) };
            // Merge any context windows the provider published — learned, never a
            // hand-maintained table.
            if (windows) for (const [model, window] of Object.entries(windows)) next = withContextWindow(next, model, window);
            setConfig(next);
            saveConfig(next);
            setMode("chat");
            setOnboarding(false);
            const name = next.activeProvider ?? "provider";
            if (!onboarding) {
              notice("info", `added ${name}${remembered.length ? ` · ${remembered.length} model${remembered.length === 1 ? "" : "s"}` : ""}`);
              return;
            }
            // First run: the model-list fetch already proved the credential, but
            // confirm the chosen model actually answers before calling it ready.
            let resolved: ResolvedProvider;
            try {
              resolved = resolveProvider(next);
            } catch {
              notice("info", `added ${name} — set a model with /model <name> to start.`);
              return;
            }
            notice("info", `verifying ${name}…`);
            void verifyProvider(resolved).then((result) => {
              if (result.ok) notice("info", `ready — ${name} works. Ask anything, or /provider to manage providers.`);
              else if (result.retriable) notice("warn", `added ${name}, but couldn't verify it (network) — it may still work.`);
              else notice("warn", `added ${name}, but it didn't answer: ${result.message}`);
            });
          }}
          onCancel={() => {
            setOnboarding(false);
            // From onboarding there is nothing to manage yet, so cancel returns
            // to the composer; from /provider it returns to the provider menu.
            setMode(onboarding ? "chat" : "menu");
          }}
        />
      ) : mode === "usage" ? (
        <UsagePanel onCancel={() => setMode("chat")} />
      ) : mode === "model" ? (
        <ModelPicker
          models={config.models}
          active={provider?.model ?? config.model}
          onSelect={(model) => {
            const next = withModel(config, model);
            setConfig(next);
            saveConfig(next);
            setMode("chat");
            notice("info", `model set to ${model}`);
          }}
          onCancel={() => setMode("chat")}
        />
      ) : mode === "thinking" ? (
        <ThinkingPicker
          active={active?.reasoningEffort}
          onSelect={(effort) => {
            const next = withActiveReasoningEffort(config, effort);
            setConfig(next);
            saveConfig(next);
            setMode("chat");
            notice("info", `reasoning effort set to ${effort}`);
          }}
          onCancel={() => setMode("chat")}
        />
      ) : (
        <>
          {slashEngaged && slashMatches.length > 0 ? <SlashPopup commands={slashMatches} selected={slashSel} /> : null}
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            history={history}
            isActive
            busy={busy}
            popupOpen={slashEngaged}
          />
        </>
      )}

      <StatusBar cwd={cwd} chips={chips} hint={footerHint} />
    </Box>
  );
}

