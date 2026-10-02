import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ModelClient } from "@actor0/harness";
import { resolveProvider, saveConfig, withModel, type CliConfig } from "../config.js";
import {
  applyEvent,
  emptyLive,
  initialConversation,
  withHelp,
  withNotice,
  withUserInput,
  type ConversationState,
} from "../conversation.js";
import { cancelledTurnMessages, describeStop, describeTruncation, failedTurnMessages, forStorage, runTurn, usageSummary } from "../turn.js";
import { newSessionId, saveSession } from "../session.js";
import { parseSlash, type SlashCommand } from "../slash.js";
import { color, timing } from "../theme.js";
import { createToolHost } from "../tools.js";
import { Banner, LiveView, StatusBar, Transcript, bannerActivity, useTerminalSize } from "./parts.js";
import { RESPITE_HOST } from "../providers.js";
import { Composer } from "./prompts.js";

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

export function App({ cwd, config: initialConfig, resumed, version = "0.0.0", transport }: AppProps) {
  const { exit } = useApp();

  const [config, setConfig] = useState<CliConfig>(initialConfig);
  const [conversation, setConversation] = useState<ConversationState>(() => initialConversation());
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);

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
          if (config.models.length === 0) {
            notice("info", `model is ${config.model} — switch with /model <name>`);
            return;
          }
          const listing = [`model: ${config.model}`, ...config.models.map((m) => `  ${m}`)];
          notice("info", listing.join("\n"));
          return;
        }
        case "quit":
          exit();
          return;
        case "unknown":
          notice("warn", `unknown command ${command.input} — try /help`);
      }
    },
    [config, exit, notice],
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

      // The endpoint is fixed, so this is not a validation step — it is simply
      // where the chosen model gets attached to it.
      const provider = resolveProvider(config);
      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        try {
          const { result } = await runTurn({
            model: provider,
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
          const tokens = usageSummary(result.usage);
          if (tokens) notice("info", tokens);
        } catch (error) {
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
    [busy, config, notice, resumed?.updatedAt, runCommand, toolHost, updateLive],
  );

  // Global keys. Deliberately narrow: the composer owns text entry and the
  // approval dialog owns y/n.
  //
  // Scrolling is absent here on purpose. The transcript lives in the terminal's
  // scrollback now, so the wheel and Shift+PageUp reach it without the app
  // intercepting anything — and no key here can swallow a scroll the user is
  // trying to make, which is what the old PageUp handler did.
  useInput((input, key) => {
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
  // Live text, the blocked banner, the composer and the two-line footer all
  // have to fit in the terminal at the same time.
  const CHROME_ROWS = 8;

  // The footer must describe the key that is actually live. While an approval
  // dialog is open, Esc is *not* cancelling the turn — the dialog is denying the
  // write, and the global handler is disabled. Telling the user otherwise is
  // the kind of small lie that costs a wrong overwrite.
  const footerHint = busy
    ? "Esc cancels a running turn · Ctrl+D quits"
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
            model={config.model}
            endpoint={RESPITE_HOST}
            directory={cwd}
            activity={bannerActivity(conversation.live)}
            hint="/model to change"
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

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        history={history}
        isActive
        busy={busy}
      />

      <StatusBar cwd={cwd} endpoint={RESPITE_HOST} hint={footerHint} />
    </Box>
  );
}

