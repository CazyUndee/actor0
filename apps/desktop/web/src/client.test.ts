import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AgentClient, discoverAgentUrl, readLauncherEndpoint, setDiscoveredEndpoint } from "./client";

test("the packaged launcher hands its own port and token to the client together", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  const record = { port: 49152, token: "launcher-issued-fixture" };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    NL_PATH: "app",
    Neutralino: { filesystem: { readFile: async (path: string) => {
      assert.equal(path, "app/agent/port.json");
      return JSON.stringify(record);
    } } },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const endpoint = await readLauncherEndpoint();
  assert.ok(endpoint);
  setDiscoveredEndpoint(endpoint);
  assert.deepEqual(await discoverAgentUrl(), { url: "ws://127.0.0.1:49152", token: record.token });
});

test("a macOS .app reads the launcher's record from $HOME, never from the signed bundle", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  const record = { port: 49154, token: "home-file-fixture" };
  const portFile = "/Users/fixture/.actor0/agent/port.json";
  const reads: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    NL_PATH: "/Applications/actor0.app/Contents/MacOS",
    Neutralino: {
      os: { getPath: async (name: string) => {
        assert.equal(name, "home");
        return "/Users/fixture";
      } },
      filesystem: { readFile: async (path: string) => {
        reads.push(path);
        if (path === portFile) return JSON.stringify(record);
        throw new Error("ENOENT");
      } },
    },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  assert.deepEqual(await readLauncherEndpoint(), record);
  assert.deepEqual(reads, [portFile], "the app bundle must not be read when $HOME has the record");
});

test("a port-only dev launcher record does not acquire an unrelated token", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ port: 49153 }));
  assert.deepEqual(await readLauncherEndpoint(), { port: 49153 });
});

test("a failed socket handshake reports the address, not the query credential", async () => {
  // Port 1 is blocked by the WHATWG WebSocket client, so this needs no server.
  const client = new AgentClient({ url: "ws://127.0.0.1:1?token=private-fixture", reconnectDelayMs: 0 });
  await assert.rejects(client.connect(), { message: "could not reach the agent at 127.0.0.1:1" });
});
