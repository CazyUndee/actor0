import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "@actor0/harness";
import { applyEvent, entriesFromMessages, initialConversation, stateFace, withUserInput, type ConversationState } from "./conversation";

/**
 * The conversation reducer.
 *
 * Everything interesting about a streaming transcript is here, and none of it is
 * visible in a screenshot: a retry that leaves the discarded text on screen, a
 * tool result that lands twice, reasoning that reads as a reaction to a tool
 * rather than the reason for it. So these are the tests.
 */

function run(state: ConversationState, events: HarnessEvent[], timing = { nowMs: 1_000, reasoningStartedAtMs: 0 }): ConversationState {
  return events.reduce((current, event) => applyEvent(current, event, timing), state);
}

describe("streaming", () => {
  it("accumulates tokens into the live region and commits them on done", () => {
    const state = run(withUserInput(initialConversation(), "hi"), [
      { type: "attempt_start" },
      { type: "token", delta: "Hel" },
      { type: "token", delta: "lo" },
      { type: "done", text: "Hello", complete: true },
    ]);
    assert.equal(state.live.text, "");
    assert.deepEqual(state.entries.map((entry) => entry.kind), ["user", "assistant"]);
    assert.equal(state.entries[1]!.kind === "assistant" && state.entries[1]!.text, "Hello");
  });

  it("marks an incomplete answer as partial", () => {
    const state = run(initialConversation(), [{ type: "token", delta: "half" }, { type: "done", text: "half", complete: false }]);
    assert.equal(state.entries[0]!.kind === "assistant" && state.entries[0]!.partial, true);
  });
});

describe("reset", () => {
  it("discards the failed attempt's text and everything it flushed, back to the attempt boundary", () => {
    const state = run(withUserInput(initialConversation(), "hi"), [
      { type: "attempt_start" },
      // Reasoning flushed mid-attempt by a tool call describes a discarded
      // attempt; leaving it in the transcript shows the model thinking about
      // work that never happened.
      { type: "reasoning", delta: "thinking about A" },
      { type: "tool_call", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { type: "token", delta: "partial answer" },
      { type: "reset", attemptText: "partial answer" },
    ]);
    assert.deepEqual(state.entries.map((entry) => entry.kind), ["user"]);
    assert.equal(state.live.text, "");
    assert.equal(state.live.retrying?.attempt, 1);
    assert.match(state.notice?.text ?? "", /retrying \(attempt 1\)/);
  });

  it("keeps entries committed before the attempt", () => {
    const before = run(initialConversation(), [{ type: "token", delta: "first answer" }, { type: "done", text: "first answer", complete: true }]);
    const state = run(withUserInput(before, "again"), [{ type: "attempt_start" }, { type: "token", delta: "second" }, { type: "reset", attemptText: "second" }]);
    assert.deepEqual(state.entries.map((entry) => entry.kind), ["assistant", "user"]);
  });
});

describe("tool calls", () => {
  it("commits the prose a round streamed before deciding to call a tool", () => {
    // Without this, the next round's tokens append to it and `done` promotes the
    // concatenation as one run-on answer.
    const state = run(initialConversation(), [
      { type: "attempt_start" },
      { type: "token", delta: "Let me look." },
      { type: "tool_call", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
    ]);
    assert.deepEqual(state.entries.map((entry) => entry.kind), ["assistant"]);
    assert.equal(state.entries[0]!.kind === "assistant" && state.entries[0]!.text, "Let me look.");
    assert.equal(state.live.text, "");
  });

  it("commits pending reasoning before the tool's own entry, so the order reads causally", () => {
    const state = run(initialConversation(), [
      { type: "attempt_start" },
      { type: "reasoning", delta: "I should read the file" },
      {
        type: "tool_result",
        call: { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
        output: { data: "contents", text: "contents" },
      },
    ]);
    assert.deepEqual(state.entries.map((entry) => entry.kind), ["reasoning", "tool"]);
    assert.equal(state.entries[0]!.kind === "reasoning" && state.entries[0]!.durationSeconds, 1);
  });

  it("promotes reasoning to an entry when the answer starts", () => {
    const state = run(initialConversation(), [
      { type: "attempt_start" },
      { type: "reasoning", delta: "thinking" },
      { type: "token", delta: "answer" },
    ]);
    assert.deepEqual(state.entries.map((entry) => entry.kind), ["reasoning"]);
    assert.equal(state.live.text, "answer");
    assert.equal(state.live.reasoning, "");
  });

  it("shows a refused protocol block as a failed call, never as answer text", () => {
    const state = run(initialConversation(), [
      {
        type: "tool_rejected",
        rejection: { name: "read", call: { id: "c1", type: "function", function: { name: "read", arguments: "{}" } }, reason: "unknown tool" },
      },
    ]);
    assert.equal(state.entries[0]!.kind === "tool" && state.entries[0]!.status, "error");
    assert.equal(state.entries[0]!.kind === "tool" && state.entries[0]!.target, "protocol block");
  });

  it("records a failed tool result as an error row", () => {
    const state = run(initialConversation(), [
      {
        type: "tool_result",
        call: { id: "c1", type: "function", function: { name: "shell", arguments: '{"command":"false"}' } },
        output: { data: "boom", text: "boom", isError: true },
        error: "Tool failed: boom",
      },
    ]);
    assert.equal(state.entries[0]!.kind === "tool" && state.entries[0]!.status, "error");
    assert.equal(state.entries[0]!.kind === "tool" && state.entries[0]!.target, "false");
  });
});

describe("stopping and failing", () => {
  it("raises a blocked banner that a reply retires", () => {
    const blocked = run(initialConversation(), [{ type: "needs_user", reason: "tool_errors", message: "5 rounds failed" }]);
    assert.equal(blocked.blocked?.reason, "tool_errors");
    assert.equal(withUserInput(blocked, "try again").blocked, undefined);
  });

  it("puts an error in the notice line, not in the transcript", () => {
    const state = run(initialConversation(), [{ type: "error", message: "endpoint refused", retriable: false }]);
    assert.equal(state.notice?.tone, "error");
    assert.deepEqual(state.entries, []);
  });
});

describe("entriesFromMessages", () => {
  it("rebuilds a transcript from stored messages, attaching results to their calls", () => {
    const entries = entriesFromMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", content: "contents", tool_call_id: "c1", name: "read" },
      { role: "assistant", content: "done\n\n[interrupted]" },
    ]);
    assert.deepEqual(entries.map((entry) => entry.kind), ["user", "tool", "assistant"]);
    assert.equal(entries[1]!.kind === "tool" && entries[1]!.target, "a.ts");
    // The marker is metadata, not content.
    assert.equal(entries[2]!.kind === "assistant" && entries[2]!.text, "done");
    assert.equal(entries[2]!.kind === "assistant" && entries[2]!.partial, true);
  });
});

describe("the face", () => {
  it("reads a failure off the notice line and a tool failure off the transcript", () => {
    const live = { text: "", reasoning: "", partial: false };
    assert.equal(stateFace({ live, notice: { tone: "error", text: "x" }, blocked: false, busy: false }), "dead");
    assert.equal(
      stateFace({
        live,
        lastEntry: { kind: "tool", name: "shell", target: "false", status: "error", output: { data: "" } },
        blocked: false,
        busy: false,
      }),
      "suffering",
    );
    assert.equal(stateFace({ live, blocked: true, busy: false }), "confused");
    assert.equal(stateFace({ live: { ...live, reasoning: "hm" }, blocked: false, busy: true }), "thinking");
    assert.equal(stateFace({ live, blocked: false, busy: true }), "normal");
    assert.equal(stateFace({ live, blocked: false, busy: false }), "idle");
  });
});

describe("the command surface", () => {
  it("offers /help with a one-letter alias and parses it", async () => {
    const { SLASH_COMMANDS, parseSlash } = await import("./slash");
    const help = SLASH_COMMANDS.find((command) => command.name === "help");
    assert.ok(help, "/help is a listed command");
    assert.deepEqual(help!.aliases, ["h", "?"]);
    assert.deepEqual(parseSlash("/help"), { name: "help" });
    assert.deepEqual(parseSlash("/?"), { name: "help" });
    assert.deepEqual(parseSlash("/h"), { name: "help" });
  });

  it("lists every command in /help's listing, with its first alias", async () => {
    const { COMMAND_HELP, SLASH_COMMANDS } = await import("./slash");
    assert.equal(COMMAND_HELP.length, SLASH_COMMANDS.length);
    for (let i = 0; i < SLASH_COMMANDS.length; i += 1) {
      const [command] = COMMAND_HELP[i]!;
      assert.ok(command.startsWith(`/${SLASH_COMMANDS[i]!.name}`));
      assert.ok(command.includes(`/${SLASH_COMMANDS[i]!.aliases[0]}`));
    }
  });

  it("revives the help entry as a pending transcript entry, and a reply replaces it", async () => {
    const { withHelp } = await import("./conversation");
    const state = withHelp(initialConversation());
    assert.equal(state.entries[0]!.kind, "help");
    // A question after help is still an ordinary question.
    assert.equal(withUserInput(state, "hi").entries.length, 2);
  });
});
