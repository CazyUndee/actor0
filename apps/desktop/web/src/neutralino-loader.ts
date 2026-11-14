/**
 * The Neutralino handshake, as testable pure logic.
 *
 * History (why this file exists): window mode shipped with `tokenSecurity:
 * "one-time"` and a page that loads globals from the served endpoint. That
 * endpoint always serves `NL_TOKEN=''` under one-time security — the token is
 * handed to the injected client via `sessionStorage` exactly once — so the
 * client library connected with an empty token and Neutralino replaced the
 * whole page with `NE_CL_IVCTOKN`. Two attempted fixes made it worse: fetching
 * a token written by the launcher consumed the one-time token as a *second*
 * client, and a stale `auth_info.json` published a dead session's token.
 *
 * The rules below are the contract that prevents all of that coming back:
 *
 *   1. An injected real token wins, and only `neutralino.js` is loaded —
 *      never the static globals endpoint, whose empty token would clobber it.
 *   2. Without injection, load globals *then* the library — but only when the
 *      config lets the endpoint carry a real token (`tokenSecurity: "none"`).
 *      Under `"one-time"`, connecting anything that loaded globals over HTTP
 *      is guaranteed to fail, so the loader must refuse.
 *   3. Never connect with an empty token; never load the library when no
 *      token source has produced one.
 *
 * `index.html` runs this at parse time (before the app bundle), because the
 * library must exist before `boot()` calls `Neutralino.init()`.
 */

export type LoaderGlobals = {
  NL_TOKEN?: string;
  Neutralino?: unknown;
};

/** How the Neutralino shell authenticates native-API calls. */
export type TokenSecurity = "one-time" | "none";

/** What `index.html`'s inline loader decided to write, in order. */
export type ScriptOrder = "injected-library-only" | "globals-then-library" | "globals-only" | "nothing";

/**
 * Decide what to load, given the page's globals. `tokenSecurity` is what the
 * config promises — it is a build-time decision, passed in so the policy can
 * be tested without a Neutralino server.
 */
export function decideClientLoad(globals: LoaderGlobals, security: TokenSecurity): ScriptOrder {
  const injectedToken = typeof globals.NL_TOKEN === "string" && globals.NL_TOKEN !== "";
  if (injectedToken) {
    // The shell injected a real token. The static globals endpoint would
    // serve NL_TOKEN='' and clobber it on a later fetch — do not touch it.
    return typeof globals.Neutralino === "undefined" ? "injected-library-only" : "nothing";
  }
  if (security !== "none") {
    // No injected token, and the endpoint cannot serve one: any client we
    // load will connect with an empty token and the page is destroyed with
    // NE_CL_IVCTOKN. Load nothing — the app still runs without native APIs.
    return "nothing";
  }
  // tokenSecurity "none": the endpoint carries the real token.
  if (typeof globals.Neutralino === "undefined") return "globals-then-library";
  return "globals-only";
}

/** True when `boot()` may call `Neutralino.init()` and use native APIs. */
export function mayConnect(globals: LoaderGlobals): boolean {
  return typeof globals.Neutralino !== "undefined" && typeof globals.NL_TOKEN === "string" && globals.NL_TOKEN !== "";
}

/**
 * Guard for relays (dev helpers, launchers) that publish Neutralino auth
 * info for the page: refuses to publish anything from a *previous* session.
 *
 * This is the stale-auth_info bug as a policy: `nlToken` is bound to a server
 * port, so a token published beside a port the token was not minted for is a
 * guaranteed NE_CL_IVCTOKN. The launcher deletes `auth_info.json` before
 * spawning so a previous run's file can never be mistaken for this one's.
 */
export function isFreshAuth(info: { nlToken?: unknown; nlPort?: unknown }, livePort: number): boolean {
  if (typeof info.nlToken !== "string" || info.nlToken === "") return false;
  if (typeof info.nlPort !== "number" || info.nlPort <= 0) return false;
  // The token must belong to the server that is actually listening.
  return info.nlPort === livePort;
}
