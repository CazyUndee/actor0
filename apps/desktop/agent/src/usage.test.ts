import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readUsage, recordUsage } from "./usage.js";

/**
 * The usage log against hostile lines.
 *
 * usage.jsonl is local state any process can write (same directory as the
 * session files build 115 audited). The old validator accepted anything
 * `typeof number`, so a hand-edited line could carry Infinity (rendered as
 * nonsense in the panel), negatives (silently subtracting from the meter), and
 * an unbounded model string (riding the wire and the aggregator's map). These
 * tests pin the extended corrupt-line contract: hostile values drop like torn
 * writes, honest ones survive.
 */
let dir: string;
let saved: string | undefined;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-usage-hostile-"));
  saved = process.env.ACTOR0_DATA_DIR;
  process.env.ACTOR0_DATA_DIR = dir;
});

after(() => {
  if (saved === undefined) delete process.env.ACTOR0_DATA_DIR;
  else process.env.ACTOR0_DATA_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("hostile usage lines", () => {
  it("drops Infinity, negatives, oversized values, and unbounded model strings", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "usage.jsonl"),
      [
        JSON.stringify({ t: 0, model: "good", prompt: 0, completion: 0, total: 5 }),
        '{"t":1e999,"model":"m","prompt":1,"completion":1,"total":1e999}',       // Infinity
        '{"t":-5,"model":"neg","prompt":-1,"completion":-1,"total":-7}',          // negative t + totals
        JSON.stringify({ t: 1, model: "M".repeat(10_000), prompt: 1, completion: 1, total: 1 }), // huge model string
        JSON.stringify({ t: 1, model: "huge", prompt: 1, completion: 1, total: 1e20 }), // above any real turn
        "{ torn",
        "",
      ].join("\n") + "\n",
      "utf8",
    );
    const entries = readUsage();
    assert.equal(entries.length, 1, "only the honest line survives");
    assert.equal(entries[0]!.model, "good");
    assert.equal(entries[0]!.total, 5);
  });

  it("an honest logged turn still round-trips through readUsage", () => {
    mkdirSync(dir, { recursive: true });
    recordUsage("test-model", { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    const entry = readUsage().find((e) => e.model === "test-model");
    assert.ok(entry, "the freshly logged turn survives");
    assert.equal(entry.total, 7);
  });
});
