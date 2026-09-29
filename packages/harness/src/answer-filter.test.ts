import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerFilter, MAX_STATUS_CHARS } from "./answer-filter.js";

function run(deltas: string[]) {
  const statuses: string[] = [];
  const plans: string[] = [];
  const visible: string[] = [];
  const filter = createAnswerFilter();
  let answer = "";
  for (const delta of deltas) {
    const output = filter.push(delta);
    statuses.push(...output.statuses);
    if (output.plan) plans.push(output.plan.title);
    answer += output.text;
    visible.push(answer);
  }
  const tail = filter.flush();
  statuses.push(...tail.statuses);
  if (tail.plan) plans.push(tail.plan.title);
  answer += tail.text;
  visible.push(answer);
  return { answer, plans, statuses, visible };
}

test("releases answer text immediately", () => {
  const result = run(["Yes", ", ", "that ", "works", "."]);
  assert.equal(result.answer, "Yes, that works.");
  assert.deepEqual(result.visible, ["Yes", "Yes, ", "Yes, that ", "Yes, that works", "Yes, that works.", "Yes, that works."]);
});

test("extracts status lines but preserves markdown links", () => {
  const result = run(["[·] Working\n[label](https://example.com)"]);
  assert.deepEqual(result.statuses, ["Working"]);
  assert.equal(result.answer, "[label](https://example.com)");
});

test("extracts one leading plan block", () => {
  const result = run(["## Inspect", "ing inputs\n", "Reading files.\n", "\nAnswer"]);
  assert.deepEqual(result.plans, ["Inspecting inputs"]);
  assert.equal(result.answer, "Answer");
});

test("reset clears held input", () => {
  const filter = createAnswerFilter();
  assert.equal(filter.push("partial [").text, "partial [");
  filter.reset();
  assert.equal(filter.push("fresh").text, "fresh");
  assert.equal(filter.flush().text, "");
});

test("link text is not mistaken for a status marker", () => {
  // A landing page is full of these, and eating them deleted the call to
  // action from the answer.
  for (const line of [
    "[**Start Building**]",
    "[**Request a Demo**]",
    "[Get Started for Free]",
    "[`npm install`](https://x.com)",
    "[__bold__]",
    "[see docs]",
  ]) {
    const result = run([line + "\n", "Body text.\n"]);
    assert.deepEqual(result.statuses, [], `ate ${line} as a status`);
    assert.ok(result.answer.includes(line), `dropped ${line} from the answer`);
  }
});

/**
 * A status line split by a delta boundary used to tear.
 *
 * The filter decided "this is a status" from the first delta that carried the
 * marker, and SSE deltas are much smaller than a line: "[\u00b7] Search" on
 * one and "ing the web" on the next produced the status "Search" and then
 * printed "ing the web" into the answer as prose, with nothing on it to say
 * what it had been. The line is held now until its newline arrives.
 */
/**
 * The result must not depend on how the bytes were split.
 *
 * Everything in this filter is a decision made on a partial buffer: whether
 * the marker has arrived, whether a fence has closed, whether the next
 * character changes a hold. None of that may show up in the finished answer.
 * A stream that arrived in one delta and the same stream that arrived one
 * character at a time have to produce identical text, statuses, calls and
 * rejections — otherwise the answer a user reads depends on the network.
 *
 * This is the test that found the blank line after a tool call: every other
 * test in this file pushes whole blocks, which is the one way a stream never
 * arrives.
 */
const CORPUS: [string, string][] = [
  ["plain prose", "Hello there.\nThis is a second line.\n"],
  ["a status line", "[·] Reading files\nHere is the answer.\n"],
  ["a status with no newline", "[·] last thing"],
  ["an indented status", "   [·] indented\ntext\n"],
  ["two statuses", "[·] one\n[·] two\nanswer\n"],
  ["a link that is not a status", "See [Get Started](https://x.test) for more.\n"],
  [
    "a fenced call",
    'Sure.\n\n```json\n{"type":"tool_call","name":"shell","arguments":{"command":"ls"}}\n```\n\nDone.\n',
  ],
  ["a fence that is not a call", 'Example:\n\n```json\n{"not":"a call"}\n```\n'],
  ["a bare code fence", "Example:\n\n```python\nprint(1)\n```\n"],
  [
    "an envelope call",
    'Working.\n\n<tool_calls>\n{"type":"tool_call","name":"read","arguments":{"path":"a"}}\n</tool_calls>\n',
  ],
  [
    "a call with broken arguments",
    'Try:\n\n```json\n{"type":"tool_call","name":"shell","arguments":{oops}}\n```\n',
  ],
  [
    "a call for an unoffered tool",
    'Try:\n\n```json\n{"type":"tool_call","name":"nope","arguments":{}}\n```\n',
  ],
  [
    "a call followed by a status",
    "ok\n\n```json\n" +
      '{"type":"tool_call","name":"read","arguments":{"path":"a"}}\n' +
      "```\n\n[·] Reading it\n",
  ],
  ["a marker-shaped line in a fence", "```\n[not a marker]\n```\n"],
  [
    "an unterminated fence",
    'text\n```json\n{"type":"tool_call","name":"shell","arguments":{"command":"x"}}\n',
  ],
  ["windows line endings", "[·] Compiling\r\nanswer line\r\n"],
  ["no trailing newline at all", "just an answer"],
  ["an answer that starts with a fence", '```json\n{"type":"tool_call","name":"read","arguments":{"path":"a"}}\n```\n'],
];

const chunked = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

/**
 * Everything the filter settles on: the answer, the statuses, the calls and
 * the rejections.
 *
 * Deliberately not the progressive snapshot the other helper returns. That
 * one is *supposed* to differ -- it is what the user sees while the answer is
 * still arriving, and arriving one character at a time must show one
 * character at a time. What must not differ is what the turn ends up with.
 */
function settled(chunks: string[]): string {
  const filter = createAnswerFilter(["shell", "read"]);
  const statuses: string[] = [];
  const calls: string[] = [];
  const rejected: string[] = [];
  let answer = "";
  for (const chunk of chunks) {
    const out = filter.push(chunk);
    statuses.push(...out.statuses);
    calls.push(...out.toolCalls.map((call) => `${call.function.name}(${call.function.arguments})`));
    rejected.push(...out.rejected.map((block) => block.reason));
    answer += out.text;
  }
  const tail = filter.flush();
  statuses.push(...tail.statuses);
  calls.push(...tail.toolCalls.map((call) => `${call.function.name}(${call.function.arguments})`));
  rejected.push(...tail.rejected.map((block) => block.reason));
  answer += tail.text;
  return JSON.stringify({ answer, statuses, calls, rejected });
}

test("the answer does not depend on how the stream was chunked", () => {
  for (const [name, text] of CORPUS) {
    const whole = settled([text]);
    for (const size of [1, 2, 3, 5, 7, 13]) {
      assert.equal(
        settled(chunked(text, size)),
        whole,
        `${name} read in ${size}-character deltas parsed differently`,
      );
    }
  }
});

/**
 * A status line split by a delta boundary used to tear.
 *
 * The filter decided "this is a status" from the first delta that carried the
 * marker, and SSE deltas are much smaller than a line: "[·] Search" on one
 * and "ing the web" on the next produced the status "Search" and then printed
 * "ing the web" into the answer as prose, with nothing on it to say what it
 * had been. The line is held now until its newline arrives.
 */
test("a status line split across deltas is not torn in half", () => {
  const result = run(["[·] Search", "ing the web", "\n", "Here is the answer.\n"]);
  assert.deepEqual(result.statuses, ["Searching the web"]);
  assert.equal(result.answer, "Here is the answer.\n");
});


test("a marker split across deltas is still a marker", () => {
  const result = run(["[", "\u00b7] Read", "ing the file", "\n"]);
  assert.deepEqual(result.statuses, ["Reading the file"]);
  assert.equal(result.answer, "");
});

test("one character at a time still yields whole status lines", () => {
  // The worst case a real stream produces, and the one every test before this
  // missed because they all pushed a whole line at a time.
  const result = run([..."[\u00b7] Running the tests"].map((c) => c).concat(["\n", "done\n"]));
  assert.deepEqual(result.statuses, ["Running the tests"]);
  assert.equal(result.answer, "done\n");
});

test("a status line past the cap keeps its tail as answer text", () => {
  const long = "x".repeat(MAX_STATUS_CHARS + 40);
  const result = run([`[\u00b7] ${long}\n`]);
  assert.deepEqual(result.statuses, ["x".repeat(MAX_STATUS_CHARS)]);
  assert.equal(result.answer, `${"x".repeat(40)}\n`, "the text past the cap is content, not status");
});

test("a status line with no newline at the end of the stream is still a status", () => {
  const result = run(["[\u00b7] Done"]);
  assert.deepEqual(result.statuses, ["Done"]);
  assert.equal(result.answer, "");
});

test("a blank marker line is consumed without inventing a status", () => {
  const result = run(["[\u00b7]\n", "answer\n"]);
  assert.deepEqual(result.statuses, []);
  assert.equal(result.answer, "answer\n");
});

test("holding a status line does not delay the answer that follows it", () => {
  // The hold is bounded by the cap, not by the end of the answer: a long run
  // of marker-shaped lines must not park the whole response.
  const result = run(["[\u00b7] ", "one two three\n", "real answer\n"]);
  assert.deepEqual(result.statuses, ["one two three"]);
  assert.equal(result.answer, "real answer\n");
  assert.ok(result.visible.at(-1)?.includes("real answer"), "the answer was released");
});

test("real status markers still work", () => {
  const result = run(["[·] Reading files\n", "[·] Compiling\n", "[·] 2 of 5\n"]);
  assert.deepEqual(result.statuses, ["Reading files", "Compiling", "2 of 5"]);
});
