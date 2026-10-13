import type { ModelClient, ModelEvent, ToolDefinition } from "@actor0/harness";

/**
 * A simulated model, for testing the harness itself.
 *
 * The benchmark's whole value rests on its metrics being trustworthy, and the
 * only way to establish that without a live gateway is to drive it with a model
 * whose behaviour is a *known function of the interface*. This provides that: a
 * policy receives the tool schemas and the conversation so far and returns the
 * events to stream, exactly as a real model would. With a policy that is
 * competent, every candidate must score well; with one that only fills the
 * fields a schema forces, a permissive candidate must score worse than a strict
 * one. If the metrics do not show that, the instrument is broken — and that is
 * checkable offline, in milliseconds, for free.
 *
 * A policy returning no events ends the stream.
 */

export type Turn = {
  /** The tool schemas the candidate advertised this round. */
  tools: ToolDefinition[];
  /** The conversation so far, including the user's task as the last message. */
  messages: { role: string; content: string }[];
  /** 1-based round number within the turn. */
  round: number;
};

export type SimPolicy = (turn: Turn) => ModelEvent[];

/** A `ModelClient` that asks `policy` what to stream, one call per round. */
export function simulatedModel(policy: SimPolicy): ModelClient {
  return {
    async *stream(messages, tools) {
      const round = messages.filter((m) => m.role === "assistant").length + 1;
      for (const event of policy({ tools, messages, round })) yield event;
    },
  };
}

// --- reusable behaviours ---------------------------------------------------

const done: ModelEvent = { type: "done" };

/** Answer directly, with no tool call. */
export const answer = (text: string): SimPolicy => () => [{ type: "token", delta: text }, done];

/** Call the named tool once with `args`, then answer. */
export const callThenAnswer = (
  name: string,
  args: Record<string, unknown>,
  reply: string,
): SimPolicy => (turn) =>
  turn.round === 1
    ? [{ type: "tool_call", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, done]
    : [{ type: "token", delta: reply }, done];

/**
 * Emit a tool call carrying only the args the schema *forces*, then answer.
 *
 * This is the behaviour that separates a strict schema from a permissive one: a
 * model that supplies only what `required` demands will construct a valid call
 * against candidate B (where `read` requires `path`) and an invalid one against
 * candidate C (where `inspect` requires only `op`). `toolName` and `fullArgs`
 * describe the intended call; the policy trims it to the schema's required set
 * and, for a grouped tool, wraps it as `{ op, ...requiredArgs }`.
 */
export const minimalArgsThenAnswer = (
  options: { tool: string; op?: string; args: Record<string, unknown>; reply: string },
): SimPolicy => (turn) => {
  if (turn.round !== 1) return [{ type: "token", delta: options.reply }, done];
  const spec = turn.tools.find((t) => t.function.name === options.tool);
  const required = (spec?.function.parameters?.required as string[] | undefined) ?? [];
  const trimmed: Record<string, unknown> = {};
  if (options.op !== undefined) trimmed.op = options.op;
  for (const key of required) if (key !== "op" && options.args[key] !== undefined) trimmed[key] = options.args[key];
  return [
    {
      type: "tool_call",
      tool_calls: [{ id: "c1", type: "function", function: { name: options.tool, arguments: JSON.stringify(trimmed) } }],
    },
    done,
  ];
};

/** Emit the same failing call `times` times, then give up with an answer. */
export const flailThenGiveUp = (
  name: string,
  args: Record<string, unknown>,
  times: number,
  reply = "I could not complete this.",
): SimPolicy => (turn) => {
  if (turn.round <= times) {
    return [
      {
        type: "tool_call",
        tool_calls: [{ id: `c${turn.round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      done,
    ];
  }
  return [{ type: "token", delta: reply }, done];
};

/** Report token usage alongside whatever else the policy emits. */
export const withUsage = (policy: SimPolicy, usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): SimPolicy =>
  (turn) => [...policy(turn), { type: "usage", usage }];
