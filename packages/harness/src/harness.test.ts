import assert from "node:assert/strict";
import test from "node:test";
import { AbortedTurnError, DEFAULT_HARNESS_CONFIG, INTERRUPT_MARKER, runAgentTurn, runModelRound, withInterruptMarker } from "./harness.js";
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
