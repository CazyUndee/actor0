import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@actor0/harness";
import { CANDIDATE_E, E_CATALOG_TOOLS, schemaHash, toOpenAiTools } from "./candidates.js";
import { searchCatalog, toolSearchText } from "./catalog.js";
import { createDispatcher } from "./dispatch.js";
import { createUnderlying } from "./underlying.js";

/**
 * Candidate E: the Codex deferred-tool-discovery pattern, adapted for a
 * provider with no `defer_loading`. A small eager set plus `find_tool`, which
 * returns a catalog tool's full definition as text for the model to call next.
 */

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "t",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("E advertises a small eager set plus find_tool", () => {
  const names = CANDIDATE_E.tools.map((t) => t.name);
  assert.deepEqual(names, ["read", "grep", "edit", "write", "find_tool"]);
  assert.ok(CANDIDATE_E.tools.length < 6, "the eager set stays small");
});

test("toolSearchText includes the name, spaced name, description and field names", () => {
  const text = toolSearchText({
    name: "web_search",
    description: "Search the web and return ranked results.",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } },
  });
  for (const term of ["web_search", "web search", "query", "limit", "ranked results"]) {
    assert.ok(text.includes(term), `search text should contain "${term}"`);
  }
});

test("searchCatalog ranks the tool a query names above incidental field matches", () => {
  const shell = searchCatalog(E_CATALOG_TOOLS, "run a command", 3);
  assert.equal(shell[0]!.name, "shell", "naming the action should surface shell first");
  assert.equal(searchCatalog(E_CATALOG_TOOLS, "search the web", 1)[0]!.name, "web_search");
  assert.equal(searchCatalog(E_CATALOG_TOOLS, "find files by name", 1)[0]!.name, "glob");
});

test("find_tool returns a callable definition, and the returned tool then runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-e-"));
  writeFileSync(join(dir, "a.txt"), "hit\nmiss\nhit\n");
  const dispatcher = createDispatcher(CANDIDATE_E, createUnderlying({ cwd: dir }));
  const signal = new AbortController().signal;

  const discovery = await dispatcher.execute(call("find_tool", { query: "search file contents" }), signal);
  assert.match(discovery, /tool: grep/, "find_tool returns the definition as text");
  assert.match(discovery, /arguments \(JSON\)/, "the schema is included so the model can call it");

  // The discovered tool is then called through the same dispatcher, normally.
  const result = await dispatcher.execute(call("grep", { pattern: "hit" }), signal);
  assert.match(result, /a\.txt/);
  rmSync(dir, { recursive: true, force: true });
});

test("an eager tool needs no discovery; find_tool enforces its query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-e-"));
  const dispatcher = createDispatcher(CANDIDATE_E, createUnderlying({ cwd: dir }));
  const signal = new AbortController().signal;
  await dispatcher.execute(call("find_tool", {}), signal);
  assert.equal(dispatcher.records.at(-1)!.schemaValid, false, "find_tool without a query is a schema failure");
  rmSync(dir, { recursive: true, force: true });
});

test("E's tool-definition tokens are the lowest of the realistic candidates", async () => {
  const { approxTokens } = await import("./runner.js");
  const { CANDIDATE_C, CANDIDATE_C2 } = await import("./candidates.js");
  const tok = (c: { tools: { name: string; description: string; input_schema: unknown }[] }): number =>
    approxTokens(JSON.stringify(c.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))));
  assert.ok(tok(CANDIDATE_E) < tok(CANDIDATE_C), `E (${tok(CANDIDATE_E)}) should beat C (${tok(CANDIDATE_C)})`);
  assert.ok(tok(CANDIDATE_E) < tok(CANDIDATE_C2));
  assert.equal(schemaHash(CANDIDATE_E).length, 16);
  assert.equal(toOpenAiTools(CANDIDATE_E).length, CANDIDATE_E.tools.length);
});
