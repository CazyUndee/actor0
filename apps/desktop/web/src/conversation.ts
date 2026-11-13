import type { ChatMessage, HarnessEvent, ToolCall, ToolResult, Usage } from "@actor0/harness";

/**
 * The conversation, derived purely from harness events.
 *
 * Deliberately a reducer and not React state. Everything interesting about
 * rendering a turn is logic, and logic that can only be exercised by looking at
 * a window is logic nobody will test. Keeping it pure means the streaming
 * contract — above all `reset`, where the harness rewinds visible output before
 * retrying — is verifiable without a browser.
 *
 * The split mirrors the CLI's: `entries` are finished and scroll away
 * permanently, `live` is the volatile region redrawn in place.
 */

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; partial: boolean }
  | { kind: "reasoning"; text: string; durationSeconds?: number }
  | { kind: "tool"; name: string; target: string; status: "ok" | "error"; output: ToolResult<unknown> }
  | { kind: "plan"; title: string; plan: string }
  | { kind: "help" };

export type Live = {
  /** Assistant text accumulated so far in this attempt. */
  text: string;
  /** Reasoning accumulated so far in this attempt. */
  reasoning: string;
  /** Short status line describing what the agent is doing right now. */
  status?: string;
  /** Tool currently executing, if any. */
  tool?: { name: string; target: string };
  /** True after a tool result lands and before the model starts answering. */
  readingToolOutput?: boolean;
  /** Set when the harness rewound output and is retrying. */
  retrying?: { attempt: number };
  /** True once the harness reports the answer is incomplete. */
  partial: boolean;
};

export type Blocked = { reason: string; message: string };

export type ConversationState = {
  entries: Entry[];
  live: Live;
  /**
   * The one line of status the composer shows — "started a new conversation",
   * "retrying", a failure. It is state, not a transcript entry: these lines are
   * about the interface, and a transcript full of them buries the answer the
   * user asked for. Replacing rather than appending is the same decision seen
   * from the other side.
   */
  notice?: { tone: "info" | "warn" | "error"; text: string };
  /** Set when the harness stopped because it could not make progress. */
  blocked?: Blocked;
  /**
   * Length of `entries` when the current model attempt began. A `reset`
   * truncates back to it: reasoning flushed mid-attempt (by a tool call or a
   * plan) describes a discarded attempt, and leaving it in the transcript shows
   * the model thinking about work that never happened.
   */
  attemptEntries?: number;
};

export const emptyLive = (): Live => ({ text: "", reasoning: "", partial: false });

export const initialConversation = (): ConversationState => ({ entries: [], live: emptyLive() });

/** A short, readable description of what a tool call is about to touch. */
export function describeCall(call: ToolCall): string {
  const args = (() => {
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || "{}");
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  // `command` is a whole command line, so it is collapsed to one line: a
  // multi-line script printed into the transcript wraps, pushes the composer off
  // the bottom, and the first line is what identifies it.
  const command = args.command;
  if (typeof command === "string" && command) return command.replace(/\s+/g, " ").trim();
  for (const key of ["path", "file", "target", "pattern", "query", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * Rebuild transcript entries from stored messages, for a resumed session.
 *
 * Stored messages carry the whole transcript but the UI's `entries` are built
 * through harness events during a turn, so without this a resumed session shows
 * an empty transcript even though the model can see the conversation.
 */
export function entriesFromMessages(messages: ChatMessage[]): Entry[] {
  const entries: Entry[] = [];
  const results = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) results.set(message.tool_call_id, message);
  }
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string" && message.content.trim()) entries.push({ kind: "user", text: message.content });
      continue;
    }
    if (message.role !== "assistant") continue;
    const content = typeof message.content === "string" ? message.content : "";
    const partial = /\n\n\[(interrupted|failed|cut off at the output limit)\]$/.test(content);
    const text = content.replace(/\n\n\[(interrupted|failed|cut off at the output limit)\]$/, "").trim();
    if (text) entries.push({ kind: "assistant", text, partial });
    for (const call of message.tool_calls ?? []) {
      const result = results.get(call.id);
      const resultText = result?.content ?? "";
      const isError = resultText.startsWith("Tool failed:") || resultText.includes("[cancelled]");
      entries.push({
        kind: "tool",
        name: call.function.name,
        target: describeCall(call),
        status: isError ? "error" : "ok",
        output: { data: resultText, text: resultText, isError },
      });
    }
  }
  return entries;
}

/**
 * Echo the user's message into the transcript.
 *
 * This is also the act of un-blocking: the banner's own hint is "reply to
 * continue", so a reply must retire the banner that asked for it. Clearing it
 * here — and only here — means a stopped turn's banner lives exactly as long as
 * the stop does.
 */
export function withUserInput(state: ConversationState, text: string): ConversationState {
  return { ...state, entries: [...state.entries, { kind: "user", text }], blocked: undefined, notice: undefined };
}

/** Show the command list in the transcript — a reference the user returns to. */
export function withHelp(state: ConversationState): ConversationState {
  return { ...state, entries: [...state.entries, { kind: "help" }] };
}

export function withNotice(state: ConversationState, tone: "info" | "warn" | "error", text: string): ConversationState {
  return { ...state, notice: { tone, text } };
}

export function totalUsage(usage: Usage[]): Usage {
  return usage.reduce<Usage>(
    (acc, item) => ({
      prompt_tokens: acc.prompt_tokens + (item.prompt_tokens ?? 0),
      completion_tokens: acc.completion_tokens + (item.completion_tokens ?? 0),
      total_tokens: acc.total_tokens + (item.total_tokens ?? 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  );
}

/** A token count as a compact string: 1_234 → "1.2k", 2_500_000 → "2.5M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Promote in-flight reasoning to a permanent entry, if there is any.
 *
 * Reasoning is volatile while it streams; it belongs in the transcript the
 * moment something permanent is about to be written after it, or a turn that
 * thought, then called a tool, then answered renders as tool, thought, answer —
 * which inverts the only causal order the user actually sees.
 */
function flushReasoning(
  state: ConversationState,
  timing?: { nowMs?: number; reasoningStartedAtMs?: number | null },
): ConversationState {
  const text = state.live.reasoning.trim();
  if (!text) return state;
  const durationSeconds =
    timing?.reasoningStartedAtMs != null && timing?.nowMs != null
      ? Math.max(0, timing.nowMs - timing.reasoningStartedAtMs) / 1000
      : undefined;
  return {
    ...state,
    entries: [...state.entries, { kind: "reasoning", text, ...(durationSeconds != null ? { durationSeconds } : {}) }],
    live: { ...state.live, reasoning: "" },
  };
}

/**
 * Apply one harness event.
 *
 * The two that carry real design weight:
 *
 *   - `reset` — the harness discarded a partial attempt and is retrying. The
 *     live text *must* be cleared, or the discarded tokens stay on screen and the
 *     user watches the same sentence written twice.
 *   - `done` — the answer is final, so the accumulated live text is promoted to a
 *     permanent entry and the live region is cleared.
 */
export function applyEvent(
  state: ConversationState,
  event: HarnessEvent,
  timing?: { nowMs?: number; reasoningStartedAtMs?: number | null },
): ConversationState {
  switch (event.type) {
    case "token": {
      // The first answer token means thinking is done: flush pending reasoning
      // to a committed entry before the answer starts, so the "thinking" block
      // disappears the moment the model stops thinking.
      const flushed = flushReasoning(state, timing);
      return { ...flushed, live: { ...flushed.live, text: flushed.live.text + event.delta, readingToolOutput: false } };
    }

    case "reasoning":
      return { ...state, live: { ...state.live, reasoning: state.live.reasoning + event.delta, readingToolOutput: false } };

    case "status":
      return { ...state, live: { ...state.live, status: event.status } };

    case "plan": {
      // A plan is permanent output, so anything the model thought on the way to
      // it belongs in front of it.
      const flushed = flushReasoning(state, timing);
      return {
        ...flushed,
        entries: [...flushed.entries, { kind: "plan", title: event.plan.title, plan: event.plan.plan }],
      };
    }

    case "attempt_start":
      // Snapshot for the matching reset. Committed entries from earlier
      // attempts and earlier turns stay untouched.
      return { ...state, attemptEntries: state.entries.length };

    case "reset": {
      const attempt = (state.live.retrying?.attempt ?? 0) + 1;
      const discarded = event.attemptText.trim();
      const base = state.attemptEntries ?? state.entries.length;
      return {
        entries: state.entries.slice(0, base),
        notice: discarded
          ? { tone: "warn" as const, text: `connection interrupted — retrying (attempt ${attempt})` }
          : state.notice,
        live: { ...emptyLive(), retrying: { attempt } },
        blocked: undefined,
        attemptEntries: undefined,
      };
    }

    case "tool_start":
      return { ...state, live: { ...state.live, tool: { name: event.call.function.name, target: describeCall(event.call) } } };

    case "tool_result": {
      const entry: Entry = {
        kind: "tool",
        name: event.call.function.name,
        target: describeCall(event.call),
        status: event.error ? "error" : "ok",
        output: event.output,
      };
      // The tool line is finished, so it becomes permanent and the live spinner
      // is cleared in the same step. Thinking that led here is committed first,
      // or it surfaces later as if the tool had prompted it.
      const flushed = flushReasoning(state, timing);
      return { ...flushed, entries: [...flushed.entries, entry], live: { ...flushed.live, tool: undefined, readingToolOutput: true } };
    }

    case "tool_call": {
      // The model has finished thinking and decided to act — the moment the
      // thinking becomes history, not the moment the turn ends.
      const flushed = flushReasoning(state, timing);
      // Anything streamed on the way to the call is this round's own text, and
      // the harness stores it on the tool-call message, so the transcript must
      // store it too: otherwise the next round's tokens append to it and `done`
      // promotes the concatenation as one answer.
      const text = flushed.live.text.trim();
      if (!text) return flushed;
      return {
        ...flushed,
        entries: [...flushed.entries, { kind: "assistant", text, partial: true }],
        live: { ...flushed.live, text: "" },
      };
    }

    case "tool_rejected": {
      // A refused protocol block is a failed call, shown exactly like one. It
      // must never reach the answer text: the old behaviour released the raw
      // JSON into the transcript, which taught the model nothing and made the
      // user read its malformed output.
      const flushed = flushReasoning(state, timing);
      const entry: Entry = {
        kind: "tool",
        name: event.rejection.name,
        target: "protocol block",
        status: "error",
        output: { data: event.rejection.reason, text: event.rejection.reason },
      };
      return { ...flushed, entries: [...flushed.entries, entry] };
    }

    case "provider":
      return { ...state, live: { ...state.live, status: `via ${event.name}` } };

    case "usage":
      return state;

    case "partial":
      return { ...state, live: { ...state.live, partial: true } };

    case "done": {
      const text = state.live.text || event.text;
      const answer: Entry = { kind: "assistant", text, partial: !event.complete };
      // Whatever is still pending goes in immediately before the answer, which
      // is where a final thought belongs.
      const flushed = flushReasoning(state, timing);
      return { ...flushed, entries: [...flushed.entries, answer], live: emptyLive(), notice: undefined };
    }

    case "needs_user":
      return {
        ...state,
        live: emptyLive(),
        blocked: { reason: event.reason, message: event.message },
        notice: undefined,
      };

    case "error":
      return { ...state, live: emptyLive(), notice: { tone: "error", text: event.message } };

    default:
      return state;
  }
}

/** The face the mascot shows, derived from the same state the CLI derives it from. */
export type Face = "idle" | "normal" | "thinking" | "confused" | "suffering" | "dead" | "happy";

export function stateFace(input: {
  live: Live;
  lastEntry?: Entry;
  notice?: { tone: "info" | "warn" | "error"; text?: string };
  blocked: boolean;
  busy: boolean;
}): Face {
  const { live, lastEntry, notice, blocked, busy } = input;
  // A failure is status rather than the last thing said, so the grim face is
  // read off the notice line, not off the transcript.
  if (notice?.tone === "error") return "dead";
  if (lastEntry?.kind === "tool" && lastEntry.status === "error") return "suffering";
  if (blocked) return "confused";
  if (live.reasoning.trim()) return "thinking";
  if (busy) return "normal";
  if (lastEntry?.kind === "assistant") return "happy";
  return "idle";
}

export const FACE_CHAR: Record<Face, string> = {
  idle: "-_-",
  normal: "o_o",
  thinking: "o_o",
  confused: "o_o",
  suffering: "x_x",
  dead: "x_x",
  happy: "ᴖᴥᴖ",
};
