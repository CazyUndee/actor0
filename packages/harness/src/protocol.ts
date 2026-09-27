import type { ChatMessage, HarnessEvent, ToolCall, ToolDefinition } from "./types.js";

export type ModelConnection = {
  baseUrl: string;
  apiKey?: string;
  model: string;
};

export type TurnRequest = {
  connection: ModelConnection;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
};

export type TurnResponseEvent =
  | HarnessEvent
  | {
      type: "turn_end";
      text: string;
      complete: boolean;
      toolCalls: ToolCall[];
    };


export function encodeEvent(event: TurnResponseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function* readEvents(
  response: Response
): AsyncGenerator<TurnResponseEvent, void, unknown> {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) yield JSON.parse(data) as TurnResponseEvent;
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const data = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data) yield JSON.parse(data) as TurnResponseEvent;
  }
}

export function parseTurnRequest(value: unknown): TurnRequest {
  if (!isRecord(value)) throw new Error("request body must be an object");
  const connection = value.connection;
  const messages = value.messages;
  if (!isRecord(connection)) throw new Error("connection is required");
  if (typeof connection.baseUrl !== "string" || !connection.baseUrl.trim()) {
    throw new Error("connection.baseUrl is required");
  }
  if (typeof connection.model !== "string" || !connection.model.trim()) {
    throw new Error("connection.model is required");
  }
  if (connection.apiKey !== undefined && typeof connection.apiKey !== "string") {
    throw new Error("connection.apiKey must be a string");
  }
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new Error("tools must be an array");
  }
  return {
    connection: {
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      model: connection.model,
    },
    messages: messages as ChatMessage[],
    tools: (value.tools ?? []) as ToolDefinition[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
