import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HARNESS_CONFIG, runAgentTurn, runModelRound } from "./harness.js";
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
