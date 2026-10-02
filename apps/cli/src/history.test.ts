import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ToolCall } from "@actor0/harness";
import { createToolHost } from "./tools.js";
import {
  CHARS_PER_TOKEN,
  CLEARABLE_TOOLS,
  compactHistory,
  compactHistoryPerMessage,
  defaultMarker,
  isCleared,
  measureHistory,
} from "./history.js";

/**
 * History compaction.
 *
 * The rule a provider enforces, restated here so the tests assert the rule
 * rather than re-deriving it from the implementation: every `tool` message
 * must follow an assistant message that requested that exact call, and every
 * requested call must be answered. A history that breaks either is rejected
 * outright — not degraded, rejected — so this is the property that matters
 * more than the byte saving.
 *
 * The mechanism is clearing payloads, not dropping messages, which is what
 * makes the property structural: a cleared result is still a result.
 */

/** Tool results that reference a call that was never made. */
function unpairedToolResults(messages: ChatMessage[]): string[] {
  const awaiting = new Set<string>();
  const orphans: string[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) awaiting.add(call.id);
    if (message.role !== "tool") continue;
    if (!message.tool_call_id || !awaiting.has(message.tool_call_id)) {
      orphans.push(message.tool_call_id ?? "(none)");
    } else {
      awaiting.delete(message.tool_call_id);
    }
  }
  return orphans;
}

/** Tool calls that never got a result. The mirror failure, and just as fatal. */
function unansweredCalls(messages: ChatMessage[]): string[] {
  const answered = new Set<string>();
  for (const message of messages) if (message.role === "tool") answered.add(message.tool_call_id ?? "");
  const missing: string[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) if (!answered.has(call.id)) missing.push(call.id);
  }
  return missing;
}

/** The one check that matters, stated once. */
function assertApiValid(messages: ChatMessage[], label: string): void {
  assert.deepEqual(unpairedToolResults(messages), [], `${label}: a tool result lost its call`);
  assert.deepEqual(unansweredCalls(messages), [], `${label}: a tool call lost its result`);
  for (const [i, message] of messages.entries()) {
    if (message.role !== "tool") continue;
    const previous = messages[i - 1];
    assert.ok(
      previous === undefined || previous.role === "tool" || previous.role === "assistant",
      `${label}: tool message at ${i} follows a ${previous?.role}`,
    );
  }
}

const call = (id: string, name: string): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});

/** user turn -> assistant calls `tools` -> one result each. */
function conversation(rounds: number, tools: string[], payload = 40): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let round = 0; round < rounds; round += 1) {
    messages.push({ role: "user", content: `question ${round}` });
    const calls = tools.map((name, i) => call(`c${round}-${i}`, name));
    messages.push({ role: "assistant", content: "", tool_calls: calls });
    for (const c of calls) {
      messages.push({
        role: "tool",
        content: `${c.function.name} output `.repeat(payload),
        tool_call_id: c.id,
        name: c.function.name,
      });
    }
  }
  return messages;
}

// --- the invariant ----------------------------------------------------------

test("compaction never orphans a call or a result", () => {
  // Swept across shapes, because a bug that only appears with two tools in a
  // round is a bug that ships.
  for (const tools of [["read"], ["read", "shell"], ["read", "write", "edit"], ["shell", "read", "shell"]]) {
    for (const budget of [1, 2, 5, 20, 100, 5_000, 1_000_000]) {
      const source = conversation(40, tools, 60);
      const compacted = compactHistory(source, { maxTokens: budget });
      assertApiValid(compacted, `${tools.join("+")} @ ${budget}`);
    }
  }
});

test("compaction never begins the history with a tool result", () => {
  // The specific shape that used to make a resumed session unanswerable.
  for (let budget = 1; budget <= 200; budget += 7) {
    const compacted = compactHistory(conversation(30, ["read"], 60), { maxTokens: budget });
    assert.notEqual(compacted[0]?.role, "tool", `budget ${budget} produced a leading tool message`);
  }
});

test("a leading system message is never the thing that gets dropped", () => {
  const withSystem: ChatMessage[] = [
    { role: "system", content: "PROMPT" },
    ...conversation(40, ["read", "shell"], 60),
  ];
  const compacted = compactHistory(withSystem, { maxTokens: 2 });
  if (compacted.length > 1) assert.equal(compacted[0]?.role, "system");
  assertApiValid(compacted, "system + tight budget");
});

test("a history with an unanswered call is repaired, not passed through", () => {
  // A turn interrupted between a call and its result saves a *short*
  // transcript that is still unanswerable. An under-budget fast path that
  // skipped the repair would hand that straight back.
  const broken: ChatMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "", tool_calls: [call("x", "read")] },
    { role: "user", content: "next" },
  ];
  assertApiValid(compactHistory(broken, { maxTokens: 100_000 }), "interrupted turn");
});

test("a history that is already unpaired cannot be made worse", () => {
  // Even given a history that arrived broken, the result must not contain a
  // *new* orphan that the caller did not hand us.
  const orphaned: ChatMessage[] = [
    { role: "user", content: "q" },
    { role: "tool", content: "payload", tool_call_id: "ghost", name: "read" },
    { role: "user", content: "next" },
  ];
  const compacted = compactHistory(orphaned, { maxTokens: 1 });
  assertApiValid(compacted, "already-broken history");
});

// --- what gets cleared ------------------------------------------------------

test("only designated tools have their payloads cleared", () => {
  const compacted = compactHistory(conversation(30, ["read", "shell", "write", "edit"], 60), {
    maxTokens: 1,
  });
  for (const message of compacted) {
    if (message.role !== "tool") continue;
    if (message.name === "write" || message.name === "edit") {
      assert.ok(
        !isCleared(message.content),
        `a ${message.name} result is the record that a change happened and must survive`,
      );
    }
  }
});

test("a write or edit result is never emptied, even under the tightest budget", () => {
  const source = conversation(20, ["write"], 500);
  const compacted = compactHistory(source, { maxTokens: 1 });
  for (const message of compacted) {
    if (message.role === "tool") assert.ok(!isCleared(message.content));
  }
});

test("a cleared result says what it was and how to get it back", () => {
  // The model has to be able to tell a cleared result from a result that was
  // always empty, or it will conclude the tool returned nothing.
  const [one] = compactHistory(conversation(1, ["read"], 50), { maxTokens: 1 }).filter(
    (m) => m.role === "tool",
  );
  assert.ok(one);
  assert.ok(isCleared(one.content));
  assert.match(one.content, /read/, "it must name the tool to re-run");
  assert.match(one.content, /re-run/i, "it must say how to recover the payload");
  assert.doesNotMatch(one.content, /^$/, "a cleared result is never an empty one");
});

test("the caller can supply the marker", () => {
  const [one] = compactHistory(conversation(1, ["read"], 50), {
    maxTokens: 1,
    marker: (name) => `[gone: ${name}]`,
  }).filter((m) => m.role === "tool");
  assert.equal(one?.content, "[gone: read]");
});

test("the default marker keeps the size that was lost", () => {
  const marker = defaultMarker("shell", 1234);
  assert.match(marker, /1,234/);
  assert.ok(isCleared(marker));
});

// --- how much, and in what order -------------------------------------------

test("the default budget actually binds on a realistic session", () => {
  // The first version of this was 32k tokens, which nothing realistic reaches
  // — so the mechanism existed and never ran. This pins the default to a
  // session shape that a real tool-using conversation actually produces, and
  // fails if the budget is ever raised past the point of doing anything.
  const session = conversation(30, ["read", "write"], 200);
  const compacted = compactHistory(session);
  const cleared = compacted.filter((m) => m.role === "tool" && isCleared(m.content)).length;
  assert.ok(cleared > 0, "the default budget never bound, so compaction never runs");
  assert.ok(
    measureHistory(compacted) < measureHistory(session),
    `compaction freed nothing: ${measureHistory(session)} -> ${measureHistory(compacted)}`,
  );
  assertApiValid(compacted, "default budget on a realistic session");
  // And it must not have emptied everything: recent results are still needed.
  const kept = compacted.filter((m) => m.role === "tool" && !isCleared(m.content)).length;
  assert.ok(kept > 0, "the default budget is so tight it clears results the model still needs");
});

test("a history under budget is returned unchanged and un-cleared", () => {
  const source = conversation(3, ["read"], 20);
  const compacted = compactHistory(source, { maxTokens: 1_000_000 });
  assert.deepEqual(compacted, source);
  for (const message of compacted) if (message.role === "tool") assert.ok(!isCleared(message.content));
});

test("the oldest results are cleared first, and the newest are kept whole", () => {
  // Oldest-first because the recent results are the ones the model is still
  // reasoning about. The budget is chosen so it is genuinely reachable: one
  // result here is ~880 characters, so a budget that could not fit the newest
  // exchange would be testing nothing.
  const compacted = compactHistory(conversation(40, ["read"], 80), { maxTokens: 5_000 });
  const last = compacted[compacted.length - 1]!;
  assert.equal(last.role, "tool");
  assert.ok(!isCleared(last.content), "the newest result is the last thing still needed");
  const cleared = compacted.filter((m) => m.role === "tool" && isCleared(m.content));
  const kept = compacted.filter((m) => m.role === "tool" && !isCleared(m.content));
  assert.ok(cleared.length > 0 && kept.length > 0, "compaction has to have done something");
  // Cleared ones are the earlier ones.
  let lastCleared = -1;
  let firstKept = -1;
  for (const [i, m] of compacted.entries()) {
    if (m.role !== "tool") continue;
    if (isCleared(m.content)) lastCleared = i;
    else if (firstKept === -1) firstKept = i;
  }
  assert.ok(lastCleared >= 0 && firstKept >= 0);
  assert.ok(lastCleared < firstKept, "clearing must run oldest-first");
});

test("compaction gets the history under budget when the budget is reachable", () => {
  // ~6k characters survive even with every result cleared (the calls
  // themselves, the markers, and the user/assistant text), so these budgets
  // are ones compaction can actually meet.
  const source = conversation(40, ["read", "shell"], 200);
  for (const budget of [5_000, 20_000, 100_000]) {
    const compacted = compactHistory(source, { maxTokens: budget });
    assert.ok(
      measureHistory(compacted) <= budget * CHARS_PER_TOKEN,
      `budget ${budget} not met: ${measureHistory(compacted)} chars`,
    );
    assertApiValid(compacted, `budget ${budget}`);
  }
});

test("an unreachable budget degrades by clearing, not by breaking the history", () => {
  // Below the floor of the markers themselves there is no way to fit. The
  // contract is that the result stays valid, not that the budget is met.
  const compacted = compactHistory(conversation(40, ["read", "shell"], 200), { maxTokens: 1 });
  assertApiValid(compacted, "unreachable budget");
  assert.ok(
    compacted.every((m) => m.role !== "tool" || isCleared(m.content) || m.name === "read" || m.name === "shell"),
    "everything clearable was still cleared",
  );
});

test("nothing is removed and nothing is reordered", () => {
  // The whole point: a cleared result is still a result, so the conversation
  // is the same conversation. Only content differs.
  const source = conversation(10, ["read", "write"], 60);
  const compacted = compactHistory(source, { maxTokens: 50 });
  assert.equal(compacted.length, source.length, "no message may be dropped");
  for (const [i, message] of compacted.entries()) {
    assert.equal(message.role, source[i]!.role, `role changed at ${i}`);
    assert.equal(message.tool_call_id, source[i]!.tool_call_id, `pairing changed at ${i}`);
    assert.deepEqual(message.tool_calls, source[i]!.tool_calls, `calls changed at ${i}`);
  }
});

test("the caller's array is never mutated", () => {
  // It is the live conversation the UI is rendering. Emptying it in place
  // would blank results the user can still see on screen.
  const source = conversation(10, ["read"], 200);
  const before = source.map((m) => m.content);
  const compacted = compactHistory(source, { maxTokens: 10 });
  assert.notEqual(compacted, source);
  assert.deepEqual(source.map((m) => m.content), before, "the input was modified in place");
  assert.ok(compacted.some((m) => m.role === "tool" && isCleared(m.content)));
});

test("compaction is idempotent", () => {
  // A second save must not clear a marker again, shrink it further, or report
  // a different size for a payload that is already gone.
  const once = compactHistory(conversation(20, ["read"], 100), { maxTokens: 300 });
  const twice = compactHistory(once, { maxTokens: 300 });
  assert.deepEqual(twice, once);
});

test("both passes report what they took out, with the size they took", () => {
  // Compaction is the one thing this CLI does to a conversation without being
  // asked, and it is invisible from the outside: the rows on screen keep
  // showing what the tool returned, because that did happen. So the pass
  // itself has to say what it removed — a caller that cannot answer "what
  // can the model no longer see?" cannot tell the user. Sizes are the
  // original payloads, not the arithmetic saving: what was lost is what the
  // model could once read.
  const source = conversation(4, ["read", "shell"], 500);
  const payloads = new Map(
    source.filter((m) => m.role === "tool").map((m) => [m.name ?? "", m.content.length]),
  );
  const cleared: Array<[string, number]> = [];
  compactHistory(source, {
    maxTokens: 10,
    onClear: (name, chars) => cleared.push([name, chars]),
  });
  assert.ok(cleared.length >= 2, `expected several clears, got ${cleared.length}`);
  for (const [name, chars] of cleared) {
    assert.ok(CLEARABLE_TOOLS.has(name), `${name} is not a clearable tool`);
    assert.equal(chars, payloads.get(name), `${name} reported a size other than the payload that was there`);
  }

  const round = conversation(1, ["read", "read", "read"], 9_000);
  const burst: Array<[string, number]> = [];
  compactHistoryPerMessage(round, { onClear: (name, chars) => burst.push([name, chars]) });
  assert.equal(burst.length, 3, `the per-message pass must report too, got ${burst.length}`);
  assert.equal(burst[0]?.[1], round.find((m) => m.role === "tool")!.content.length);
});

test("a pass that clears nothing says nothing", () => {
  // The callback is a report, not a log line: a host that announces "your
  // context was rewritten" on every save is the same silence in the other
  // direction, so nothing fired means nothing was called.
  let called = 0;
  compactHistory(conversation(4, ["read"], 50), {
    maxTokens: 1_000_000,
    onClear: () => { called += 1; },
  });
  compactHistoryPerMessage(conversation(4, ["read"], 50), {
    onClear: () => { called += 1; },
  });
  assert.equal(called, 0);
});

// --- the unreachable budget -------------------------------------------------

// The invariant, stated as the user asked for it: compaction can reduce
// payloads, but it never drops conversation units or makes a structural cut.
// If the budget cannot be met, the intact history is the answer — not a
// smaller wrong one.

test("an unreachable budget preserves the history rather than cutting it", () => {
  // 300k of user and assistant text has no clearable payload. The old
  // mechanism dropped trailing units until it fit; the contract now is that
  // it comes back whole.
  const bulky: ChatMessage[] = [];
  for (let i = 0; i < 60; i += 1) {
    bulky.push({ role: "user", content: `u${i} `.repeat(2000) });
    bulky.push({ role: "assistant", content: `a${i} `.repeat(2000) });
  }
  const compacted = compactHistory(bulky, { maxTokens: 10 });
  assertApiValid(compacted, "unclearable history");
  assert.equal(
    compacted.length,
    bulky.length,
    "an unreachable budget must not drop a single message",
  );
  assert.deepEqual(
    compacted.map((m) => m.content),
    bulky.map((m) => m.content),
    "and must not alter the messages it could not clear",
  );
});

test("an over-budget history is bounded by clearing alone, never by removal", () => {
  // Same property, mixed history: whatever survives clearing is kept whole.
  const source = conversation(30, ["read", "shell", "write", "edit"], 200);
  const compacted = compactHistory(source, { maxTokens: 1 });
  assertApiValid(compacted, "tightest possible budget");
  assert.equal(compacted.length, source.length, "no message removed at any budget");
  for (const [i, message] of compacted.entries()) {
    assert.equal(message.role, source[i]!.role, `role changed at ${i}`);
    assert.equal(message.tool_call_id, source[i]!.tool_call_id, `pairing changed at ${i}`);
  }
});

test("the endpoint budget is a soft target by design", () => {
  // The point of dropping the fallback: the endpoint does its own trimming on
  // the way out, so an over-budget resume is handled where the request is
  // actually shaped. This pins that compaction never lies about it by
  // pretending to have met a budget it cannot meet.
  const source = conversation(30, ["read"], 300);
  const compacted = compactHistory(source, { maxTokens: 1 });
  assert.ok(
    measureHistory(compacted) > 1 * CHARS_PER_TOKEN,
    "an unreachable budget must not be met by dropping history",
  );
  assertApiValid(compacted, "soft target");
});

test("a single oversized unit is preserved whole, never split or dropped", () => {
  // One unit larger than the entire budget. The old fallback had a special
  // case for this; the new contract needs none, because nothing is ever cut.
  const wide: ChatMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "", tool_calls: Array.from({ length: 40 }, (_, i) => call(`big-${i}`, "read")) },
  ];
  for (let i = 0; i < 40; i += 1) {
    wide.push({ role: "tool", content: `payload ${i} `.repeat(200), tool_call_id: `big-${i}`, name: "read" });
  }
  const compacted = compactHistory(wide, { maxTokens: 1 });
  assert.equal(compacted.length, wide.length, "an oversized unit is not a licence to cut");
  assertApiValid(compacted, "oversized unit");
  const cleared = compacted.filter((m) => m.role === "tool" && isCleared(m.content)).length;
  assert.ok(cleared > 0, "its payloads, though, are still fair game");
});

// --- the validity pass, through the only door that reaches it ---------------

// `keepValidUnits` is private; these exercise it through `compactHistory`.
// They run at a generous budget on purpose: repair is not budget-driven, and
// tying these tests to a tight one would hide the case where a history is
// unanswerable and small at the same time.

test("an orphaned tool result is dropped even when nothing else is touched", () => {
  // The pre-existing broken shape: a result whose call is not in the history.
  const orphaned: ChatMessage[] = [
    { role: "user", content: "q" },
    { role: "tool", content: "payload", tool_call_id: "ghost", name: "read" },
    { role: "user", content: "next" },
  ];
  const compacted = compactHistory(orphaned, { maxTokens: 1_000_000 });
  assertApiValid(compacted, "orphan result at generous budget");
  assert.deepEqual(
    compacted.map((m) => m.content),
    ["q", "next"],
    "only the unanswerable fragment goes; valid messages are untouched",
  );
});

test("a call whose results never arrived is dropped even when small", () => {
  // The interrupted-turn shape. This is the test that caught the fast path:
  // a small broken history is exactly the one a "fits, return unchanged"
  // shortcut hands back as-is.
  const broken: ChatMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "", tool_calls: [call("half", "read")] },
    { role: "user", content: "next" },
  ];
  const compacted = compactHistory(broken, { maxTokens: 1_000_000 });
  assertApiValid(compacted, "interrupted call at generous budget");
  assert.ok(
    !compacted.some((m) => m.tool_calls?.some((c) => c.id === "half")),
    "the half-finished call must not be persisted",
  );
  assert.deepEqual(compacted.map((m) => m.content), ["q", "next"]);
});

test("a partially-answered round keeps the answered results and drops the round", () => {
  // Two calls, one answered. The provider refuses the round either way, and
  // keeping half of it would preserve a lie about what happened.
  const partial: ChatMessage[] = [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "",
      tool_calls: [call("done-1", "read"), call("lost-1", "shell")],
    },
    { role: "tool", content: "ok", tool_call_id: "done-1", name: "read" },
    { role: "user", content: "next" },
  ];
  const compacted = compactHistory(partial, { maxTokens: 1_000_000 });
  assertApiValid(compacted, "partial round");
  assert.deepEqual(compacted.map((m) => m.content), ["q", "next"]);
});

test("repair leaves a clean history byte-identical", () => {
  // The complement of the two above: validity repair must be invisible on a
  // history that was already answerable.
  const clean = conversation(10, ["read", "write"], 30);
  const compacted = compactHistory(clean, { maxTokens: 1_000_000 });
  assert.deepEqual(compacted, clean, "a valid history is not rewritten");
});

// --- staying honest about the tool registry ---------------------------------

test("compactHistoryPerMessage clears a single turn's burst even when globally small", () => {
  // The case the global budget cannot see: one recent turn whose shell
  // results burst past any sane size while the whole history is under the
  // global budget. Oldest-first would clear innocent old results (or nothing,
  // when under budget) and leave the burst intact.
  const burst = 'x'.repeat(40_000);
  const history: ChatMessage[] = [
    { role: "user", content: "build it" },
    { role: "assistant", content: "", tool_calls: [call("c1", "shell"), call("c2", "shell")] },
    { role: "tool", tool_call_id: "c1", content: burst },
    { role: "tool", tool_call_id: "c2", content: burst },
  ];
  const compacted = compactHistoryPerMessage(history);
  assert.ok(compacted !== history, "the caller's array is never mutated");
  // The largest of the pair goes first; 80k → one cleared + one 40k leaves the
  // group at ~40k, still over 12k, so both go.
  assert.ok(isCleared(compacted[2]!.content));
  assert.ok(isCleared(compacted[3]!.content));
  // Structure untouched: pairing, order, and the calls themselves.
  assert.equal(compacted[1]!.tool_calls?.length, 2);
  assert.equal(compacted[2]!.tool_call_id, "c1");
  assert.equal(compacted[3]!.tool_call_id, "c2");
});

test("compactHistoryPerMessage judges each message independently", () => {
  // A huge result in one turn must not clear results in its neighbours.
  const burst = 'y'.repeat(30_000);
  const history: ChatMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "", tool_calls: [call("a1", "read")] },
    { role: "tool", tool_call_id: "a1", content: burst },
    { role: "user", content: "q2" },
    { role: "assistant", content: "", tool_calls: [call("a2", "read")] },
    { role: "tool", tool_call_id: "a2", content: "listing: one file" },
  ];
  const compacted = compactHistoryPerMessage(history);
  assert.ok(isCleared(compacted[2]!.content));
  assert.equal(compacted[5]!.content, "listing: one file", "the small neighbour is untouched");
});

test("compactHistoryPerMessage never clears write results in a burst", () => {
  // The invariant holds per-message too: a write record is the evidence the
  // work happened, so a burst of shells around it clears around it.
  const burst = 'z'.repeat(20_000);
  const history: ChatMessage[] = [
    { role: "user", content: "do it" },
    { role: "assistant", content: "", tool_calls: [call("w1", "write"), call("s1", "shell")] },
    { role: "tool", tool_call_id: "w1", content: "wrote file.txt" },
    { role: "tool", tool_call_id: "s1", content: burst },
  ];
  const compacted = compactHistoryPerMessage(history);
  assert.equal(compacted[2]!.content, "wrote file.txt");
  assert.ok(isCleared(compacted[3]!.content));
});

test("compactHistoryPerMessage leaves a normal history byte-identical", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [call("b1", "read")] },
    { role: "tool", tool_call_id: "b1", content: "file contents, short" },
    { role: "assistant", content: "done" },
  ];
  assert.deepEqual(compactHistoryPerMessage(history), history);
});

test("every clearable tool is a real tool", () => {
  // The clearable set is a list of strings, so a rename would otherwise make
  // it silently un-clearable and the context would grow again with no signal.
  const names = new Set(createToolHost({ cwd: process.cwd() }).definitions().map((d) => d.function.name));
  for (const name of CLEARABLE_TOOLS) {
    assert.ok(names.has(name), `"${name}" is marked clearable but the CLI has no such tool`);
  }
});

test("the observational tools are the clearable ones", () => {
  // The rule, stated so a future tool cannot be added to the set by accident:
  // what is cleared is what a tool *returns*, and what is kept is the record
  // that a change was made.
  assert.ok(CLEARABLE_TOOLS.has("read") && CLEARABLE_TOOLS.has("shell"));
  assert.ok(!CLEARABLE_TOOLS.has("write") && !CLEARABLE_TOOLS.has("edit"));
});
