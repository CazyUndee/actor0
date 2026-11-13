import type { FileBridge } from "../native/bridge.js";
import type { TaskRequest, TaskResult } from "./task.js";

/**
 * What a tool is allowed to reach.
 * A port, not a global: the tool registry never reads `process.cwd()` and never
 * opens a file itself, so a test drives the whole registry against a temporary
 * directory and an in-memory bridge. That is the same shape the harness uses
 * for its own dependencies, and it is why tool behaviour is verifiable without
 * a terminal, a project or a GUI.
 */
export type ToolContext = {
  cwd: string;
  signal: AbortSignal;
  /** Where file content comes from — the shell's native API, or `node:fs`. */
  bridge: FileBridge;
  /**
   * Runs a subtask in a sub-agent, when the host configured one. Read by the
   * `task` tool; absent means delegation is unavailable and the tool says so
   * rather than failing in a way the model cannot act on.
   */
  taskDelegate?: TaskDelegate;
};

export type { TaskRequest, TaskResult };

/**
 * Runs a subtask in an isolated sub-agent and returns its answer.
 *
 * A port the host supplies, so the tool registry never imports the turn runner
 * (which imports the registry back for the sub-agent's own tools).
 */
export type TaskDelegate = {
  run(request: TaskRequest, signal: AbortSignal): Promise<TaskResult>;
};
