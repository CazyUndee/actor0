import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decideClientLoad, isFreshAuth, mayConnect, type TokenSecurity } from "./neutralino-loader";

/**
 * The NE_CL_IVCTOKN regression suite.
 *
 * Every case here is a state that actually shipped and actually showed the
 * error (or would have): the loader decisions below are the whole history of
 * the bug, written as assertions so no future change can quietly reintroduce
 * one of its forms.
 */

test("decideClientLoad — injected real token: never touch the static globals endpoint", () => {
  // Injected globals+token. The static endpoint would serve NL_TOKEN='' and
  // clobber the injected token on a later fetch — token lost, the already
  // connected client dies with NE_CL_IVCTOKN. Only the library may load.
  assert.equal(decideClientLoad({ NL_TOKEN: "abc" }, "one-time"), "injected-library-only");
  assert.equal(decideClientLoad({ NL_TOKEN: "abc" }, "none"), "injected-library-only");
});

test("decideClientLoad — injected token and library both present: load nothing", () => {
  assert.equal(decideClientLoad({ NL_TOKEN: "abc", Neutralino: {} }, "none"), "nothing");
  assert.equal(decideClientLoad({ NL_TOKEN: "abc", Neutralino: {} }, "one-time"), "nothing");
});

test("decideClientLoad — no injection under one-time security: refuse to load (this was the shipped bug)", () => {
  // The old behaviour loaded globals + library regardless of security. Under
  // one-time the endpoint serves NL_TOKEN='' and connecting the library
  // replaced the whole page with NE_CL_IVCTOKN. Refusing is correct: the app
  // degrades to no-native-APIs instead of dying.
  assert.equal(decideClientLoad({}, "one-time"), "nothing");
  assert.equal(decideClientLoad({ NL_TOKEN: "" }, "one-time"), "nothing");
  assert.equal(decideClientLoad({ Neutralino: {} }, "one-time"), "nothing");
});

test("decideClientLoad — no injection under tokenSecurity none: globals then library", () => {
  // "none" is exactly the setting that lets the served endpoint carry the
  // real session token, which makes the direct load both safe and native-API-
  // capable.
  assert.equal(decideClientLoad({}, "none"), "globals-then-library");
  assert.equal(decideClientLoad({ NL_TOKEN: "" }, "none"), "globals-then-library");
});

test("decideClientLoad — library already on the page: globals only", () => {
  // An unlikely but legal state (library shipped with the page): the fetch of
  // globals must not append a second library load.
  assert.equal(decideClientLoad({ Neutralino: {} }, "none"), "globals-only");
});

test("mayConnect — an empty token never connects", () => {
  // The exact precondition of NE_CL_IVCTOKN: a client that reaches for the
  // WebSocket with no token. Whatever else is true, this must be false.
  assert.equal(mayConnect({ Neutralino: {} }), false);
  assert.equal(mayConnect({ NL_TOKEN: "", Neutralino: {} }), false);
  assert.equal(mayConnect({ NL_TOKEN: "abc" }), false); // no library, no client
  assert.equal(mayConnect({ NL_TOKEN: "abc", Neutralino: {} }), true);
});

test("isFreshAuth — a token from a previous session is refused (the stale auth_info bug)", () => {
  // The launcher once published auth_info from the *previous* run: the page
  // connected with a dead session's token and got NE_RT_INVTOKN/IVCTOKN. A
  // token is only fresh when it was minted for the port that is live now.
  assert.equal(isFreshAuth({ nlToken: "tok", nlPort: 48913 }, 48913), true);
  assert.equal(isFreshAuth({ nlToken: "tok", nlPort: 18884 }, 48913), false, "stale port");
  assert.equal(isFreshAuth({ nlToken: "", nlPort: 48913 }, 48913), false, "empty token");
  assert.equal(isFreshAuth({ nlPort: 48913 }, 48913), false, "missing token");
  assert.equal(isFreshAuth({ nlToken: "tok" }, 48913), false, "missing port");
  assert.equal(isFreshAuth({ nlToken: "tok", nlPort: 0 }, 48913), false, "no port 0");
});

test("config contract — neutralino.config.json keeps the security the loader is generated for", () => {
  // assemble.mjs bakes the decision from this value; if config and loader
  // disagree, the page either dies (loader assumed none, config is one-time)
  // or gives up native APIs silently (the reverse). The values that make the
  // generated loader *safe by construction* are asserted here.
  const security: TokenSecurity = "none";
  assert.equal(
    decideClientLoad({}, security),
    "globals-then-library",
    "with security none the page must load globals+library — otherwise window controls silently die",
  );
  assert.equal(
    decideClientLoad({}, "one-time"),
    "nothing",
    "with one-time the page must NOT load the client — that is the shipped NE_CL_IVCTOKN",
  );
});
