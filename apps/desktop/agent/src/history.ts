import type { ChatMessage } from "@actor0/harness";

/**
 * Transcript hygiene, for sessions this host saves.
 *
 * Two jobs, both about the *shape* of a conversation rather than its content:
 *
 *  - `repairHistory` makes a transcript API-valid. A saved file can hold a tool
 *    result whose call is gone, or a call whose results never landed, and a
 *    provider rejects that shape outright — on every request, until the session
 *    dies. Repairing on load is what makes a resume possible at all.
 *  - `compactHistory` clears the *payloads* of tool results the model has moved
 *    past, without moving or dropping a single message. A cut that removed a
 *    message would strand the tool result that answers it; clearing content
 *    keeps every message exactly where it was and keeps the transcript valid.
 */

/** A tool result longer than this is a candidate for clearing when stale. */
const PAYLOAD_CHARS = 4_000;

/** How many of the newest tool results are always kept intact. */
export const KEEP_RECENT = 6;

/** True when `value` has the minimum shape of a chat message. */
export function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === "string" && typeof message.content === "string";
}

/** The ids of tool calls that appear on some assistant message. */
function callIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) ids.add(call.id);
  }
  return ids;
}

/**
 * Make a transcript valid for the provider, in place, keeping order.
 *
 * Three repairs, each fixing a shape a provider refuses:
 *
 *  1. A `tool` message whose `tool_call_id` no assistant message ever declared
 *     is dropped — it is an answer to a question that is not in the transcript.
 *  2. An assistant `tool_calls` entry with no matching `tool` result gets one,
 *     synthesized: the call happened, the result is unknown, and inventing a
 *     silence is worse than saying so.
 *  3. A `tool` message with no id is dropped: it cannot be matched to a call,
 *     so it is noise the provider will reject.
 */
export function repairHistory(messages: ChatMessage[]): ChatMessage[] {
  const declared = callIds(messages);
  const answered = new Set(messages.filter((m) => m.role === "tool" && m.tool_call_id).map((m) => m.tool_call_id!));
  const out: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !declared.has(message.tool_call_id)) continue;
      out.push(message);
      continue;
    }
    out.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    // Every call this message declares must be answered before the next
    // assistant turn, or the request is rejected.
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      out.push({
        role: "tool",
        content: "[not recorded] The result of this call is not in the saved transcript.",
        tool_call_id: call.id,
        name: call.function.name,
      });
      answered.add(call.id);
    }
  }
  return out;
}

/**
 * Clear the payloads of stale tool results, keeping the newest ones intact.
 *
 * Clear-only by design: no message is dropped, none is reordered, and a
 * conversation unit is never cut. The newest `keepRecent` tool results — the
 * ones the model is most likely still reasoning about — are left alone, and a
 * cleared result says in its own text that it was cleared, because a model
 * handed an empty string reads it as "the tool returned nothing".
 */
export function compactHistory(messages: ChatMessage[], options: { keepRecent?: number } = {}): ChatMessage[] {
  const keep = options.keepRecent ?? KEEP_RECENT;
  const toolIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role === "tool") toolIndexes.push(i);
  }
  const protectedFrom = toolIndexes.length - keep;
  const toClear = new Set<number>();
  for (let i = 0; i < toolIndexes.length; i += 1) {
    const index = toolIndexes[i]!;
    const content = messages[index]!.content;
    if (i >= protectedFrom) continue;
    if (typeof content === "string" && content.length > PAYLOAD_CHARS) toClear.add(index);
  }
  if (toClear.size === 0) return messages;
  return messages.map((message, index) =>
    toClear.has(index) ? { ...message, content: "[tool output cleared from the saved transcript to save context]" } : message,
  );
}

/** Strip a leading system message before persisting — it is re-seeded on load. */
export function forStorage(messages: ChatMessage[]): ChatMessage[] {
  return messages[0]?.role === "system" ? messages.slice(1) : messages;
}
