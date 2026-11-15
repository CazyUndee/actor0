import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openBrowserInShell, setShellOpener } from "./oauth.js";

/**
 * The desktop OAuth opener.
 *
 * Before this was wired, `setShellOpener` was never called by the agent's entry
 * point, so `openBrowserInShell` fell back to `globalThis.Neutralino` — which
 * does not exist in a plain Node process — and every desktop sign-in returned
 * opened:false with a URL for the user to paste by hand. These tests pin the
 * opener contract: the shell's os.open is used when injected, and a missing
 * shell degrades to "show the URL" rather than crashing.
 */

test("openBrowserInShell uses the injected shell os.open", async () => {
  const opened: string[] = [];
  setShellOpener({
    open: async (url: string) => {
      opened.push(url);
    },
  });
  const ok = openBrowserInShell("https://example.com/auth");
  assert.equal(ok, true);
  assert.deepEqual(opened, ["https://example.com/auth"]);
});

test("openBrowserInShell returns false when no shell is present", () => {
  setShellOpener(undefined);
  // A plain Node process has no globalThis.Neutralino — the exact environment
  // the packaged agent runs in when the shell socket is unreachable.
  const ok = openBrowserInShell("https://example.com/auth");
  assert.equal(ok, false);
});

test("a shell os.open that fails still reports opened (the URL is the fallback)", async () => {
  // The opener reports *attempted*, not *succeeded*: the agent hands the URL
  // back regardless, so a shell that refuses the open must not turn into a
  // failed sign-in — the user pastes the URL.
  setShellOpener({
    open: async () => {
      throw new Error("the shell refused to open the browser");
    },
  });
  // openBrowserInShell swallows the rejection and reports the attempt; the
  // caller shows the URL when opened is false, and here the attempt happened.
  const ok = openBrowserInShell("https://example.com/auth");
  assert.equal(ok, true);
});
