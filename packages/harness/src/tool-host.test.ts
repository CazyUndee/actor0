import assert from "node:assert/strict";
import test from "node:test";
import { compositeToolHost, namespacedToolHost } from "./tool-host.js";
import type { ToolCall, ToolDefinition, ToolHost } from "./types.js";

const signal = new AbortController().signal;
const call = (name: string): ToolCall => ({
  id: "1",
  type: "function",
  function: { name, arguments: "{}" },
});
const tool = (name: string): ToolDefinition => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters: { type: "object" } },
});
/** A host over `names` that records each name it is asked to run. */
const host = (names: string[], ran: string[] = []): ToolHost => ({
  definitions: () => names.map(tool),
  async execute(c: ToolCall) {
    ran.push(c.function.name);
    return `${c.function.name} ran`;
  },
});

test("namespacedToolHost prefixes every tool name and strips it back on the way in", async () => {
  const ran: string[] = [];
  const ns = namespacedToolHost("fs__", host(["read", "write"], ran));
  assert.deepEqual(
    ns.definitions().map((d) => d.function.name),
    ["fs__read", "fs__write"],
  );
  // The call carries the prefix; the wrapped host must see the bare name, or it
  // would be looking for a tool it does not have.
  const out = await ns.execute(call("fs__read"), signal);
  assert.equal(out, "read ran");
  assert.deepEqual(ran, ["read"], "the prefix is stripped before the call reaches the host");
});

test("namespacedToolHost refuses a call from outside its namespace", async () => {
  const ns = namespacedToolHost("fs__", host(["read"]));
  await assert.rejects(() => ns.execute(call("other__read"), signal), /not in the "fs__" namespace/);
});

test("compositeToolHost merges definitions and routes each call to its owner", async () => {
  const ran: string[] = [];
  const composite = compositeToolHost([host(["read", "write"], ran), host(["grep"], ran)]);
  assert.deepEqual(
    composite.definitions().map((d) => d.function.name),
    ["read", "write", "grep"],
  );
  assert.equal(await composite.execute(call("grep"), signal), "grep ran");
  assert.equal(await composite.execute(call("write"), signal), "write ran");
  assert.deepEqual(ran, ["grep", "write"], "each call reached only its own host");
});

test("compositeToolHost names every tool when a call matches none", async () => {
  const composite = compositeToolHost([host(["read"]), host(["grep"])]);
  await assert.rejects(
    () => composite.execute(call("nope"), signal),
    /unknown tool "nope".*read.*grep/s,
  );
});
