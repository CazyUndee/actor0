import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openShellOs } from "./shell-os.js";

/**
 * The shell opener, and the one way it used to take the agent down.
 *
 * The agent wires this up at boot, so anything it does at construction time
 * happens on every packaged launch. It used to construct the shell's WebSocket
 * eagerly and attach its listeners only when a sign-in first asked it to open a
 * URL — so a refused connection (a stale `.tmp/auth_info.json` naming a port
 * from a previous run, the shell not up yet) emitted an `error` on a socket with
 * no listener, node treated that as unhandled, and the agent exited seconds
 * after writing port.json. The window had nothing to be but "disconnected from
 * the agent — retrying".
 *
 * So the test is about construction and refusal, not about a successful
 * `os.open` round trip: what has to hold is that neither one kills the process.
 */

let dir: string;
const saved = {
  NL_PATH: process.env.NL_PATH,
  NL_PORT: process.env.NL_PORT,
  NL_TOKEN: process.env.NL_TOKEN,
  NL_WS_PORT: process.env.NL_WS_PORT,
};

/** A port nothing is listening on: bound once, then released. */
async function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-shell-os-"));
  mkdirSync(join(dir, ".tmp"), { recursive: true });
  for (const key of Object.keys(saved) as (keyof typeof saved)[]) delete process.env[key];
  process.env.NL_PATH = dir;
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("the shell opener", () => {
  it("is undefined without a shell, so a sign-in falls back to the URL", () => {
    rmSync(join(dir, ".tmp", "auth_info.json"), { force: true });
    assert.equal(openShellOs(), undefined);
  });

  it("survives being built against a shell socket that refuses the connection", async () => {
    const port = await deadPort();
    writeFileSync(
      join(dir, ".tmp", "auth_info.json"),
      JSON.stringify({ nlPort: port, nlToken: "body.connect", nlConnectToken: "connect" }),
    );
    const opener = openShellOs();
    assert.ok(opener, "an auth file means an opener");
    // Construction alone used to be enough to kill the process: give the socket
    // a turn of the event loop to fail, exactly as a boot would.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(opener!.open("https://example.test/signin"), /the shell refused to open the browser/);
  });
});
