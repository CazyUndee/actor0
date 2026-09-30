import assert from "node:assert/strict";
import test from "node:test";
import {
  AbortedTurnError,
  CANCELLED_TOOL_RESULT,
  DEFAULT_HARNESS_CONFIG,
  INTERRUPT_MARKER,
  RETRY_JITTER_RATIO,
  retryDelay,
  runAgentTurn,
  runModelRound,
  withInterruptMarker,
} from "./harness.js";
import { ModelTransportError } from "./model-client.js";
import type {
  HarnessEvent,
  ModelClient,
  ModelEvent,
  ToolCall,
  ToolDefinition,
  ToolHost,
} from "./types.js";

const fastConfig = {
  ...DEFAULT_HARNESS_CONFIG,
  maxRetries: 2,
  initialBackoffMs: 0,
  maxBackoffMs: 0,
  idleTimeoutMs: 1_000,
  maxToolRounds: 4,
};

function scriptedModel(scripts: AsyncIterable<ModelEvent>[]): ModelClient {
  let index = 0;
  return {
    async *stream() {
      const script = scripts[index++];
      if (!script) throw new Error(`missing script ${index}`);
      for await (const event of script) yield event;
    },
  };
}

async function events(...items: ModelEvent[]): Promise<AsyncIterable<ModelEvent>> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test("a rate limit sets a floor under the backoff", () => {
  // The whole point of reading the header: a 429 that says "come back in 30"
  // must not be retried after one, two and four seconds. Every one of those
  // lands inside the window the server just described.
  const config = { ...DEFAULT_HARNESS_CONFIG, maxRetries: 3, initialBackoffMs: 1_000, maxBackoffMs: 8_000 };
  const limited = new ModelTransportError("rate limited", true, 30_000);
  for (const attempt of [1, 2, 3]) {
    const delay = retryDelay(attempt, config, limited);
    assert.ok(delay >= 30_000, `attempt ${attempt} retried after ${delay}ms, inside the limit's window`);
    assert.ok(delay <= 30_000 * (1 + RETRY_JITTER_RATIO), `attempt ${attempt} waited ${delay}ms, past the server's ask`);
  }
});

test("a wait the server asked for never shortens a longer backoff", () => {
  // Both inputs are floors. A 503 with "retry after 2s" on the third attempt
  // still waits the backoff, because the backoff is there for a reason.
  const config = { ...DEFAULT_HARNESS_CONFIG, initialBackoffMs: 1_000, maxBackoffMs: 8_000 };
  const brief = new ModelTransportError("restarting", true, 2_000);
  assert.ok(retryDelay(3, config, brief) >= 4_000, "a short Retry-After cut a longer backoff");
});

test("backoff grows, is capped, and carries jitter that only ever lengthens it", () => {
  const config = { ...DEFAULT_HARNESS_CONFIG, initialBackoffMs: 1_000, maxBackoffMs: 4_000 };
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const delay = retryDelay(attempt, config);
    const backoff = Math.min(1_000 * 2 ** (attempt - 1), 4_000);
    assert.ok(delay >= backoff, `attempt ${attempt}: ${delay}ms is shorter than its backoff ${backoff}ms`);
    assert.ok(
      delay <= backoff * (1 + RETRY_JITTER_RATIO),
      `attempt ${attempt}: ${delay}ms is longer than its backoff plus jitter`,
    );
  }
  // Jitter has to actually vary, or a fleet of clients retrying the same
  // 429 comes back in the same second and is rejected again.
  const samples = new Set(Array.from({ length: 20 }, () => retryDelay(1, config)));
  assert.ok(samples.size > 1, "every client got the identical wait");
});

test("an error that says nothing about waiting gets the plain backoff", () => {
  const config = { ...DEFAULT_HARNESS_CONFIG, initialBackoffMs: 1_000, maxBackoffMs: 8_000 };
  const delay = retryDelay(1, config, new ModelTransportError("connection reset", true));
  assert.ok(delay >= 1_000 && delay <= 1_250, `a dropped connection waited ${delay}ms`);
  assert.ok(retryDelay(1, config) >= 1_000, "no error at all is still a backoff");
});

test("a rate-limited turn says so before it waits", async () => {
  // The note is the only thing on screen while the turn is quiet, so it has to
  // say whether the wait is ours or the server's, and never round a sub-second
  // wait down to "0s". The window here is 40ms rather than 30s: the delay is
  // honoured rather than merely reported, and a test is not the place to spend
  // half a minute proving that it is.
  // An iterable whose first `next` rejects. Not a generator: this one has
  // nothing to yield, and a generator that only throws is a lint error and a
  // lie about its own shape.
  const limited: AsyncIterable<ModelEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(new ModelTransportError("rate limited", true, 40)),
    }),
  };
  const model = scriptedModel([limited, await events({ type: "token", delta: "ok" }, { type: "done" })]);
  const observed: HarnessEvent[] = [];
  // The block body is the point: `observed.push(e)` in an arrow body
  // returns the array's length, and an observer has to return void.
  await runModelRound(model, [], [], new AbortController().signal, {
    event: (event) => {
      observed.push(event);
    },
  }, {
    ...fastConfig,
    maxRetries: 1,
  });

  const notes = observed.filter((e): e is Extract<HarnessEvent, { type: "status" }> => e.type === "status");
  assert.ok(notes.length > 0, "a retry must say that it is retrying");
  const note = notes[0]!.status;
  assert.match(note, /^Rate limited — retrying in \d+ms…$/, `${note}`);
  // The figure carries jitter, so it is the floor that is asserted, not the
  // exact number: the wait may only ever be longer than the server asked for.
  const waited = Number(/in (\d+)ms/.exec(note)?.[1]);
  assert.ok(waited >= 40, `the note promised to retry after ${waited}ms, inside the window the server named`);
});


test("retries transient attempts and rewinds visible text", async () => {
  const failed = (async function* (): AsyncIterable<ModelEvent> {
    yield { type: "token", delta: "partial" };
    throw new ModelTransportError("rate limited", true);
  })();
  const model = scriptedModel([
    failed,
    await events({ type: "token", delta: "complete" }, { type: "done" }),
  ]);
  const observed: HarnessEvent[] = [];
  const result = await runModelRound(model, [], [], new AbortController().signal, {
    event(event) {
      observed.push(event);
    },
  }, fastConfig);

  assert.equal(result.text, "complete");
  assert.equal(result.complete, true);
  assert.deepEqual(
    observed.filter((event) => event.type === "reset"),
    [{ type: "reset", attemptText: "partial" }]
  );
});

test("extracts a leading plan before answer text", async () => {
  const model = scriptedModel([
    await events(
      { type: "token", delta: "## Inspecting inputs\nReading files.\n\n" },
      { type: "token", delta: "Answer" },
      { type: "done" }
    ),
  ]);
  const observed: HarnessEvent[] = [];
  const result = await runModelRound(model, [], [], new AbortController().signal, {
    event(event) {
      observed.push(event);
    },
  }, fastConfig);
  assert.equal(result.text, "Answer");
  assert.ok(observed.some((event) => event.type === "plan" && event.plan.title === "Inspecting inputs"));
});

test("feeds tool results into a bounded second round", async () => {
  const call: ToolCall = {
    id: "call_1",
    type: "function",
    function: { name: "inspect", arguments: "{}" },
  };
  const definition: ToolDefinition = {
    type: "function",
    function: { name: "inspect", description: "inspect", parameters: { type: "object" } },
  };
  const toolHost: ToolHost = {
    definitions: () => [definition],
    async execute() {
      return "observed";
    },
  };
  const model = scriptedModel([
    await events({ type: "tool_call", tool_calls: [call] }, { type: "done" }),
    await events({ type: "token", delta: "Finished" }, { type: "done" }),
  ]);
  const observed: HarnessEvent[] = [];
  const result = await runAgentTurn({
    model,
    messages: [],
    input: "inspect it",
    toolHost,
    signal: new AbortController().signal,
    observer: { event: (event) => { observed.push(event); } },
    config: fastConfig,
  });

  assert.equal(result.text, "Finished");
  assert.equal(result.rounds, 2);
  assert.ok(result.messages.some((message) => message.role === "tool" && message.content === "observed"));
  assert.ok(observed.some((event) => event.type === "tool_result"));
});

test("a cancel mid-stream hands back the exchange instead of throwing it away", async () => {
  // Streams one token, then blocks forever on the abort the test fires.
  const controller = new AbortController();
  const model: ModelClient = {
    async *stream() {
      yield { type: "token", delta: "Watch this" };
      await new Promise((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      });
    },
  };

  let thrown: unknown;
  const pending = runAgentTurn({
    model,
    messages: [],
    input: "go",
    signal: controller.signal,
    config: fastConfig,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error: unknown) => {
    thrown = error;
    return true;
  });

  const error = thrown as AbortedTurnError;
  assert.ok(error instanceof AbortedTurnError);
  assert.equal(error.partialText, "Watch this");
  // The user's message and the partial answer, marked interrupted — a
  // transcript a host can save and the user will recognise.
  assert.deepEqual(error.messages, [
    { role: "user", content: "go" },
    { role: "assistant", content: `Watch this\n\n${INTERRUPT_MARKER}` },
  ]);
});

test("a cancel during tool calls answers every call, including the unstarted ones", async () => {
  const controller = new AbortController();
  const first: ToolCall = { id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } };
  const second: ToolCall = { id: "call_2", type: "function", function: { name: "inspect", arguments: "{}" } };
  const definition: ToolDefinition = {
    type: "function",
    function: { name: "inspect", description: "inspect", parameters: { type: "object" } },
  };
  const toolHost: ToolHost = {
    definitions: () => [definition],
    async execute(_call, signal) {
      // Listen before aborting: a signal that is already aborted never
      // dispatches to a listener added afterwards, and waiting on one hangs.
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        controller.abort();
      });
      return "unreachable";
    },
  };
  const model = scriptedModel([
    await events(
      { type: "token", delta: "Working" },
      { type: "tool_call", tool_calls: [first, second] },
      { type: "done" },
    ),
  ]);

  let thrown: unknown;
  const pending = runAgentTurn({
    model,
    messages: [],
    input: "go",
    toolHost,
    signal: controller.signal,
    config: fastConfig,
  });
  await assert.rejects(pending, (error: unknown) => {
    thrown = error;
    return true;
  });
  const error = thrown as AbortedTurnError;

  // The tool-call assistant message keeps its streamed text; the cancelled
  // calls each get an honest answer; no partial text is duplicated on the
  // trailing message; the final answer is the marker alone.
  const last = error.messages[error.messages.length - 1];
  const caller = error.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.content, INTERRUPT_MARKER);
  assert.equal(caller?.content, "Working");
  assert.deepEqual(caller?.tool_calls, [first, second]);
  const results = error.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 2, "both calls must be answered");
  for (const result of results) {
    assert.match(result.content, /result is unknown/);
    assert.ok(
      caller?.tool_calls?.some((call) => call.id === result.tool_call_id),
      "every result must pair with a call",
    );
  }
});

test("a cancel mid-tool is reported to the host, and only for the call that was running", async () => {
  // The transcript already carried a `[cancelled]` answer for the
  // interrupted call, but nothing was emitted, so a host that reflects
  // events watched the spinner vanish and then rendered a turn in which
  // no command had ever been launched — while the next turn's model was
  // handed the call and its answer. The row has to exist on both sides.
  const controller = new AbortController();
  const running: ToolCall = { id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } };
  const neverStarted: ToolCall = { id: "call_2", type: "function", function: { name: "shell", arguments: "{}" } };
  const definition: ToolDefinition = {
    type: "function",
    function: { name: "shell", description: "run a shell command", parameters: { type: "object" } },
  };
  const toolHost: ToolHost = {
    definitions: () => [definition],
    async execute(_call, signal) {
      // Listen before aborting: a signal that is already aborted never
      // dispatches to a listener added afterwards, and waiting on one hangs.
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        controller.abort();
      });
      return "unreachable";
    },
  };
  const model = scriptedModel([
    await events(
      { type: "tool_call", tool_calls: [running, neverStarted] },
      { type: "done" },
    ),
  ]);
  const observed: HarnessEvent[] = [];

  await assert.rejects(
    runAgentTurn({
      model,
      messages: [],
      input: "go",
      toolHost,
      signal: controller.signal,
      config: fastConfig,
      observer: { event: (event) => { observed.push(event); } },
    }),
    AbortedTurnError,
  );

  // One event, for the call that was in flight, carrying the error the
  // transcript carries — so the cross the user sees and the sentence the
  // model reads cannot be worded differently.
  const results = observed.filter((event) => event.type === "tool_result");
  assert.equal(results.length, 1, "only the running call is reported");
  const reported = results[0] as Extract<HarnessEvent, { type: "tool_result" }>;
  assert.equal(reported.call.id, running.id);
  assert.equal(reported.output, CANCELLED_TOOL_RESULT);
  assert.equal(reported.error, CANCELLED_TOOL_RESULT, "a cancelled call is an error row, not a tick");

  // And the transcript still answers both calls, or a resume is rejected.
  assert.ok(observed.some((event) => event.type === "tool_start"));
});

test("the interrupt marker never fabricates text and never doubles up", () => {
  assert.equal(withInterruptMarker("partly done"), `partly done\n\n${INTERRUPT_MARKER}`);
  assert.equal(withInterruptMarker("  "), INTERRUPT_MARKER);
  assert.equal(withInterruptMarker(""), INTERRUPT_MARKER);
  assert.equal(withInterruptMarker("trailing spaces   "), `trailing spaces\n\n${INTERRUPT_MARKER}`);
});

test("a refused protocol block becomes an error tool result, not answer text", async () => {
  // The malformed-JSON case from the field: a raw newline inside the command
  // string. The block used to be released into the transcript verbatim — the
  // user read the model's broken JSON and the model learned nothing. It is
  // now answered in protocol: a synthetic assistant tool_use plus an error
  // tool result, and a tool_rejected event for the UI's cross.
  const definition: ToolDefinition = {
    type: "function",
    function: { name: "shell", description: "run a shell command", parameters: { type: "object" } },
  };
  const toolHost: ToolHost = {
    definitions: () => [definition],
    execute: async () => {
      throw new Error("no tool may run for a refused block");
    },
  };
  const model = scriptedModel([
    await events(
      // Raw newline inside the JSON string — invalid JSON, valid intent.
      { type: "token", delta: '```json\n{"type": "tool_call", "name": "shell", "arguments": {"command": "Get-ChildItem\n\'.claude\'"}}\n```\n' },
      { type: "done" },
    ),
    await events({ type: "token", delta: "Listed." }, { type: "done" }),
  ]);
  const observed: HarnessEvent[] = [];
  const result = await runAgentTurn({
    model,
    messages: [],
    input: "list .claude",
    toolHost,
    signal: new AbortController().signal,
    observer: { event: (event) => { observed.push(event); } },
    config: fastConfig,
  });

  // The block never reaches the answer text.
  assert.equal(result.text, "Listed.");
  assert.equal(result.rounds, 2);
  assert.ok(!result.messages.some((m) => m.role === "assistant" && m.content.includes("tool_call")));

  // The transcript carries the synthetic pair, ahead of round two.
  const assistantCalls = result.messages.filter(
    (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
  );
  assert.equal(assistantCalls.length, 1);
  const rejectedCall = assistantCalls[0]!.tool_calls![0]!;
  // The name is recovered from the raw body so the transcript line reads
  // "✗ shell", not "✗ unknown" — the call still never runs.
  assert.equal(rejectedCall.function.name, "shell");
  const errorResult = result.messages.find(
    (m) => m.role === "tool" && m.tool_call_id === rejectedCall.id,
  );
  assert.ok(errorResult);
  assert.ok(errorResult.content.includes("was not valid JSON"));
  assert.ok(errorResult.content.includes("newline"), "the reason names the usual repair");

  // The UI event fires, and the round is not treated as empty — no stacked
  // "your previous reply was empty" recovery on top of the rejection.
  assert.ok(observed.some((e) => e.type === "tool_rejected" && e.rejection.reason.includes("JSON")));
  assert.ok(!observed.some((e) => e.type === "status" && e.status.includes("Empty response")));
});

test("a block naming an unoffered tool is refused with the offered list", async () => {
  const definition: ToolDefinition = {
    type: "function",
    function: { name: "read", description: "read", parameters: { type: "object" } },
  };
  const toolHost: ToolHost = {
    definitions: () => [definition],
    execute: async () => {
      throw new Error("no tool may run for a refused block");
    },
  };
  const model = scriptedModel([
    await events(
      { type: "token", delta: '```json\n{"type": "tool_call", "name": "list_files", "arguments": {}}\n```\n' },
      { type: "done" },
    ),
    await events({ type: "token", delta: "Done instead." }, { type: "done" }),
  ]);
  const result = await runAgentTurn({
    model,
    messages: [],
    input: "go",
    toolHost,
    signal: new AbortController().signal,
    config: fastConfig,
  });

  const errorResult = result.messages.find((m) => m.role === "tool");
  assert.ok(errorResult);
  assert.ok(errorResult.content.includes("list_files"));
  assert.ok(errorResult.content.includes("read"), "the reason quotes the offered tools");
  assert.equal(result.text, "Done instead.");
});

test("recovers one empty response", async () => {
  const model = scriptedModel([
    await events({ type: "done" }),
    await events({ type: "token", delta: "Recovered" }, { type: "done" }),
  ]);
  const result = await runAgentTurn({
    model,
    messages: [],
    input: "answer",
    signal: new AbortController().signal,
    config: fastConfig,
  });
  assert.equal(result.text, "Recovered");
  assert.equal(result.rounds, 2);
  assert.ok(result.messages.some((message) => message.content.includes("previous reply was empty")));
});

test("the tool-round budget stops the turn instead of throwing it away", async () => {
  // A model that keeps re-issuing the same call is exactly what the budget is
  // for, and the work the earlier rounds did is still worth keeping. Throwing
  // discarded the whole turn — the user got an error and no files.
  const call = (n: number): ToolCall => ({
    id: `c${n}`,
    type: "function",
    function: { name: "list_dir", arguments: "{}" },
  });
  const scripts = await Promise.all(
    Array.from({ length: 10 }, (_, i) => events({ type: "tool_call", tool_calls: [call(i)] }))
  );
  const toolHost: ToolHost = {
    definitions: () => [
      {
        type: "function",
        function: { name: "list_dir", description: "List a directory.", parameters: { type: "object", properties: {} } },
      },
    ],
    execute: async () => "hello.txt",
  };
  const observed: HarnessEvent[] = [];

  const result = await runAgentTurn({
    model: scriptedModel(scripts),
    messages: [{ role: "user", content: "look around" }],
    input: "look around",
    toolHost,
    signal: new AbortController().signal,
    observer: { event: (event) => { observed.push(event); } },
    config: { ...fastConfig, maxToolRounds: 3 },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.rounds, 3);
  // Every round's result is still in the transcript for the next model turn.
  const toolResults = result.messages.filter((message) => message.role === "tool");
  assert.equal(toolResults.length, 3);
  assert.deepEqual(
    observed.filter((event) => event.type === "needs_user"),
    [{ type: "needs_user", reason: "round_limit", message: "stopped after 3 tool rounds" }]
  );
});

test("rejection-only rounds respect the round budget", async () => {
  // A model that keeps re-emitting a refused block must hit the same budget a
  // tool-looping model does. The budget used to be checked only on rounds
  // with real calls, so a rejection-only round looped past it — unbounded
  // rounds, unbounded tokens, for exactly the case the budget exists for.
  const script: ModelEvent[] = [
    { type: "token", delta: '```json\n{"type": "tool_call", "name": "ghost", "arguments": {}}\n```\n' },
    { type: "done" },
  ];
  const model: ModelClient = {
    async *stream() {
      for (const event of script) yield event;
    },
  };
  const toolHost: ToolHost = {
    definitions: () => [
      { type: "function", function: { name: "real", description: "real", parameters: { type: "object" } } },
    ],
    execute: async () => "x",
  };
  const observed: HarnessEvent[] = [];
  const result = await runAgentTurn({
    model,
    messages: [],
    input: "go",
    toolHost,
    signal: new AbortController().signal,
    observer: { event: (event) => { observed.push(event); } },
    config: { ...fastConfig, maxToolRounds: 2 },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.rounds, 2);
  // Both refusals were still answered in the transcript.
  assert.equal(result.messages.filter((m) => m.role === "tool").length, 2);
  assert.ok(observed.some((e) => e.type === "needs_user" && e.reason === "round_limit"));
});

test("the round budget never fires on a turn that answers", async () => {
  const model = scriptedModel([await events({ type: "token", delta: "done" }, { type: "done" })]);
  const result = await runAgentTurn({
    model,
    messages: [],
    input: "hi",
    toolHost: { definitions: () => [], execute: async () => "" },
    signal: new AbortController().signal,
    config: { ...fastConfig, maxToolRounds: 1 },
  });
  assert.equal(result.text, "done");
  assert.equal(result.blocked, undefined);
});
