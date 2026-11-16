import { strict as assert } from "node:assert";
import { test } from "node:test";
import { request } from "node:http";
import { startLoopback } from "./oauth.js";

/**
 * The loopback callback, hardened against its hostile neighbors.
 *
 * The loopback port is on shared localhost: any local process can reach it,
 * and a fabricated `?code=x&state=garbage` request used to (a) get a "Signed
 * in. You can close this window." page back — leaking that a sign-in was
 * pending — and (b) once the real flow started waiting, *settle* the promise
 * with a state mismatch and kill the legitimate redirect still seconds away,
 * bricking the whole sign-in for the price of one HTTP request.
 *
 * These tests pin the hardened contract: mismatched-state requests are 404s
 * that keep the flow alive; only the redirect with the right state resolves.
 */

test("a mismatched-state callback is a 404 and does not kill the pending sign-in", async () => {
  const loop = await startLoopback({ port: 0 });
  const realState = "the-state-this-flow-started";
  try {
    // A flow is waiting; the attacker arrives first with a fabricated pair.
    const pending = loop.waitForCode(realState, { timeoutMs: 5_000 });
    const hostile = await probe(loop.redirectUri, "attacker-code", "garbage-state");
    assert.equal(hostile.status, 404, "a fabricated pair must not be answered as a sign-in");

    // The legitimate redirect, after the attacker: the flow must still be alive.
    const good = await probe(loop.redirectUri, "real-code", realState);
    assert.equal(good.status, 200);
    assert.match(good.body, /Signed in/);
    assert.equal(await pending, "real-code");
  } finally {
    loop.close();
  }
});

test("the callback with the matching state resolves the wait", async () => {
  const loop = await startLoopback({ port: 0 });
  const state = " rightful-state ";
  try {
    const pending = loop.waitForCode(state, { timeoutMs: 5_000 });
    const reply = await probe(loop.redirectUri, "the-code", state);
    assert.equal(reply.status, 200);
    assert.equal(await pending, "the-code");
  } finally {
    loop.close();
  }
});

test("probe drivers: a request with no code and no error gets the not-signed-in page", async () => {
  const loop = await startLoopback({ port: 0 });
  try {
    // Before any waitForCode, requests without params still answer — a stray
    // browser tab landing on the port is told the truth, not "signed in"...
    // unless it carries something settle-worthy (an `error` decline).
    const bare = await probe(loop.redirectUri, null, null);
    assert.equal(bare.status, 200);
    assert.match(bare.body, /did not complete/);
  } finally {
    loop.close();
  }
});

function probe(base: string, code: string | null, state: string | null): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  if (code) url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return new Promise((resolve, reject) => {
    const r = request(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}
