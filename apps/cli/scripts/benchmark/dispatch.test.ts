import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@actor0/harness";
import { CANDIDATE_B, CANDIDATE_C, CANDIDATE_D, captureCandidateA, schemaHash } from "./candidates.js";
import { createDispatcher, type CallRecord } from "./dispatch.js";
import { createUnderlying } from "./underlying.js";

/**
 * The dispatcher: each candidate routes a call to the same underlying
 * operation, recording schema validity and semantic validity separately, and
 * never filling a missing required argument. Deterministic — no model.
 */

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "t",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const withWorkspace = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-bench-"));
  writeFileSync(join(dir, "note.txt"), "alpha\nbeta\ngamma\n");
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const run = async (candidateId: "A" | "B" | "C" | "D", dir: string, c: ToolCall): Promise<{ output: string; record: CallRecord }> => {
  const candidate = candidateId === "A" ? captureCandidateA(dir) : candidateId === "B" ? CANDIDATE_B : candidateId === "C" ? CANDIDATE_C : CANDIDATE_D;
  const dispatcher = createDispatcher(candidate, createUnderlying({ cwd: dir }));
  const output = await dispatcher.execute(c, new AbortController().signal);
  return { output, record: dispatcher.records[dispatcher.records.length - 1]! };
};

test("candidate schemas are stable and hashed", () => {
  // A is captured from production; B/C/D are the fixed experimental schemas.
  assert.ok(captureCandidateA(process.cwd()).tools.length > 0, "A captures production tools");
  assert.equal(CANDIDATE_B.tools.length, 13);
  assert.equal(CANDIDATE_C.tools.length, 5);
  assert.equal(CANDIDATE_D.tools.length, 1);
  assert.equal(typeof schemaHash(CANDIDATE_D), "string");
  assert.equal(schemaHash(CANDIDATE_D).length, 16);
});

test("candidate A routes a production tool and validates required args", async () => {
  await withWorkspace(async (dir) => {
    const ok = await run("A", dir, call("read", { path: "note.txt" }));
    assert.equal(ok.record.schemaValid, true);
    assert.equal(ok.record.semanticValid, true);
    assert.equal(ok.record.op, "read");
    assert.match(ok.output, /alpha/);

    const missing = await run("A", dir, call("read", {}));
    assert.equal(missing.record.schemaValid, false, "a missing path is a schema failure, not filled");
    assert.equal(missing.record.semanticValid, false);

    const unknown = await run("A", dir, call("nonsense", {}));
    assert.equal(unknown.record.schemaValid, false);
  });
});

test("candidate B is strict: unknown fields are schema-invalid", async () => {
  await withWorkspace(async (dir) => {
    const ok = await run("B", dir, call("grep", { pattern: "beta" }));
    assert.equal(ok.record.schemaValid, true);
    assert.equal(ok.record.semanticValid, true);
    assert.equal(ok.record.op, "grep");

    const extra = await run("B", dir, call("read", { path: "note.txt", bogus: 1 }));
    assert.equal(extra.record.schemaValid, false, "additionalProperties:false is enforced");
    assert.match(extra.record.error ?? "", /unknown field "bogus"/);

    const missing = await run("B", dir, call("write", { path: "x.txt" }));
    assert.equal(missing.record.schemaValid, false, "content is required and not filled");
  });
});

test("candidate C is permissive but the dispatcher enforces op-specific required fields", async () => {
  await withWorkspace(async (dir) => {
    const ok = await run("C", dir, call("inspect", { op: "read", path: "note.txt" }));
    assert.equal(ok.record.schemaValid, true);
    assert.equal(ok.record.op, "read");
    assert.match(ok.output, /beta/);

    const badOp = await run("C", dir, call("inspect", { op: "write", path: "x" }));
    assert.equal(badOp.record.schemaValid, false, "write is not an inspect op");
    assert.match(badOp.record.error ?? "", /inspect needs op/);

    const missing = await run("C", dir, call("modify", { op: "write", path: "x.txt" }));
    assert.equal(missing.record.schemaValid, false, "content is enforced by the dispatcher for modify/write");
    assert.match(missing.record.error ?? "", /missing required "content"/);

    // C's permissive pool means an extra field is NOT rejected.
    const permissive = await run("C", dir, call("inspect", { op: "read", path: "note.txt", limit: 5 }));
    assert.equal(permissive.record.schemaValid, true, "C keeps its permissive field pool");
  });
});

test("candidate D validates the oneOf branch: op, required fields, and no extras", async () => {
  await withWorkspace(async (dir) => {
    const ok = await run("D", dir, call("act", { op: "read", path: "note.txt" }));
    assert.equal(ok.record.schemaValid, true);
    assert.equal(ok.record.op, "read");
    assert.match(ok.output, /gamma/);

    const badOp = await run("D", dir, call("act", { op: "launch" }));
    assert.equal(badOp.record.schemaValid, false, "an op outside the oneOf is invalid");
    assert.match(badOp.record.error ?? "", /not a known operation/);

    const missing = await run("D", dir, call("act", { op: "write", path: "x.txt" }));
    assert.equal(missing.record.schemaValid, false, "the write branch requires content");

    const extra = await run("D", dir, call("act", { op: "read", path: "note.txt", command: "rm" }));
    assert.equal(extra.record.schemaValid, false, "a field outside the branch is invalid");
    assert.match(extra.record.error ?? "", /unknown field "command"/);
  });
});

test("delete is a real, well-formed operation Actor0 cannot perform — recorded unsupported, not invented", async () => {
  await withWorkspace(async (dir) => {
    const b = await run("B", dir, call("delete", { path: "note.txt" }));
    assert.equal(b.record.schemaValid, true, "the call is well-formed");
    assert.equal(b.record.unsupported, true, "but the capability is unsupported");
    assert.equal(b.record.semanticValid, false);

    const d = await run("D", dir, call("act", { op: "delete", path: "note.txt" }));
    assert.equal(d.record.unsupported, true);
    assert.match(d.output, /not a capability/);
  });
});
