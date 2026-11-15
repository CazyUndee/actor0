// Regression: the browser-opening command must never route a URL through
// cmd.exe. `cmd /c start "" <url>` splits an unquoted argument on `&`, and
// every authorize URL is full of them — verified live: the browser opened only
// `?state=...` (sign-in could never complete on Windows), and an `&calc` in
// the URL executed as a command. The commander choice is a pure function so
// this pins the mechanism offline, on every platform the suite runs on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browserCommand } from "./oauth.js";

test("browserCommand never uses cmd and passes the URL as one literal argument", () => {
  const url = "https://auth.example.com/authorize?response_type=code&client_id=a&code_challenge=b&state=c";
  const { file, args } = browserCommand(url);
  assert.notEqual(file, "cmd", "a URL must never pass through cmd.exe: it splits an unquoted argument on & (verified: &calc executed)");
  assert.ok(!args.includes("start"), "the cmd builtin `start` is exactly the path that truncated authorize URLs at the first &");
  if (process.platform === "win32") {
    assert.equal(file, "rundll32");
    assert.equal(args[0], "url.dll,FileProtocolHandler");
    assert.equal(args[1], url, "the URL is one literal argument, not split or quoted");
    assert.equal(args.length, 2);
  } else {
    // darwin/linux: the URL is the single argument, verbatim.
    assert.ok(args.includes(url) && args.length === 1, `expected [url] on ${process.platform}, got ${JSON.stringify(args)}`);
  }
});
