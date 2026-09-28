import type { ChatMessage } from "@actor0/harness";
import { applyEvent, initialConversation, type ConversationState } from "./conversation.js";
import { resolveProvider, type CliConfig } from "./config.js";
import { createToolHost } from "./tools.js";
import { runTurn, usageSummary } from "./turn.js";

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
};

export async function runPrintTurn(options: PrintOptions): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const state: ConversationState = initialConversation();
  const toolHost = createToolHost({ cwd: options.cwd });

  const log = (line: string) => process.stderr.write(`${line}\n`);

  try {
    const { result } = await runTurn({
      model: resolveProvider(options.config),
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

    // The last non-empty assistant entry: after tool rounds the transcript
    // holds the whole answer, and the earlier entries are its live drafts.
    const answers = state.entries.filter(
      (entry): entry is { kind: "assistant"; text: string; partial: boolean } =>
        entry.kind === "assistant" && entry.text.trim().length > 0
    );
    const answer = answers[answers.length - 1];
    if (answer) process.stdout.write(`${answer.text.trimEnd()}\n`);

    const usage = usageSummary(result.usage);
    if (usage) log(`  ${usage}`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
