import type { ToolCall, ToolDefinition, ToolHost, ToolResult } from "@actor0/harness";
import { loadSkills, findSkill, renderSkill } from "../skills.js";
import { editDefinition, runEdit } from "./edit.js";
import { globDefinition, runGlob } from "./glob.js";
import { readDefinition, runRead } from "./read.js";
import { rgDefinition, runRg } from "./rg.js";
import { shellDefinition, runShell } from "./shell.js";
import { taskDefinition, runTask } from "./task.js";
import { webSearchDefinition } from "./web-search-tool.js";
import { writeDefinition, runWrite } from "./write.js";
import type { ToolContext } from "./context.js";

/**
 * The tool registry.
 *
 * Adding a tool touches four places, and three of them are tripwires that fail
 * silently if missed:
 *
 *  1. the `TOOLS` array below — and its order *is* the order the unknown-tool
 *     error lists, so the error is built from the array and never hand-written;
 *  2. `TOOL_COUNT`, which the system prompt interpolates, so a new tool changes
 *     the "N tools" sentence automatically;
 *  3. `toolChoiceSentence()`, the prompt's one-line-per-tool routing guide,
 *     which is generated from the same array — a tool the prompt never mentions
 *     is a tool the model does not reach for, and nothing fails when it is
 *     missing;
 *  4. the tool's own description, which is the contract the model reads.
 *
 * The registry used to be three hand-written lists that drifted apart — a
 * prompt that named four tools after a fifth existed, an error that offered a
 * tool set the host did not have. Deriving 2 and 3 from 1 is what makes that
 * class of bug impossible rather than merely unlikely.
 *
 * There is no approval gate here, deliberately: every command and every write
 * needing a keypress produced a user pressing `y` without reading, and a prompt
 * that is always approved is not a control. What contains the agent instead is
 * the containment check on writes (see `within.ts`), the output caps, and a
 * prompt that states the blast radius plainly.
 */

type HostTool = {
  definition: ToolDefinition;
  /** What the tool is for, in one clause, for the prompt's routing sentence. */
  hint: string;
  /** One line for the activity line in the transcript. */
  label: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

/** Parse a call's argument blob, refusing anything that is not a JSON object. */
function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid arguments for ${call.function.name}: ${(error as Error).message}`);
  }
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

const readTool: HostTool = {
  definition: readDefinition,
  hint: "reading a file's contents",
  label: (args) => `read ${str(args, "path")}`,
  run: runRead,
};

const writeTool: HostTool = {
  definition: writeDefinition,
  hint: "creating or overwriting a file",
  label: (args) => `write ${str(args, "path")}`,
  run: runWrite,
};

const editTool: HostTool = {
  definition: editDefinition,
  hint: "replacing an exact string in a file",
  label: (args) => `edit ${str(args, "path")}`,
  run: runEdit,
};

const globTool: HostTool = {
  definition: globDefinition,
  hint: "finding files by name",
  label: (args) => (str(args, "pattern") ? `glob ${str(args, "pattern")}` : `glob ${str(args, "path") || "."}`),
  run: runGlob,
};

const rgTool: HostTool = {
  definition: rgDefinition,
  hint: "searching file contents with ripgrep",
  label: (args) => `rg ${str(args, "pattern")}`,
  run: runRg,
};

const shellTool: HostTool = {
  definition: shellDefinition,
  hint: "running a shell command (builds, tests, git, package managers)",
  label: (args) => str(args, "command").replace(/\s+/g, " ").trim(),
  run: runShell,
};

const taskTool: HostTool = {
  definition: taskDefinition,
  hint: "delegating a self-contained subtask to a sub-agent",
  label: (args) => (str(args, "description").trim() ? `task: ${str(args, "description").trim()}` : "task"),
  run: runTask,
};

const skillTool: HostTool = {
  definition: {
    type: "function",
    function: {
      name: "skill",
      description:
        "Load a skill's instructions by name. Skills are reusable playbooks; the system prompt lists their names and one-line descriptions, and this returns the full body to follow. Pass args to fill $ARGUMENTS in the body. Use it when a listed skill matches the task.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill's name, exactly as listed in the prompt." },
          args: { type: "string", description: "Optional text substituted for $ARGUMENTS in the skill body." },
        },
        required: ["name"],
      },
    },
  },
  hint: "loading a reusable skill's instructions on demand",
  label: (args) => `skill ${str(args, "name").trim()}`,
  async run(args, ctx) {
    const name = str(args, "name");
    if (!name.trim()) throw new Error('missing required string parameter "name"');
    const skillArgs = typeof args.args === "string" ? args.args : undefined;
    const { skills } = loadSkills(ctx.cwd);
    const found = findSkill(skills, name);
    if (!found.ok) {
      if (found.reason === "ambiguous") {
        throw new Error(`the skill "${name}" is ambiguous — ${(found.paths ?? []).join(", ")} all claim that name; rename one so it is unique`);
      }
      if (found.reason === "disabled") {
        throw new Error(`the "${name}" skill is not available to the model (disable-model-invocation)`);
      }
      const available = found.names.length > 0 ? found.names.join(", ") : "none";
      throw new Error(`no skill named "${name}". Available: ${available}`);
    }
    return renderSkill(found.skill, skillArgs);
  },
};

const webSearchTool: HostTool = {
  definition: webSearchDefinition,
  hint: "searching the web for current information",
  label: (args) => `web search: ${str(args, "query")}`,
  run: (args, ctx) => import("./web-search-tool.js").then((module) => module.runWebSearch(args, ctx)),
};

export const TOOLS: HostTool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  rgTool,
  shellTool,
  taskTool,
  skillTool,
  webSearchTool,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.function.name, tool]));

/** How many tools the prompt should say there are. */
export const TOOL_COUNT = TOOLS.length;

/** The prompt's routing sentence: one clause per tool, generated. */
export function toolChoiceSentence(): string {
  const parts = TOOLS.map((tool) => `${tool.definition.function.name} — ${tool.hint}`);
  return `Choose the right tool for the step: ${parts.join("; ")}.`;
}

/** The verb shown on the activity line, with the target beside it. */
export function toolLabel(name: string): string {
  switch (name) {
    case "shell":
      return "$";
    case "rg":
      return "rg";
    default:
      return name;
  }
}

/** A short, readable description of what a call is about to touch. */
export function describeCall(call: ToolCall): string {
  const args = (() => {
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || "{}");
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  // `command` is a whole command line, so it is collapsed to one line: a
  // multi-line script printed into a transcript wraps and pushes the composer
  // off the bottom, and the first line is what identifies it.
  const command = args.command;
  if (typeof command === "string" && command) return command.replace(/\s+/g, " ").trim();
  for (const key of ["path", "file", "target", "pattern", "query", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** A `ToolHost` over this registry, bound to one working directory. */
export function createToolHost(options: { cwd: string; bridge: ToolContext["bridge"]; taskDelegate?: ToolContext["taskDelegate"] }): ToolHost {
  return {
    definitions: () => TOOLS.map((tool) => tool.definition),
    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult<unknown>> {
      const tool = BY_NAME.get(call.function.name);
      if (!tool) {
        throw new Error(`unknown tool "${call.function.name}". Available: ${[...BY_NAME.keys()].join(", ")}`);
      }
      const args = parseArgs(call);
      if (signal.aborted) throw new Error("cancelled before the tool ran");
      const text = await tool.run(args, {
        cwd: options.cwd,
        signal,
        bridge: options.bridge,
        ...(options.taskDelegate ? { taskDelegate: options.taskDelegate } : {}),
      });
      return { data: text, text };
    },
  };
}
