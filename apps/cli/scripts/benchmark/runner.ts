import type { ModelClient, ToolDefinition, ToolHost } from "@actor0/harness";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedProvider } from "../../src/config.js";
import { runTurn } from "../../src/turn.js";
import { type CandidateId, type RawCandidate } from "./candidates.js";
import { createDispatcher } from "./dispatch.js";
import type { Task } from "./tasks.js";
import { createUnderlying } from "./underlying.js";

/**
 * Run one candidate on one task and measure it.
 *
 * Every candidate gets the same task, the same fresh workspace, the same model
 * and system prompt and limits — only the tool interface differs. The turn is
 * driven by the harness's own loop (`runTurn`); the candidate's tools are the
 * harness's `ToolHost`, whose `execute` is the benchmark dispatcher, so schema
 * and semantic validity are recorded exactly as the model experiences them.
 *
 * `client` injects a `ModelClient` so the runner is testable without a network;
 * a real run passes the resolved provider instead.
 */

export type TaskResult = {
  candidate: CandidateId;
  taskId: string;
  completed: boolean;
  /** Was the model's first tool call schema-valid? null if it made none. */
  firstCallValid: boolean | null;
  /** After a schema-invalid call, did a later call validate? null if none invalid. */
  recovered: boolean | null;
  toolCalls: number;
  schemaInvalid: number;
  semanticInvalid: number;
  unsupported: number;
  /** Tokens the provider reported for the turn. */
  usageTokens: number;
  /** Tokens in the candidate's tool definitions (cost of the interface itself). */
  toolDefTokens: number;
  latencyMs: number;
  answer: string;
};

export type Tokenizer = (text: string) => number;

/** Fallback when the target model's tokenizer is unavailable; ~4 chars/token. */
export const approxTokens: Tokenizer = (text) => Math.ceil(text.length / 4);

export async function runCandidateOnTask(options: {
  candidate: RawCandidate;
  task: Task;
  provider: ResolvedProvider;
  tokenizer?: Tokenizer;
  systemPrompt?: string;
  /** Injected transport for testing; a real run omits it and uses `provider`. */
  client?: ModelClient;
}): Promise<TaskResult> {
  const { candidate, task, provider } = options;
  const tokenizer = options.tokenizer ?? approxTokens;
  const started = Date.now();

  const dir = mkdtempSync(join(tmpdir(), `actor0-bench-${task.id}-`));
  task.setup(dir);

  const dispatcher = createDispatcher(candidate, createUnderlying({ cwd: dir, provider }));
  const toolHost: ToolHost = {
    definitions: () => dispatcher.definitions() as ToolDefinition[],
    execute: (call, signal) => dispatcher.execute(call, signal),
  };

  let answer = "";
  let usageTokens = 0;
  try {
    const outcome = await runTurn({
      model: provider,
      messages: [],
      input: task.prompt,
      toolHost,
      signal: new AbortController().signal,
      cwd: dir,
      ...(options.client ? { client: options.client } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    });
    answer = outcome.result.text;
    usageTokens = outcome.result.usage.reduce((sum, u) => sum + (u.total_tokens ?? 0), 0);
  } catch (error) {
    answer = `(turn failed: ${error instanceof Error ? error.message : String(error)})`;
  }
  const latencyMs = Date.now() - started;

  const records = dispatcher.records;
  const completed = task.success(dir, answer);
  const first = records[0];
  const firstInvalid = records.findIndex((r) => !r.schemaValid);

  const result: TaskResult = {
    candidate: candidate.id,
    taskId: task.id,
    completed,
    firstCallValid: first ? first.schemaValid : null,
    recovered: firstInvalid >= 0 ? records.slice(firstInvalid + 1).some((r) => r.schemaValid) : null,
    toolCalls: records.length,
    schemaInvalid: records.filter((r) => !r.schemaValid).length,
    semanticInvalid: records.filter((r) => r.schemaValid && !r.semanticValid && !r.unsupported).length,
    unsupported: records.filter((r) => r.unsupported).length,
    usageTokens,
    toolDefTokens: tokenizer(JSON.stringify(dispatcher.definitions())),
    latencyMs,
    answer,
  };

  rmSync(dir, { recursive: true, force: true });
  return result;
}
