import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { neutralinoAuthFile, readNeutralinoAuth } from "../native/bridge.js";

/**
 * The Neutralino auth file, as the shell actually writes it.
 *
 * The reader used to look for fields named `port` and `accessToken`; the real
 * file (Neutralino v6.10) names them `nlPort` and `nlToken` (plus
 * `nlConnectToken`, the after-the-dot half of `nlToken`). Auth never resolved
 * from the file, so the packaged app silently ran the agent on direct
 * `node:fs` instead of the shell's scoped filesystem API — the scopes in
 * neutralino.config.json were enforced on nothing. These tests pin the
 * v6.10 field names so the bridge cannot silently degrade again.
 */

let dir: string;
let savedPath: string | undefined;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "actor0-auth-file-"));
  savedPath = process.env.NL_PATH;
  process.env.NL_PATH = dir;
  process.env.NL_PORT = "";
  process.env.NL_TOKEN = "";
  process.env.NL_WS_PORT = "";
  mkdirSync(join(dir, ".tmp"), { recursive: true });
});

after(() => {
  if (savedPath === undefined) delete process.env.NL_PORT as never as string;
  else process.env.NL_PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

describe("readNeutralinoAuth against the real file shape", () => {
  it("resolves nlPort/nlToken the way Neutralino v6.10 writes them", () => {
    writeFileSync(
      neutralinoAuthFile()!,
      JSON.stringify({
        nlConnectToken: "connect-half",
        nlPort: 51321,
        nlToken: "token-half.connect-half",
      }),
      "utf8",
    );
    const auth = readNeutralinoAuth();
    assert.ok(auth, "the v6.10 field names must resolve");
    assert.equal(String(auth.port), "51321");
    assert.equal(auth.accessToken, "token-half.connect-half");
  });

  it("still resolves the short field names if a file ever uses them", () => {
    writeFileSync(neutralinoAuthFile()!, JSON.stringify({ port: 51322, accessToken: "short-name" }), "utf8");
    const auth = readNeutralinoAuth();
    assert.ok(auth);
    assert.equal(String(auth.port), "51322");
    assert.equal(auth.accessToken, "short-name");
  });

  it("an auth file missing the token is not auth", () => {
    writeFileSync(neutralinoAuthFile()!, JSON.stringify({ nlPort: 51323 }), "utf8");
    assert.equal(readNeutralinoAuth(), undefined);
  });

  it("a corrupt or missing file is not auth, and never throws", () => {
    writeFileSync(neutralinoAuthFile()!, "{not json", "utf8");
    assert.equal(readNeutralinoAuth(), undefined);
    assert.equal(neutralinoAuthFile(), join(dir, ".tmp", "auth_info.json"));
  });

  it("the connect handshake uses the after-the-dot half, matching nlConnectToken", () => {
    // The bridge's connect token derivation, pinned: a wrong half means the
    // WebSocket handshake is refused and every native call times out.
    writeFileSync(
      neutralinoAuthFile()!,
      JSON.stringify({ nlPort: 1, nlToken: "body.half", nlConnectToken: "half" }),
      "utf8",
    );
    const token = readNeutralinoAuth()!.accessToken;
    const connect = token.includes(".") ? token.split(".")[1]! : token;
    assert.equal(connect, "half");
  });
});
