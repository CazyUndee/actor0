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
test("a status line split across deltas is not torn in half", () => {
  const result = run(["[\u00b7] Search", "ing the web", "\n", "Here is the answer.\n"]);
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
