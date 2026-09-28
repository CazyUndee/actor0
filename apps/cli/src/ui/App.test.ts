import assert from "node:assert/strict";
import test from "node:test";
import { RESPITE, RESPITE_HOST } from "../providers.js";

/**
 * The endpoint is fixed.
 *
 * The tests that used to live here checked that a missing API key was called
 * out before the user typed, and that a failure against a keyless config named
 * the key. Both had a subject only while there was a configurable host and a
 * key that might be missing. There is neither now, so what is worth pinning is
 * the thing that caused the whole problem: the host is a constant, and nothing
 * the user has on disk can change where traffic goes.
 */

test("the endpoint is a constant, not a setting", () => {
  assert.equal(RESPITE.baseUrl, "https://aestral-chat.vercel.app");
  assert.equal(RESPITE.path, "/api/chat");
  assert.equal(RESPITE.model, "swiss-ai/apertus-v1.5-70b");
});

test("the footer host is the endpoint's own host", () => {
  assert.equal(RESPITE_HOST, "aestral-chat.vercel.app");
  assert.equal(RESPITE_HOST, new URL(RESPITE.baseUrl).host);
});
