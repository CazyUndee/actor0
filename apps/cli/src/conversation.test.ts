import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent, ToolCall } from "@actor0/harness";
import { applyEvent, initialConversation, withUserInput, totalUsage, type Entry } from "./conversation.js";

/**
 * The reducer is pure, so the whole streaming contract is testable without a
 * terminal. The `reset` cases below are the reason: retry rewind is the one
 * piece of the harness's behaviour that is *invisible* unless the UI gets it
 * exactly right, and getting it wrong leaves discarded tokens on screen.
 */

const call = (name: string, args: unknown = {}, id = "call_1"): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const feed = (events: HarnessEvent[], start = initialConversation()) =>
  events.reduce((state, event) => applyEvent(state, event), start);

const lastEntry = (entries: Entry[]): Entry => entries[entries.length - 1];

test("user input is echoed into the transcript", () => {
  const state = withUserInput(initialConversation(), "hello");
  assert.equal(state.entries.length, 1);
  assert.deepEqual(state.entries[0], { kind: "user", text: "hello" });
});

test("tokens accumulate into the live region, not the transcript", () => {
  const state = feed([
    { type: "token", delta: "Hel" },
    { type: "token", delta: "lo" },
  ]);
  assert.equal(state.live.text, "Hello");
  assert.equal(state.entries.length, 0, "streaming text must not be committed until the turn ends");
});

test("done promotes streamed text to a permanent assistant entry", () => {
  const state = feed([{ type: "token", delta: "Hi" }, { type: "done", text: "Hi", complete: true }]);
  assert.equal(state.entries.length, 1);
  assert.deepEqual(lastEntry(state.entries), { kind: "assistant", text: "Hi", partial: false });
  assert.equal(state.live.text, "", "the live region is cleared once the answer is final");
});

test("an incomplete answer is marked partial", () => {
  const state = feed([{ type: "token", delta: "half" }, { type: "done", text: "half", complete: false }]);
  const entry = lastEntry(state.entries);
  assert.equal(entry.kind, "assistant");
  assert.equal(entry.kind === "assistant" && entry.partial, true);
});

test("reset clears streamed text so a retry does not double-write", () => {
  const state = feed([
    { type: "token", delta: "The quick brown" },
    { type: "reset", attemptText: "The quick brown" },
  ]);
  assert.equal(state.live.text, "", "discarded tokens must not survive the rewind");
  assert.equal(state.live.retrying?.attempt, 1);
  const notice = lastEntry(state.entries);
  assert.equal(notice.kind, "notice");
  assert.match(notice.kind === "notice" ? notice.text : "", /retrying \(attempt 1\)/);
});

test("a fresh attempt streams cleanly after a reset", () => {
  const state = feed([
    { type: "token", delta: "garbage" },
    { type: "reset", attemptText: "garbage" },
    { type: "token", delta: "clean answer" },
    { type: "done", text: "clean answer", complete: true },
  ]);
  const answers = state.entries.filter((entry) => entry.kind === "assistant");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].kind === "assistant" && answers[0].text, "clean answer");
});

test("repeated resets count attempts", () => {
  let state = initialConversation();
  for (let i = 0; i < 3; i += 1) {
    state = applyEvent(state, { type: "reset", attemptText: "x" });
  }
  assert.equal(state.live.retrying?.attempt, 3);
});

test("reset with nothing streamed does not fabricate a notice", () => {
  const state = applyEvent(initialConversation(), { type: "reset", attemptText: "   " });
  assert.equal(state.entries.length, 0);
  assert.equal(state.live.retrying?.attempt, 1);
});

test("tool_start shows activity in the live region", () => {
  const state = applyEvent(initialConversation(), { type: "tool_start", call: call("read", { path: "a.ts" }) });
  assert.deepEqual(state.live.tool, { name: "read", target: "a.ts" });
});

test("tool_result commits a permanent line and clears the spinner", () => {
  const state = feed([
    { type: "tool_start", call: call("read", { path: "a.ts" }) },
    { type: "tool_result", call: call("read", { path: "a.ts" }), output: "contents" },
  ]);
  assert.equal(state.live.tool, undefined);
  assert.deepEqual(lastEntry(state.entries), {
    kind: "tool",
    name: "read",
    target: "a.ts",
    status: "ok",
    output: "contents",
  });
});

test("reasoning lands before the tool call it led to, not after it", () => {
  // The model thought, then called the tool, then answered. The transcript has
  // to say that, or the thinking reads as a reaction to the tool rather than the
  // reason for it.
  const state = feed([
    { type: "reasoning", delta: "Checking repository access" },
    { type: "tool_start", call: call("bash", { command: "ls -la" }) },
    { type: "tool_result", call: call("bash", { command: "ls -la" }), output: "notes.md" },
    { type: "done", text: "There is one file", complete: true },
  ]);
  assert.deepEqual(
    state.entries.map((entry) => entry.kind),
    ["reasoning", "tool", "assistant"],
  );
});

test("reasoning flushed by an early tool is not committed twice", () => {
  const state = feed([
    { type: "reasoning", delta: "first thought" },
    { type: "tool_call", tool_calls: [call("read", { path: "a.ts" })] },
    { type: "tool_result", call: call("read", { path: "a.ts" }), output: "contents" },
    { type: "reasoning", delta: "second thought" },
    { type: "done", text: "done", complete: true },
  ]);
  const reasoning = state.entries.filter((entry) => entry.kind === "reasoning");
  assert.equal(reasoning.length, 2, "each stretch of thinking is committed once");
  assert.deepEqual(state.entries.map((entry) => entry.kind), ["reasoning", "tool", "reasoning", "assistant"]);
});

test("a failed tool is distinguished from a successful one", () => {
  const state = applyEvent(initialConversation(), {
    type: "tool_result",
    call: call("read"),
    output: "Tool failed: ENOENT",
    error: "Tool failed: ENOENT",
  });
  const entry = lastEntry(state.entries);
  assert.equal(entry.kind === "tool" && entry.status, "error");
});

test("a bash call shows the command, on one line", () => {
  // The transcript line is `✓ $ <what ran>`. Without this it renders as a bare
  // `$`, which tells the user nothing about what just happened to their disk.
  const state = applyEvent(initialConversation(), {
    type: "tool_start",
    call: call("bash", { command: "npm run build\n  --if-present" }),
  });
  assert.deepEqual(state.live.tool, { name: "bash", target: "npm run build --if-present" });
});

test("a malformed argument blob yields no target rather than throwing", () => {
  const state = applyEvent(initialConversation(), {
    type: "tool_start",
    call: { id: "1", type: "function", function: { name: "read", arguments: "{not json" } },
  });
  assert.deepEqual(state.live.tool, { name: "read", target: "" });
});

test("reasoning is kept alongside the answer when present", () => {
  const state = feed([
    { type: "reasoning", delta: "thinking about it" },
    { type: "token", delta: "done" },
    { type: "done", text: "done", complete: true },
  ]);
  assert.equal(state.entries[0].kind, "reasoning");
  assert.equal(state.entries[1].kind, "assistant");
});

test("needs_user blocks the turn without discarding the transcript", () => {
  const state = feed([
    { type: "token", delta: "partial" },
    { type: "needs_user", reason: "tool_errors", message: "3 rounds of tool calls failed in a row" },
  ]);
  assert.equal(state.live.text, "");
  assert.equal(state.blocked?.message, "3 rounds of tool calls failed in a row");
  assert.equal(state.entries.length, 0);
});

test("an error becomes a notice and clears the live region", () => {
  const state = feed([{ type: "token", delta: "partial" }, { type: "error", message: "HTTP 500", retriable: true }]);
  assert.equal(state.live.text, "");
  const entry = lastEntry(state.entries);
  assert.equal(entry.kind === "notice" && entry.tone, "error");
});

test("a leading plan is recorded as its own entry", () => {
  const state = applyEvent(initialConversation(), {
    type: "plan",
    plan: { title: "Investigate", plan: "1. read files", consumed: 10 },
  });
  assert.deepEqual(lastEntry(state.entries), { kind: "plan", title: "Investigate", plan: "1. read files" });
});

test("usage frames aggregate", () => {
  const total = totalUsage([
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  ]);
  assert.deepEqual(total, { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 });
});

test("the reducer never mutates the state it is given", () => {
  const before = initialConversation();
  const snapshot = JSON.stringify(before);
  applyEvent(before, { type: "token", delta: "x" });
  assert.equal(JSON.stringify(before), snapshot);
});

test("reset discards what the dead attempt flushed mid-stream", () => {
  // Reasoning flushed on a tool_call becomes a permanent entry the moment the
  // call arrives — but if that attempt then fails and is retried, the entry
  // describes a discarded attempt: the model shown thinking about work that
  // never happened. attempt_start snapshots the transcript; reset truncates
  // to the snapshot.
  let state = applyEvent(initialConversation(), { type: "user", text: "go" } as never);
  state = applyEvent(state, { type: "attempt_start" });
  state = applyEvent(state, { type: "reasoning", delta: "reading the file" });
  state = applyEvent(state, {
    type: "tool_call",
    tool_calls: [{ id: "x", type: "function", function: { name: "read", arguments: "{}" } }],
  });
  assert.ok(state.entries.some((e) => e.kind === "reasoning"), "flush happened mid-attempt");
  state = applyEvent(state, { type: "reset", attemptText: "" });
  assert.deepEqual(state.entries.map((e) => e.kind), [], "the dead attempt's residue is gone");

  // The surviving attempt's flushes are kept.
  state = applyEvent(state, { type: "attempt_start" });
  state = applyEvent(state, { type: "reasoning", delta: "again" });
  state = applyEvent(state, {
    type: "tool_call",
    tool_calls: [{ id: "y", type: "function", function: { name: "read", arguments: "{}" } }],
  });
  assert.ok(state.entries.some((e) => e.kind === "reasoning"));
});

test("reset without a snapshot keeps everything (old-host tolerance)", () => {
  // A host that never saw attempt_start has no snapshot; reset then keeps the
  // entries rather than guessing at a truncation point.
  let state = initialConversation();
  state = applyEvent(state, { type: "reasoning", delta: "kept" });
  state = applyEvent(state, { type: "tool_call", tool_calls: [] });
  state = applyEvent(state, { type: "reset", attemptText: "" });
  assert.equal(state.entries.length, 1);
});
