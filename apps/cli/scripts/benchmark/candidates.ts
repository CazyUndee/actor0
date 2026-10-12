import { createHash } from "node:crypto";
import { createToolHost } from "../../src/tools.js";

/**
 * The four tool-interface candidates, defined explicitly.
 *
 * Each candidate is a set of tool definitions (Anthropic-style `input_schema`,
 * converted to the provider's OpenAI-compatible `parameters` on the way out).
 * Candidate A is captured from production at startup — never hand-copied, and
 * production is never changed to make it competitive. B, C and D are the exact
 * schemas from the benchmark specification, verbatim: C keeps its permissive
 * field pool (no conditional tightening), D keeps its real `oneOf`/`const`
 * union (never flattened into C's shape).
 *
 * These schemas are experimental and live only here — they are never wired into
 * Actor0's production tool host.
 */

export type JsonSchema = Record<string, unknown>;
export type RawTool = { name: string; description: string; input_schema: JsonSchema };
export type RawCandidate = { id: CandidateId; label: string; tools: RawTool[] };
export type CandidateId = "A" | "B" | "C" | "D";

/** The provider's structured tool-calling representation. */
export type OpenAiTool = {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
};

const obj = (properties: JsonSchema, required: string[], extra: JsonSchema = {}): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...extra,
});

// --- Candidate B: flat specialised tools (verbatim from the spec) ----------

const B_TOOLS: RawTool[] = [
  {
    name: "read",
    description: "Read a text file. Lines are 1-based; use offset and limit to select a range.",
    input_schema: obj(
      {
        path: { type: "string" },
        offset: { type: "integer", description: "First line, default 1" },
        limit: { type: "integer", description: "Maximum lines to return" },
      },
      ["path"],
    ),
  },
  {
    name: "grep",
    description: "Search file contents using a regex or literal pattern.",
    input_schema: obj(
      {
        pattern: { type: "string" },
        path: { type: "string", description: "File or directory, default workspace root" },
        glob: { type: "string", description: "Optional file-matching glob" },
        literal: { type: "boolean", description: "Treat pattern as literal text" },
      },
      ["pattern"],
    ),
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    input_schema: obj(
      { pattern: { type: "string" }, path: { type: "string", description: "Base directory, default workspace root" } },
      ["pattern"],
    ),
  },
  {
    name: "tree",
    description: "Show the directory tree.",
    input_schema: obj(
      { path: { type: "string", description: "Directory, default workspace root" }, depth: { type: "integer", description: "Maximum depth, default 2" } },
      [],
    ),
  },
  {
    name: "index",
    description: "Query the repository index.",
    input_schema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "skill",
    description: "Load a skill by name.",
    input_schema: obj({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "web_search",
    description: "Search the web and return relevant results.",
    input_schema: obj({ query: { type: "string" }, limit: { type: "integer", description: "Maximum results" } }, ["query"]),
  },
  {
    name: "fetch",
    description: "Fetch a URL and return its content as text.",
    input_schema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "write",
    description: "Create a file or replace its entire contents.",
    input_schema: obj({ path: { type: "string" }, content: { type: "string", description: "Exact file contents" } }, ["path", "content"]),
  },
  {
    name: "edit",
    description: "Replace exact text in an existing file.",
    input_schema: obj(
      {
        path: { type: "string" },
        old: { type: "string", description: "Exact existing text" },
        new: { type: "string", description: "Replacement text" },
        all: { type: "boolean", description: "Replace all matches instead of requiring a unique match" },
      },
      ["path", "old", "new"],
    ),
  },
  {
    name: "delete",
    description: "Delete a file or directory.",
    input_schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "shell",
    description: "Run a shell command in the workspace. Each call starts a fresh process.",
    input_schema: obj({ command: { type: "string" }, timeout: { type: "integer", description: "Timeout in seconds, default 120" } }, ["command"]),
  },
  {
    name: "delegate",
    description: "Delegate a self-contained task to a subagent and return its result.",
    input_schema: obj({ task: { type: "string" } }, ["task"]),
  },
];

// --- Candidate C: five tools grouped by effect class (verbatim, permissive) -

const C_TOOLS: RawTool[] = [
  {
    name: "inspect",
    description: "Perform a read-only local inspection. Choose an operation using op.",
    input_schema: obj(
      {
        op: { type: "string", enum: ["read", "grep", "glob", "tree", "index", "skill"] },
        path: { type: "string" },
        pattern: { type: "string" },
        glob: { type: "string" },
        query: { type: "string" },
        name: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
        depth: { type: "integer" },
        literal: { type: "boolean" },
      },
      ["op"],
    ),
  },
  {
    name: "modify",
    description: "Create, replace, edit, or delete files. Choose an operation using op.",
    input_schema: obj(
      {
        op: { type: "string", enum: ["write", "edit", "delete"] },
        path: { type: "string" },
        content: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
        all: { type: "boolean" },
      },
      ["op", "path"],
    ),
  },
  {
    name: "shell",
    description: "Execute a shell command.",
    input_schema: obj({ command: { type: "string" }, timeout: { type: "integer" } }, ["command"]),
  },
  {
    name: "web",
    description: "Search the web or fetch a URL. Choose an operation using op.",
    input_schema: obj(
      { op: { type: "string", enum: ["search", "fetch"] }, query: { type: "string" }, url: { type: "string" }, limit: { type: "integer" } },
      ["op"],
    ),
  },
  {
    name: "delegate",
    description: "Delegate a task to a subagent.",
    input_schema: obj({ task: { type: "string" } }, ["task"]),
  },
];

// --- Candidate D: one universal `act` tool with a real oneOf union ---------

const branch = (op: string, properties: JsonSchema, required: string[]): JsonSchema =>
  obj({ op: { const: op }, ...properties }, ["op", ...required]);

const D_TOOLS: RawTool[] = [
  {
    name: "act",
    description: "Perform exactly one operation. Choose op and provide that operation's arguments.",
    input_schema: {
      type: "object",
      oneOf: [
        branch("read", { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, ["path"]),
        branch("grep", { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, literal: { type: "boolean" } }, ["pattern"]),
        branch("glob", { pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
        branch("tree", { path: { type: "string" }, depth: { type: "integer" } }, []),
        branch("index", { query: { type: "string" } }, ["query"]),
        branch("skill", { name: { type: "string" } }, ["name"]),
        branch("web_search", { query: { type: "string" }, limit: { type: "integer" } }, ["query"]),
        branch("fetch", { url: { type: "string" } }, ["url"]),
        branch("write", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
        branch("edit", { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, ["path", "old", "new"]),
        branch("delete", { path: { type: "string" } }, ["path"]),
        branch("shell", { command: { type: "string" }, timeout: { type: "integer" } }, ["command"]),
        branch("delegate", { task: { type: "string" } }, ["task"]),
      ],
    },
  },
];

// --- Candidate A: captured from production at startup ----------------------

export function captureCandidateA(cwd: string): RawCandidate {
  const definitions = createToolHost({ cwd }).definitions();
  const tools: RawTool[] = definitions.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    input_schema: d.function.parameters as JsonSchema,
  }));
  return { id: "A", label: "current production interface", tools };
}

export const CANDIDATE_B: RawCandidate = { id: "B", label: "flat specialised tools", tools: B_TOOLS };
export const CANDIDATE_C: RawCandidate = { id: "C", label: "five tools grouped by effect class", tools: C_TOOLS };
export const CANDIDATE_D: RawCandidate = { id: "D", label: "one universal structured action tool", tools: D_TOOLS };

/** Convert a candidate's Anthropic-style schemas to the provider's tool format. */
export function toOpenAiTools(candidate: RawCandidate): OpenAiTool[] {
  return candidate.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

/** A stable version hash of a candidate's exact schemas, recorded in every result. */
export function schemaHash(candidate: RawCandidate): string {
  const canonical = JSON.stringify(
    candidate.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The operation names a candidate exposes, for capability documentation. */
export function exposedOperations(candidate: RawCandidate): string[] {
  const ops: string[] = [];
  for (const tool of candidate.tools) {
    const schema = tool.input_schema;
    if (Array.isArray(schema.oneOf)) {
      for (const b of schema.oneOf as JsonSchema[]) {
        const op = (b.properties as JsonSchema)?.op as JsonSchema | undefined;
        if (op?.const) ops.push(String(op.const));
      }
    } else if ((schema.properties as JsonSchema)?.op) {
      const opSchema = (schema.properties as JsonSchema).op as JsonSchema;
      for (const value of (opSchema.enum as string[]) ?? []) ops.push(value);
    } else {
      ops.push(tool.name);
    }
  }
  return ops;
}
