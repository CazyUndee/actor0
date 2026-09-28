import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerFilter } from "./answer-filter.js";
import { parseToolCallBlock, scanJsonObjects } from "./tool-call-block.js";

const TOOLS = ["set_title", "search", "fetch_page", "save_note"];

/** Run text through the filter in the given chunk sizes. */
function run(source: string, size: number) {
  const filter = createAnswerFilter(TOOLS);
  let answer = "";
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  for (let i = 0; i < source.length; i += size) {
    const out = filter.push(source.slice(i, i + size));
    answer += out.text;
    for (const c of out.toolCalls) {
      calls.push({ name: c.function.name, args: JSON.parse(c.function.arguments) });
    }
  }
  const tail = filter.flush();
  answer += tail.text;
  for (const c of tail.toolCalls) {
    calls.push({ name: c.function.name, args: JSON.parse(c.function.arguments) });
  }
  return { answer, calls };
}

const CALL_BLOCK =
  '```json\n{"type": "tool_call", "name": "set_title", "arguments": {"title": "How IPS Panels Work"}}\n```\n';

test("a tool-call block is executed and never shown", () => {
  const { answer, calls } = run("Here is the answer.\n\n" + CALL_BLOCK, CALL_BLOCK.length);
  assert.deepEqual(calls, [
    { name: "set_title", args: { title: "How IPS Panels Work" } },
  ]);
  assert.equal(answer.trimEnd(), "Here is the answer.");
  assert.ok(!answer.includes("tool_call"), "the block must not reach the bubble");
  assert.ok(!answer.includes("```"), "not even the fences");
});

test("the protocol needs no narration — the block is the whole signal", () => {
  // The point of the explicit protocol: the model no longer has to say
  // "(I will now set the title.)" before the call.
  const { answer, calls } = run("Done.\n" + CALL_BLOCK, 7);
  assert.equal(calls.length, 1);
  assert.equal(answer.trimEnd(), "Done.");
});

test("a block split across deltas is buffered until the closing fence", () => {
  const { answer, calls } = run("Answer text.\n" + CALL_BLOCK, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, { title: "How IPS Panels Work" });
  assert.equal(answer.trimEnd(), "Answer text.");
});

test("nothing leaks while the block is still arriving", () => {
  const filter = createAnswerFilter(TOOLS);
  let answer = "";
  let calls = 0;
  const collect = (chunk: ReturnType<typeof filter.push>) => {
    answer += chunk.text;
    calls += chunk.toolCalls.length;
  };
  collect(filter.push("Answer text.\n\n```json\n"));
  collect(filter.push('{"type": "tool_call", "name": "search",'));
  // Half a block on screen would be the whole bug.
  assert.equal(answer, "Answer text.\n\n");
  collect(filter.push(' "arguments": {"query": "x"}}\n```\n'));
  const tail = filter.flush();
  collect(tail);
  assert.equal(answer.trimEnd(), "Answer text.");
  assert.equal(calls, 1);
});

test("an ordinary JSON code block stays visible", () => {
  const json = '```json\n{"ips": {"polarizer": "vertical", "liquid_crystal": "in-plane"}}\n```\n';
  const { answer, calls } = run("Here is the data:\n\n" + json, 11);
  assert.deepEqual(calls, []);
  assert.equal(answer, "Here is the data:\n\n" + json);
});

test("a JSON block that is not a tool call stays visible verbatim", () => {
  const block = '```json\n{"type": "example", "name": "search"}\n```\n';
  const { answer, calls } = run(block, 9);
  assert.deepEqual(calls, []);
  assert.equal(answer, block);
});

test("a block naming a tool that was not offered is not executed", () => {
  const block = '```json\n{"type": "tool_call", "name": "rm_rf", "arguments": {"path": "/"}}\n```\n';
  const { answer, calls } = run(block, 13);
  assert.deepEqual(calls, []);
  assert.equal(answer, block);
});

test("non-json code blocks stream through untouched", () => {
  const code = "```python\nprint('hi')\n```\n";
  const { answer, calls } = run("Example:\n\n" + code, 6);
  assert.deepEqual(calls, []);
  assert.equal(answer, "Example:\n\n" + code);
});

test("prose that looks like a call is left completely alone", () => {
  // The old inference path turned this into a real call. Under the explicit
  // protocol it is just text, because there is no block and no `type` field.
  const prose = 'Call set_title(title: "x") to rename this chat.';
  const { answer, calls } = run(prose, prose.length);
  assert.deepEqual(calls, []);
  assert.equal(answer, prose);
});

test("an unterminated block is released as text rather than swallowed", () => {
  const truncated = 'Here you go:\n\n```json\n{"type": "tool_call", "name": "search"}\n';
  const { answer, calls } = run(truncated, 10);
  assert.deepEqual(calls, []);
  assert.equal(answer, truncated);
});

test("a pathologically long unterminated block is released", () => {
  const filter = createAnswerFilter(TOOLS);
  let answer = filter.push('```json\n{"pad": "').text;
  answer += filter.push("x".repeat(9_000)).text;
  answer += filter.push('"}\n').text;
  answer += filter.flush().text;
  assert.ok(answer.includes('{"pad"'), "the block must come back as text");
  assert.ok(answer.length > 9_000);
});

test("a closing fence without a trailing newline still closes the block", () => {
  const filter = createAnswerFilter(TOOLS);
  let answer = filter.push("Done.\n").text;
  const tail = filter.push('```json\n{"type":"tool_call","name":"search","arguments":{}}\n```');
  answer += tail.text;
  const end = filter.flush();
  answer += end.text;
  assert.equal(tail.toolCalls.length + end.toolCalls.length, 1);
  assert.equal(answer.trimEnd(), "Done.");
});

test("multiple blocks in one answer all run", () => {
  const block = (name: string, args: string) =>
    '```json\n{"type": "tool_call", "name": "' + name + '", "arguments": ' + args + "}\n```\n";
  const { answer, calls } = run(
    block("search", '{"query": "a"}') + "Middle.\n" + block("set_title", '{"title": "T"}'),
    17,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.name, "search");
  assert.equal(calls[1]!.name, "set_title");
  assert.equal(answer.trimEnd(), "Middle.");
});

test("a call with no arguments object is still valid", () => {
  const block = '```json\n{"type": "tool_call", "name": "search"}\n```\n';
  const { calls } = run(block, 12);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, {});
});

test("parseToolCallBlock rejects everything that is not a call", () => {
  const wrap = (body: string) => "```json\n" + body + "\n```\n";
  assert.equal(parseToolCallBlock(wrap('{"type":"tool_call","name":"nope"}'), TOOLS), null);
  assert.equal(parseToolCallBlock(wrap('{"type":"other","name":"search"}'), TOOLS), null);
  assert.equal(parseToolCallBlock(wrap('{"name":"search"}'), TOOLS), null);
  assert.equal(parseToolCallBlock(wrap('{"type":"tool_call","name":42}'), TOOLS), null);
  assert.equal(parseToolCallBlock(wrap('{"type":"tool_call","name":"search","arguments":[]}'), TOOLS), null);
  assert.equal(parseToolCallBlock(wrap("not json"), TOOLS), null);
  assert.equal(parseToolCallBlock(wrap('{"type":"tool_call","name":"search"}'), []), null);
});

test("status markers and plan blocks still work alongside the protocol", () => {
  const filter = createAnswerFilter(TOOLS);
  const out = filter.push("[·] Checking sources\n\nThe answer is 42.\n");
  const tail = filter.flush();
  assert.deepEqual(out.statuses, ["Checking sources"]);
  assert.equal((out.text + tail.text).trim(), "The answer is 42.");
});

test("a code block the user asked for is never mistaken for a call", () => {
  // Even a tool-call-shaped object, when it is not in a json fence, is text.
  const inline = 'The payload looks like {"type": "tool_call", "name": "search"}.';
  const { answer, calls } = run(inline, inline.length);
  assert.deepEqual(calls, []);
  assert.equal(answer, inline);
});

// --- <tool_calls> envelopes -------------------------------------------------
//
// The shape a proxied endpoint's own system prompt teaches. The same object
// body, a different envelope: still protocol, still all-or-nothing.

const ENVELOPE =
  '<tool_calls>\n{"type": "tool_call", "name": "set_title", "arguments": {"title": "How IPS Panels Work"}}\n</tool_calls>\n';

test("a <tool_calls> envelope is executed and never shown", () => {
  const { answer, calls } = run("The answer is 42.\n" + ENVELOPE, 6);
  assert.deepEqual(calls, [{ name: "set_title", args: { title: "How IPS Panels Work" } }]);
  assert.equal(answer.trimEnd(), "The answer is 42.");
});

test("an envelope split across deltas leaks nothing", () => {
  const filter = createAnswerFilter(TOOLS);
  let answer = filter.push("The answer is 42.\n").text;
  let calls = 0;
  const collect = (chunk: ReturnType<typeof filter.push>) => {
    answer += chunk.text;
    calls += chunk.toolCalls.length;
  };
  collect(filter.push("<tool_"));
  collect(filter.push('calls>\n{"type": "tool_call", "name": "search", "arg'));
  collect(filter.push('uments": {"query": "x"}}\n</tool_'));
  collect(filter.push("calls>"));
  collect(filter.flush());
  assert.equal(answer.trimEnd(), "The answer is 42.");
  assert.equal(calls, 1);
});

test("one envelope can carry several calls", () => {
  const env =
    "<tool_calls>\n" +
    '{"type": "tool_call", "name": "search", "arguments": {"query": "a"}}\n' +
    '{"type": "tool_call", "name": "set_title", "arguments": {"title": "T"}}\n' +
    "</tool_calls>\n";
  const { answer, calls } = run("Working.\n" + env, 13);
  assert.deepEqual(calls, [
    { name: "search", args: { query: "a" } },
    { name: "set_title", args: { title: "T" } },
  ]);
  assert.equal(answer.trimEnd(), "Working.");
});

test("an envelope is all-or-nothing: one unoffered name shows the whole thing", () => {
  // This is the real-world case — an endpoint that injects its own system
  // prompt teaches a tool vocabulary this request never offered. Half
  // executing that would silently drop the user's other intent.
  const env =
    "<tool_calls>\n" +
    '{"type": "tool_call", "name": "set_title", "arguments": {"title": "T"}}\n' +
    '{"type": "tool_call", "name": "search_memory", "arguments": {}}\n' +
    "</tool_calls>\n";
  const { answer, calls } = run(env, 7);
  assert.deepEqual(calls, []);
  assert.equal(answer, env);
});

test("an unclosed <tool_calls> is released as text, never executed", () => {
  const truncated = '<tool_calls>\n{"type": "tool_call", "name": "search", "arguments": {}}\n';
  const { answer, calls } = run(truncated, 11);
  assert.deepEqual(calls, []);
  assert.equal(answer, truncated);
});

test("a pathologically long unclosed envelope is released", () => {
  const filter = createAnswerFilter(TOOLS);
  let answer = filter.push("<tool_calls>\n{\"pad\": \"").text;
  answer += filter.push("x".repeat(9_000)).text;
  answer += filter.push('"}\n').text;
  answer += filter.flush().text;
  assert.ok(answer.includes('{"pad"'), "the envelope must come back as text");
});

test("braces inside a string argument do not end the object scan", () => {
  const env =
    '<tool_calls>\n{"type": "tool_call", "name": "set_title", "arguments": {"title": "a } b {"}}\n</tool_calls>\n';
  const { answer, calls } = run(env, 9);
  assert.deepEqual(calls, [{ name: "set_title", args: { title: "a } b {" } }]);
  assert.equal(answer, "");
});

test("a pretty-printed call inside an envelope still parses", () => {
  const env =
    '<tool_calls>\n{\n  "type": "tool_call",\n  "name": "search",\n  "arguments": { "query": "a" }\n}\n</tool_calls>\n';
  const { calls } = run(env, 5);
  assert.deepEqual(calls, [{ name: "search", args: { query: "a" } }]);
});

test("mentions of the tag inside a sentence stay prose", () => {
  // Line-start plus an offered tool name is what makes this a call; a
  // sentence that merely names the tag is not a protocol block.
  const prose = "The endpoint wraps calls in a <tool_calls> envelope.";
  const { answer, calls } = run(prose, prose.length);
  assert.deepEqual(calls, []);
  assert.equal(answer, prose);
});

test("scanJsonObjects ignores braces in strings and stray closes", () => {
  assert.deepEqual(scanJsonObjects('{"a": "}"} {"b": 1}'), ['{"a": "}"}', '{"b": 1}']);
  assert.deepEqual(scanJsonObjects('} {"a": 1}'), ['{"a": 1}']);
  assert.deepEqual(scanJsonObjects('{"a": "unterminated'), []);
});

test("a closing fence split across a delta boundary still closes", () => {
  // The close can land half in what is already buffered and half in the next
  // delta. Searching only the delta misses it, and the block then grows until
  // the MAX_TOOL_BLOCK cap releases it as text — the whole call is lost.
  const filter = createAnswerFilter(TOOLS);
  let answer = filter.push("Done.\n```json\n").text;
  let calls = 0;
  const collect = (chunk: ReturnType<typeof filter.push>) => {
    answer += chunk.text;
    calls += chunk.toolCalls.length;
  };
  collect(filter.push('{"type": "tool_call", "name": "search", "arguments": {}}\n`'));
  collect(filter.push("``\n"));
  collect(filter.flush());
  assert.equal(answer.trimEnd(), "Done.");
  assert.equal(calls, 1);
});
