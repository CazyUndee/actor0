import type { ModelClient } from "@actor0/harness";
import type { ResolvedProvider } from "./config.js";
import { runTurn } from "./turn.js";
import { createToolHost, type TaskDelegate, type TaskRequest, type TaskResult } from "./tools.js";

/**
 * Sub-agent delegation.
 *
 * The `task` tool hands a self-contained subtask to a second agent that runs
 * its own turn — its own context window, its own tool rounds — against the same
 * provider and endpoint, and returns its final answer as the tool's result. The
 * parent keeps its context for the conversation; the sub-agent spends its own on
 * the research. Claude Code's Task tool works the same way.
 *
 * This sits behind the `TaskDelegate` port declared in `tools.ts`, so the tool
 * never imports this module — which would import `tools.ts` straight back for
 * the sub-agent's own host. It is reached lazily through `turn-entry.ts` like
 * the rest of the turn machinery, so it stays off the boot path.
 */

/**
 * A delegate whose sub-agents cannot delegate further.
 *
 * Every sub-agent is given a host that *has* a `task` tool — so the tool count
 * and the prompt's "N tools" are identical for a parent and a sub-agent, and the
 * prompt is never a lie about what the model is holding — but that tool refuses
 * to recurse. Without it, a model fond of delegating could spawn sub-agents
 * indefinitely, each paying for a full turn, with nothing in the design that
 * stops it. The refusal is a plain answer rather than a thrown error, so the
 * sub-agent reads it as a fact and does the work itself instead of retrying.
 */
const noRecursion: TaskDelegate = {
  async run(): Promise<TaskResult> {
    return {
      text:
        "Sub-agents cannot delegate further work. Do this task yourself with your own tools, " +
        "or report back that it needs the parent agent.",
      complete: false,
      rounds: 0,
      toolCallCount: 0,
    };
  },
};

export type TaskDelegateOptions = {
  /** The provider and endpoint the sub-agent runs against — the parent's own. */
  provider: ResolvedProvider;
  /** The working directory the sub-agent's tools are confined to. */
  cwd: string;
  /**
   * A client to run the sub-agent through, bypassing the provider's endpoint.
   *
   * The CLI never sets this; it is the seam a test injects a transport through,
   * exactly as `runTurn`'s `client` is. A sub-agent runs on the same transport
   * as the parent, so delegation needs no separate credential path.
   */
  client?: ModelClient;
};

/**
 * Build the delegate the `task` tool calls.
 *
 * The sub-agent's host is built once and reused across runs: it is stateless —
 * the base tools plus a `task` tool that refuses to recurse — and rebuilding it
 * per call would re-run the tool registry for nothing.
 */
export function createTaskDelegate(options: TaskDelegateOptions): TaskDelegate {
  const { provider, cwd } = options;
  const subagentHost = createToolHost({ cwd, taskDelegate: noRecursion });

  return {
    async run(request: TaskRequest, signal: AbortSignal): Promise<TaskResult> {
      const outcome = await runTurn({
        model: provider,
        ...(options.client ? { client: options.client } : {}),
        // A fresh context: the sub-agent starts from the system prompt and its
        // own task, never from the parent's transcript. That isolation is the
        // whole point.
        messages: [],
        input: request.prompt,
        toolHost: subagentHost,
        signal,
        cwd,
      });
      const result = outcome.result;
      return {
        text: result.text,
        complete: result.complete,
        rounds: result.rounds,
        toolCallCount: result.audit.toolCallCount,
      };
    },
  };
}
