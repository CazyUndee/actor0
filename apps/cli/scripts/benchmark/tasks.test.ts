import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS } from "./tasks.js";

/**
 * Validate the task set itself — no model, no gateway: every task's setup
 * runs, an unsolved workspace fails its predicate, and a correctly-solved
 * workspace passes it. This keeps a benchmark run from being wasted on a
 * mis-specified task.
 */

const ws = (): string => mkdtempSync(join(tmpdir(), "a0-task-"));

test("every task's setup runs and an unsolved workspace fails its predicate", () => {
  for (const task of TASKS) {
    const dir = ws();
    try {
      task.setup(dir);
      assert.equal(task.success(dir, ""), false, `${task.id}: unsolved workspace must not pass`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("count-todos' workspace has exactly two TODO lines", () => {
  const task = TASKS.find((t) => t.id === "count-todos")!;
  const dir = ws();
  try {
    task.setup(dir);
    const notes = readFileSync(join(dir, "src/notes.md"), "utf8");
    const todos = notes.split("\n").filter((l) => l.includes("TODO")).length;
    assert.equal(todos, 2);
    assert.equal(task.success(dir, "2"), true);
    assert.equal(task.success(dir, "3"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a correctly-solved workspace passes each state-based task", () => {
  // rename-symbol
  {
    const task = TASKS.find((t) => t.id === "rename-symbol")!;
    const dir = ws();
    try {
      task.setup(dir);
      for (const f of ["src/index.ts", "src/math.ts"]) {
        const p = join(dir, f);
        writeFileSync(p, readFileSync(p, "utf8").replace(/computeTotal/g, "calculateTotal"));
      }
      assert.equal(task.success(dir, ""), true, "rename-symbol solved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // fix-off-by-one
  {
    const task = TASKS.find((t) => t.id === "fix-off-by-one")!;
    const dir = ws();
    try {
      task.setup(dir);
      const p = join(dir, "src/math.ts");
      writeFileSync(p, readFileSync(p, "utf8").replace("return sum + 1;", "return sum;"));
      assert.equal(task.success(dir, ""), true, "fix-off-by-one solved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // create-and-wire
  {
    const task = TASKS.find((t) => t.id === "create-and-wire")!;
    const dir = ws();
    try {
      task.setup(dir);
      writeFileSync(join(dir, "src/greet.ts"), "export function greet(name: string): string { return `Hi ${name}`; }\n");
      const idx = join(dir, "src/index.ts");
      writeFileSync(idx, "import { greet } from './greet';\nconsole.log(greet('world'));\n");
      assert.equal(task.success(dir, ""), true, "create-and-wire solved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
