import type { ToolDefinition } from "@actor0/harness";
import { optionalText, requireString } from "./shared.js";
import type { ToolContext } from "./context.js";

/**
 * The task tool — delegation to a sub-agent.
 *
 * A sub-agent runs with the same tools and the same endpoint and returns only
 * its final answer, so long research or a multi-step exploration stays out of
 * this conversation's context. The prompt must be self-contained: the sub-agent
 * cannot see the caller's transcript, and the tool says so in its own
 * description rather than letting the model discover it from a bad answer.
 *
 * The delegate is a port (`ToolContext.taskDelegate`), so this module never
 * imports the turn runner — which imports this registry back for the
 * sub-agent's own tools.
 */

export type TaskRequest = {
  /** Everything the sub-agent needs, in full — it cannot see the caller's conversation. */
  prompt: string;
  /** A short label for the activity line. */
  description?: string;
};

export type TaskResult = {
  /** The sub-agent's final answer. */
  text: string;
  /** Whether it finished with a complete, untruncated answer. */
  complete: boolean;
  /** Model rounds the sub-agent spent. */
  rounds: number;
  /** Tool calls the sub-agent made. */
  toolCallCount: number;
};

export const taskDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "task",
    description:
      "Delegate a self-contained subtask to a sub-agent that runs with the same tools and endpoint and returns its final answer. Use it to keep long research or multi-step work out of this conversation's context; the sub-agent cannot see this conversation, so the prompt must contain everything it needs. It returns the sub-agent's answer, or a note that it produced none.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The complete task for the sub-agent, in full — it cannot see this conversation, so include all context, file paths and goals it needs.",
        },
        description: { type: "string", description: "A short label for what the sub-agent is doing, shown on the activity line." },
      },
      required: ["prompt"],
    },
  },
};

export async function runTask(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const delegate = ctx.taskDelegate;
  if (!delegate) {
    throw new Error("task delegation is not available in this context");
  }
  const prompt = requireString(args, "prompt");
  const description = optionalText(args, "description")?.trim();
  const result = await delegate.run({ prompt, ...(description ? { description } : {}) }, ctx.signal);
  const where = description ? ` (${description})` : "";
  const stats = `${result.rounds} round${result.rounds === 1 ? "" : "s"}, ${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"}`;
  if (!result.text.trim()) {
    return `The sub-agent${where} produced no answer after ${stats}. Do the task yourself or report that it could not be completed.`;
  }
  const flag = result.complete ? "" : " (incomplete)";
  return `[sub-agent${where} — ${stats}${flag}]\n\n${result.text}`;
}
