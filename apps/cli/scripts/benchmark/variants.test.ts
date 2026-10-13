import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGroupedCandidate, variantId } from "./variants.js";
import { CANDIDATE_C, CANDIDATE_C2, schemaHash } from "./candidates.js";

/**
 * The variant search space: the knobs reproduce the known points exactly (so
 * the loop compares like-for-like) and change only what they claim to.
 */

test("desc=none+pool=full reproduces C exactly", () => {
  const c = buildGroupedCandidate({ desc: "none", pool: "full" });
  assert.deepEqual(c.tools, CANDIDATE_C.tools);
  assert.equal(schemaHash(c), schemaHash(CANDIDATE_C));
});

test("desc=full+pool=full reproduces C2 exactly", () => {
  const c2 = buildGroupedCandidate({ desc: "full", pool: "full" });
  assert.deepEqual(c2.tools, CANDIDATE_C2.tools);
  assert.equal(schemaHash(c2), schemaHash(CANDIDATE_C2));
});

test("desc=required spells out required args and nothing else changes the pool", () => {
  const v = buildGroupedCandidate({ desc: "required", pool: "full" });
  // Same schemas as C; only descriptions differ.
  assert.deepEqual(v.tools.map((t) => t.input_schema), CANDIDATE_C.tools.map((t) => t.input_schema));
  const inspect = v.tools.find((t) => t.name === "inspect")!;
  assert.match(inspect.description, /grep→pattern/);
  assert.match(inspect.description, /index→query/);
  assert.equal(variantId({ desc: "required", pool: "full" }), "g-required-full");
});

test("pool=trimmed drops the rarely-used fields and changes no descriptions", () => {
  const v = buildGroupedCandidate({ desc: "none", pool: "trimmed" });
  const inspect = v.tools.find((t) => t.name === "inspect")!;
  const props = inspect.input_schema.properties as Record<string, unknown>;
  assert.equal(props.offset, undefined, "offset dropped");
  assert.equal(props.literal, undefined, "literal dropped");
  assert.equal(props.depth, undefined, "depth dropped");
  assert.ok(props.pattern, "pattern kept");
  assert.ok(props.op, "op kept");
  // Descriptions unchanged from C.
  assert.equal(inspect.description, CANDIDATE_C.tools.find((t) => t.name === "inspect")!.description);
});
