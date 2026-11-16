import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { neutralinoBridge } from "./bridge.js";

/**
 * The Neutralino file bridge, tested against a recording fake client.
 *
 * This transport was untested from its conception until it was first engaged
 * (build: 103) — and the first live engagement immediately exposed that
 * Neutralino's IPC eats backslashes, so every OS-native Windows path the tools
 * hand the bridge arrived as `D:projects...`. These tests pin the two contracts
 * the bridge must keep with the agent's tools:
 *
 *   1. every filesystem call's path is normalised to forward slashes before it
 *      reaches the shell;
 *   2. the request shape is what the running shell actually answers (methods
 *      named `filesystem.*`, paths under `data.path`), so a rename or a wire
 *      change fails here rather than in a packaged app.
 */

type Call = { method: string; data: Record<string, unknown> };

function fakeClient() {
  const calls: Call[] = [];
  const reply: Record<string, unknown> = {
    "filesystem.readFile": "content",
    "filesystem.writeFile": undefined,
    "filesystem.createDirectory": undefined,
    "filesystem.remove": undefined,
    "filesystem.readDirectory": [],
    "filesystem.getStats": { size: 1, isFile: true, isDirectory: false },
  };
  return {
    calls,
    async call<T>(method: string, data?: unknown): Promise<T> {
      calls.push({ method, data: (data ?? {}) as Record<string, unknown> });
      return reply[method] as T;
    },
    close() {},
  };
}

describe("neutralinoBridge path normalisation", () => {
  it("converts backslash paths to forward slashes on every call", async () => {
    const client = fakeClient();
    const bridge = neutralinoBridge(client as never);
    const windows = "D:\\projects\\actor0\\file.txt";
    await bridge.readFile(windows);
    await bridge.writeFile(windows, "x");
    await bridge.createDirectory("D:\\projects\\actor0");
    await bridge.remove("D:\\projects\\actor0\\gone");
    await bridge.readDirectory("D:\\projects\\actor0");
    await bridge.getStats(windows);
    for (const call of client.calls) {
      const path = (call.data as { path?: string }).path;
      assert.ok(path, `every call carries a path (${call.method})`);
      assert.ok(!path.includes("\\"), `${call.method} sent a backslash path: ${path}`);
      assert.match(path, /^[A-Za-z]:\//);
    }
  });

  it("forwards the read window intact (pos/size reach the shell)", async () => {
    const client = fakeClient();
    const bridge = neutralinoBridge(client as never);
    await bridge.readFile("D:/big.log", { pos: 0, size: 50_000 });
    const read = client.calls[0]!;
    assert.equal(read.method, "filesystem.readFile");
    assert.equal((read.data as { pos?: number }).pos, 0);
    assert.equal((read.data as { size?: number }).size, 50_000);
  });

  it("calls the shell's own method names", async () => {
    const client = fakeClient();
    const bridge = neutralinoBridge(client as never);
    await bridge.readFile("x");
    await bridge.getStats("x");
    assert.equal(client.calls[0]!.method, "filesystem.readFile");
    assert.equal(client.calls[1]!.method, "filesystem.getStats");
  });
});
