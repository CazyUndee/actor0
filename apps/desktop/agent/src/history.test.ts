import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "@actor0/harness";
import { compactHistory, forStorage, isChatMessage, repairHistory } from "./history.js";

/**
 * Transcript hygiene.
 *
 * Both functions protect the same thing from opposite ends: a transcript the
 * provider will accept. `repairHistory` fixes a file that a schema change or a
 * crash left dangling; `compactHistory` shrinks one without ever removing a
 * message. The tests are written around the *shapes a provider rejects*, which
 * is what makes a broken transcript fatal rather than merely ugly.
 */

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string, toolCalls?: ChatMessage["tool_calls"]): ChatMessage => ({
  role: "assistant",
  content,
  ...(toolCalls ? { tool_calls: toolCalls } : {}),
});
const tool = (content: string, id: string, name = "read"): ChatMessage => ({
  role: "tool",
  content,
  tool_call_id: id,
  name,
});

const call = (id: string, name = "read") => ({ id, type: "function" as const, function: { name, arguments: "{}" } });

describe("repairHistory", () => {
  it("drops a tool result whose call is not in the transcript", () => {
    const repaired = repairHistory([user("hi"), tool("orphan", "missing")]);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0]!.role, "user");
  });

  it("answers a tool call whose result never landed, so no call is left dangling", () => {
    const repaired = repairHistory([user("hi"), assistant("", [call("c1")])]);
    const answers = repaired.filter((message) => message.role === "tool");
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.tool_call_id, "c1");
    assert.match(answers[0]!.content, /not recorded/);
  });

  it("leaves a well-formed conversation exactly as it was", () => {
    const messages = [user("hi"), assistant("", [call("c1")]), tool("result", "c1")];
    assert.deepEqual(repairHistory(messages), messages);
  });

  it("drops a tool message with no id at all", () => {
    const repaired = repairHistory([user("hi"), { role: "tool", content: "no id" }, assistant("", [call("c2")]), tool("ok", "c2")]);
    assert.equal(repaired.filter((message) => message.role === "tool").length, 1);
  });
});

describe("compactHistory", () => {
  it("clears only the payloads of stale, large tool results", () => {
    const big = "x".repeat(5_000);
    const messages: ChatMessage[] = [user("hi")];
    for (let i = 0; i < 10; i += 1) {
      messages.push(assistant("", [call(`c${i}`)]), tool(big, `c${i}`));
    }
    const compacted = compactHistory(messages, { keepRecent: 3 });
    assert.equal(compacted.length, messages.length, "no message may be dropped");
    const clearedCount = compacted.filter((message) => message.content.includes("cleared from the saved transcript")).length;
    assert.equal(clearedCount, 7);
    // The newest three are the results the model may still be reasoning about.
    assert.equal(compacted[compacted.length - 1]!.content, big);
  });

  it("leaves a short result alone — clearing it saves nothing and loses information", () => {
    const messages = [user("hi"), assistant("", [call("c1")]), tool("small", "c1")];
    assert.deepEqual(compactHistory(messages, { keepRecent: 0 }), messages);
  });

  it("is a no-op when there is nothing to clear, returning the same array", () => {
    const messages = [user("hi")];
    assert.equal(compactHistory(messages), messages);
  });
});

describe("forStorage", () => {
  it("strips the leading system message, which is re-seeded on load", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "prompt" }, user("hi")];
    assert.deepEqual(forStorage(messages), [user("hi")]);
  });

  it("leaves a transcript with no system message untouched", () => {
    const messages = [user("hi")];
    assert.equal(forStorage(messages), messages);
  });
});

describe("isChatMessage", () => {
  it("accepts the minimum shape and refuses everything else", () => {
    assert.equal(isChatMessage({ role: "user", content: "hi" }), true);
    assert.equal(isChatMessage({ role: "user" }), false);
    assert.equal(isChatMessage(null), false);
    assert.equal(isChatMessage([]), false);
  });
});
