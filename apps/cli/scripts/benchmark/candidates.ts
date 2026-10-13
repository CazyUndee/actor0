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
export type CandidateId = "A" | "B" | "C" | "D" | "C2" | "E" | (string & {});

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

export const C_TOOLS: RawTool[] = [
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

/**
 * Candidate C2: C's grouped tools with each op's required arguments spelled out
 * in the tool description. A hardening of C aimed squarely at first-call
 * validity — the model is told, up front, that `grep` needs `pattern` and
 * `write` needs `content` — while keeping the grouping that beat D and the
 * cheap permissive field pool. Same dispatcher path as C.
 */
const C2_DESCRIPTIONS: Record<string, string> = {
  inspect:
    "Read-only local inspection. Pick op and supply that op's argument: read→path; grep→pattern (optional path, glob); glob→pattern (optional path); tree→path, depth (both optional); index→query; skill→name.",
  modify:
    "Change one file. Pick op and supply that op's arguments: write→path + content; edit→path + old + new (optional all); delete→path.",
  web: "Search the web or fetch a URL. op=search→query (optional limit); op=fetch→url.",
};
const C2_TOOLS: RawTool[] = C_TOOLS.map((tool) => ({
  ...tool,
  description: C2_DESCRIPTIONS[tool.name] ?? tool.description,
}));
export const CANDIDATE_C2: RawCandidate = { id: "C2", label: "grouped tools, hardened descriptions", tools: C2_TOOLS };

// --- Candidate E: small eager set + searchable catalog (Codex tool_search) --

/**
 * Candidate E: the deferred-tool-discovery pattern, adapted from Codex.
 *
 * A small eager set (the ops a coding turn reaches for constantly) is sent up
 * front; everything else lives in a catalog reachable only through
 * `find_tool(query)`, which returns the matching tool's full definition as text
 * for the model to call next turn. Codex instead uses the Responses API's
 * `defer_loading`; our provider has no such feature, so the definition is
 * returned as text — an extra round trip this candidate is measured on.
 */
const E_EAGER = ["read", "grep", "edit", "write"];
const E_CATALOG: RawTool[] = [
  {
    name: "glob",
    description: "Find files matching a glob pattern, e.g. \"**/*.test.ts\". Use to locate files by name.",
    input_schema: obj({ pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
  },
  {
    name: "shell",
    description: "Run a shell command in the workspace. Each call starts a fresh process. Optional timeout in seconds.",
    input_schema: obj({ command: { type: "string" }, timeout: { type: "integer" } }, ["command"]),
  },
  {
    name: "tree",
    description: "Show the repository directory tree, up to `depth` levels (default 3). Use to understand project layout.",
    input_schema: obj({ path: { type: "string" }, depth: { type: "integer" } }, []),
  },
  {
    name: "index",
    description: "Search the repository file index by name or path substring. Use to find where something lives.",
    input_schema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "skill",
    description: "Load a reusable skill by name, returning its instructions.",
    input_schema: obj({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "web_search",
    description: "Search the web and return ranked results with titles, URLs and snippets.",
    input_schema: obj({ query: { type: "string" }, limit: { type: "integer" } }, ["query"]),
  },
  {
    name: "fetch",
    description: "Fetch a URL and return its content as clean markdown for reading.",
    input_schema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "delegate",
    description: "Delegate a self-contained task to a subagent and return its result.",
    input_schema: obj({ task: { type: "string" } }, ["task"]),
  },
  {
    name: "read",
    description: "Read a text file. Lines are 1-based; offset and limit select a range.",
    input_schema: obj({ path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, ["path"]),
  },
  {
    name: "grep",
    description: "Search file contents with a regular expression or literal text; returns paths, lines, or counts.",
    input_schema: obj({ pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, literal: { type: "boolean" } }, ["pattern"]),
  },
  {
    name: "write",
    description: "Create a file or replace its entire contents with the given content.",
    input_schema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  },
  {
    name: "edit",
    description: "Replace exact text in an existing file. old must match uniquely unless all is true.",
    input_schema: obj({ path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, ["path", "old", "new"]),
  },
];
/** The single source of truth for a tool's spec; fails loudly rather than
 *  yielding `undefined` into the eager set. */
const specOf = (name: string): RawTool => {
  const spec = E_CATALOG.find((tool) => tool.name === name);
  if (!spec) throw new Error(`no tool spec for "${name}" in the E catalog`);
  return spec;
};
const E_TOOLS: RawTool[] = [
  ...E_EAGER.map((name) => specOf(name)),
  {
    name: "find_tool",
    description:
      "Search the tool catalog by what you want to do (e.g. \"run a command\", \"find files by name\", "
      + "\"search the web\"). Returns the matching tools' full definitions, then call the one you need.",
    input_schema: obj({ query: { type: "string" }, limit: { type: "integer" } }, ["query"]),
  },
];
export const CANDIDATE_E: RawCandidate = { id: "E", label: "small eager set + searchable catalog", tools: E_TOOLS };

/**
 * Build an E-family candidate with a chosen eager set. Exported so the loop can
 * search the eager/deferred boundary — the presets in variants.ts call this.
 */
export function buildCatalogCandidate(id: string, eagerNames: string[], label?: string): RawCandidate {
  const tools: RawTool[] = [
    ...eagerNames.map((name) => specOf(name)),
    {
      name: "find_tool",
      description:
        "Search the tool catalog by what you want to do (e.g. \"run a command\", \"find files by name\", "
        + "\"search the web\"). Returns the matching tools' full definitions, then call the one you need.",
      input_schema: obj({ query: { type: "string" }, limit: { type: "integer" } }, ["query"]),
    },
  ];
  return { id, label: label ?? `catalog, eager=[${eagerNames.join(",")}]`, tools };
}

/** The deferred catalog candidate E searches, exported for the dispatcher.
 *  Every operation is in it, including the eager ones: Codex's tool_search can
 *  surface any tool, and a model that forgets an eager tool mid-task must be
 *  able to rediscover it. */
export const E_CATALOG_TOOLS: RawTool[] = [...new Map(E_CATALOG.map((tool) => [tool.name, tool])).values()];

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
