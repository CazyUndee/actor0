import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { nodeBridge } from "./native/bridge.js";
import { startServer } from "./server.js";

/**
 * The port file is the packaged app's handshake.
 *
 * In the packaged window mode the spawnedProcess stdout events never reach the
 * page, so the agent writes {port} to a file the page polls. These tests pin
 * that contract: written on listen, correct content, parent dirs created, and
 * a read-only location is survived rather than fatal.
 */

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-portfile-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the port file", () => {
  it("is written once the server listens, with the port and pid", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0-test" });
    const target = join(dir, "deep", "nested", "port.json");
    const server = await startServer({ agent, port: 0, portFile: target });
    try {
      const info = JSON.parse(readFileSync(target, "utf8")) as { port: number; pid: number };
      assert.equal(info.port, server.port, "the file's port must be the listening port");
      assert.equal(typeof info.pid, "number");
    } finally {
      await server.close();
      agent.dispose();
      rmSync(join(dir, "deep"), { recursive: true, force: true });
    }
  });

  it("a write failure is survived, not fatal — the agent still serves", async () => {
    const agent = new Agent({ cwd: dir, bridge: nodeBridge(), version: "0.0.0-test" });
    // A path whose parent is a *file* can never be created.
    const sentinel = join(dir, "blocker");
    rmSync(sentinel, { force: true });
    (await import("node:fs")).writeFileSync(sentinel, "x", "utf8");
    const badTarget = join(sentinel, "sub", "port.json");
    const server = await startServer({ agent, port: 0, portFile: badTarget });
    try {
      assert.ok(server.port > 0, "the server must be listening despite the portFile failure");
    } finally {
      await server.close();
      agent.dispose();
      rmSync(sentinel, { force: true });
    }
  });
});
