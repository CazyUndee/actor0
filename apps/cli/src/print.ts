import type { ChatMessage, ModelClient } from "@actor0/harness";
import { applyEvent, initialConversation, type ConversationState } from "./conversation.js";
import { resolveProvider, type CliConfig } from "./config.js";
import { createToolHost } from "./tools.js";
import { cancelledTurnMessages, forStorage, runTurn, usageSummary } from "./turn.js";
import { saveSession } from "./session.js";

/**
 * One turn, plain stdout, no TUI.
 *
 * This is the mode a script or a CI job can use, and it is the only way to
 * smoke-test a live provider: the TUI needs a terminal, and "it renders" says
 * nothing about whether the endpoint answers. It shares the reducer, the tool
 * host and the turn runner with the TUI, so what it prints is what the TUI
 * would have shown — including a tool call that leaked protocol text.
 *
 * Progress goes to stderr and the answer to stdout, so `actor0 -p … > out.txt`
 * captures the answer and nothing else.
 */

export type PrintOptions = {
  prompt: string;
  cwd: string;
  config: CliConfig;
  messages: ChatMessage[];
  /**
   * The session this turn belongs to, when one was restored.
   *
   * It changes the contract: with it, the exchange is written back to that
   * session (success, error, or interrupt), so a scripted run against `--session`
   * no longer discards what it did. Without it, nothing is persisted — a
   * stateless one-shot stays stateless, the way `-p` is used in pipes.
   */
  session?: { id: string; createdAt: string };
  /**
   * Bypasses the fixed endpoint with a client of the caller's choosing —
   * the same seam `AppProps.transport` gives the TUI, so the headless abort
   * path is testable without a network. Nothing the user can set reaches it.
   */
  client?: ModelClient;
  /**
   * Output sinks, so a test can capture the split without reaching into
   * process.stdout — patching the real streams inside a `node:test` process
   * intercepts the runner's own reporter and reads back as garbage. Defaults
   * are the real streams; nothing user-settable reaches here.
   */
  out?: { write(chunk: string): void };
  err?: { write(chunk: string): void };
  /**
   * A caller's cancellation signal, combined with this process's SIGINT/SIGTERM
   * — an embedding script can stop the turn the same way the terminal's
   * Ctrl+C does, and the abort path is then testable without faking signals.
   */
  signal?: AbortSignal;
};

export async function runPrintTurn(options: PrintOptions): Promise<number> {
  const sigint = new AbortController();
  const onSignal = () => sigint.abort(new Error("interrupted"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // One signal for both sources, so the turn cannot miss an abort that lands
  // while the caller's signal is being wired up. Forwarded through a real
  // controller because the rest of this function speaks `controller.signal`.
  const controller = new AbortController();
  const upstream = options.signal ? AbortSignal.any([sigint.signal, options.signal]) : sigint.signal;
  if (upstream.aborted) controller.abort(upstream.reason);
  else upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });

  const state: ConversationState = initialConversation();
  const toolHost = createToolHost({ cwd: options.cwd });
  // Same contract as the TUI: persist what the conversation settled on, and
  // only advance it when the turn adopts new history. A failed or interrupted
  // turn leaves the stored transcript at the state before the turn, except
  // where the harness recovered a cancelled exchange (see the catch below).
  let transcript = options.messages;

  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const log = (line: string) => err.write(`${line}\n`);

  const persist = (messages: ChatMessage[]): void => {
    if (!options.session) return;
    try {
      saveSession({
        id: options.session.id,
        createdAt: options.session.createdAt,
        updatedAt: new Date().toISOString(),
        model: resolveProvider(options.config).model,
        messages,
      });
    } catch (error) {
      log(`could not save session: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    const { result } = await runTurn({
      model: resolveProvider(options.config),
      ...(options.client ? { client: options.client } : {}),
      messages: options.messages,
      input: options.prompt,
      toolHost,
      signal: controller.signal,
      cwd: options.cwd,
      onEvent: (event) => {
        const next = applyEvent(state, event);
        state.entries = next.entries;
        state.live = next.live;
        state.blocked = next.blocked;
        if (event.type === "status") log(`  … ${event.status}`);
        if (event.type === "tool_call") {
          const call = event.tool_calls[0];
          if (call) log(`  → ${call.function.name}`);
        }
        if (event.type === "error") log(`  ! ${event.message}`);
      },
    });

    transcript = forStorage(result.messages);

    // The last non-empty assistant entry: after tool rounds the transcript
    // holds the whole answer, and the earlier entries are its live drafts.
    const answers = state.entries.filter(
      (entry): entry is { kind: "assistant"; text: string; partial: boolean } =>
        entry.kind === "assistant" && entry.text.trim().length > 0
    );
    const answer = answers[answers.length - 1];
    if (answer) out.write(`${answer.text.trimEnd()}\n`);

    const usage = usageSummary(result.usage);
    if (usage) log(`  ${usage}`);
    persist(transcript);
    return 0;
  } catch (error) {
    // A caller's SIGINT aborts the turn; the harness hands the transcript back
    // (AbortedTurnError), so adopt it — same as the TUI — and print what
    // streamed before the interrupt, which is still the best answer there is.
    // The cut fragment is in the live region (no `done` ever fired); earlier
    // rounds' prose was committed to entries as each tool call landed.
    const cancelled = cancelledTurnMessages(error);
    if (cancelled) {
      transcript = cancelled;
      const fragment = state.live.text.trim();
      if (fragment) {
        out.write(`${fragment.trimEnd()}\n`);
      } else {
        const answers = state.entries.filter(
          (entry): entry is { kind: "assistant"; text: string; partial: boolean } =>
            entry.kind === "assistant" && entry.text.trim().length > 0,
        );
        const partial = answers[answers.length - 1];
        if (partial) out.write(`${partial.text.trimEnd()}\n`);
      }
    }
    err.write(`${error instanceof Error ? error.message : String(error)}\n`);
    persist(transcript);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
