import type { HarnessEvent, ToolCall, Usage } from "@actor0/harness";

/**
 * The CLI's view of a conversation, derived purely from harness events.
 *
 * This is deliberately a reducer and not React state. Everything interesting
 * about rendering a turn — above all the `reset` event, where the harness
 * rewinds visible output before retrying — is logic, and logic that can only
 * be exercised through a terminal is logic nobody will test. Keeping it pure
 * means the streaming contract is verifiable without spawning a TTY.
 *
 * The split mirrors the terminal's own split: `entries` are finished and scroll
 * away permanently, `live` is the volatile region redrawn in place.
 */

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; partial: boolean }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; target: string; status: "ok" | "error"; output: string }
  | { kind: "notice"; tone: "info" | "warn" | "error"; text: string }
  | { kind: "help" }
  | { kind: "plan"; title: string; plan: string };

export type Live = {
  /** Assistant text accumulated so far in this attempt. */
  text: string;
  /** Reasoning accumulated so far in this attempt. */
  reasoning: string;
  /** Short status line describing what the agent is doing right now. */
  status?: string;
  /** Tool currently executing, if any. */
  tool?: { name: string; target: string };
  /** Set when the harness rewound output and is retrying. */
  retrying?: { attempt: number };
  /** True once the harness reports the answer is incomplete. */
  partial: boolean;
};

export type Blocked = { reason: string; message: string };

export type ConversationState = {
  entries: Entry[];
  live: Live;
  /** Set when the harness stopped because it could not make progress. */
  blocked?: Blocked;
  /**
   * Length of `entries` when the current model attempt began. A `reset`
   * truncates back to it: reasoning that was flushed mid-attempt (by a
   * tool_call or plan) describes a discarded attempt, and leaving it in the
   * transcript shows the model thinking about work that never happened.
   */
  attemptEntries?: number;
};

export const emptyLive = (): Live => ({ text: "", reasoning: "", partial: false });

export const initialConversation = (): ConversationState => ({ entries: [], live: emptyLive() });

/**
 * Echo the user's message into the transcript.
 *
 * This is also the act of un-blocking: the banner's own hint is "reply to
 * continue", so a reply must retire the banner that asked for it. Clearing it
 * here (and only here) means a stopped turn's banner lives exactly as long as
 * the stop does — through the idle period it describes, and not one frame into
 * the turn that answers it. Nothing else clears it, which is how a turn that
 * stopped once used to wear "the agent needs you" for the rest of the session.
 */
export function withUserInput(state: ConversationState, text: string): ConversationState {
  return { ...state, entries: [...state.entries, { kind: "user", text }], blocked: undefined };
}

export function withNotice(
  state: ConversationState,
  tone: "info" | "warn" | "error",
  text: string,
): ConversationState {
  return { ...state, entries: [...state.entries, { kind: "notice", tone, text }] };
}

/** Show the command list in the transcript. */
export function withHelp(state: ConversationState): ConversationState {
  return { ...state, entries: [...state.entries, { kind: "help" }] };
}

/** Total tokens across every usage frame reported during the turn. */
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

/** A short, readable description of what a tool call is about to touch. */
export function describeCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed argument blob is the tool's problem to report, not the UI's.
  }
  // `command` is a whole command line, so it is collapsed to one line: a
  // multi-line shell script printed into a transcript wraps, pushes the
  // composer off the bottom, and the first line is what identifies it.
  const command = args.command;
  if (typeof command === "string" && command) return command.replace(/\s+/g, " ").trim();
  for (const key of ["path", "file", "target"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * Promote in-flight reasoning to a permanent entry, if there is any.
 *
 * Reasoning is volatile while it streams — it belongs in the live region until
 * something permanent is about to be written after it. `done` used to be the
 * only place that promotion happened, but a tool call commits the moment its
 * result lands, so a turn that thought, then called a tool, then answered
 * rendered as tool, thought, answer. The thinking read as a reaction to the tool
 * rather than the reason for it, which inverts the only causal order the user
 * actually sees.
 *
 * Flushing before every permanent entry is what puts the transcript back in the
 * order things happened. It is a no-op when nothing is pending, so calling it
 * defensively costs nothing.
 */
function flushReasoning(state: ConversationState): ConversationState {
  const text = state.live.reasoning.trim();
  if (!text) return state;
  return {
    ...state,
    entries: [...state.entries, { kind: "reasoning", text }],
    live: { ...state.live, reasoning: "" },
  };
}

/**
 * Apply one harness event.
 *
 * The two events that carry real design weight:
 *
 *   - `reset` — the harness discarded a partial attempt and is retrying. The
 *     live text *must* be cleared, or the discarded tokens stay on screen and
 *     the user watches the same sentence being written twice. `attemptText` is
 *     the text that was thrown away, so it is surfaced as a notice rather than
 *     silently dropped.
 *
 *   - `done` — the turn's answer is final, so the accumulated live text is
 *     promoted to a permanent entry and the live region is cleared.
 */
export function applyEvent(state: ConversationState, event: HarnessEvent): ConversationState {
  switch (event.type) {
    case "token":
      return { ...state, live: { ...state.live, text: state.live.text + event.delta } };

    case "reasoning":
      return { ...state, live: { ...state.live, reasoning: state.live.reasoning + event.delta } };

    case "status":
      return { ...state, live: { ...state.live, status: event.status } };

    case "plan": {
      // A plan is permanent output, so anything the model thought on the way to
      // it belongs in front of it.
      const flushed = flushReasoning(state);
      return {
        ...flushed,
        entries: [
          ...flushed.entries,
          { kind: "plan", title: event.plan.title, plan: event.plan.plan },
        ],
      };
    }

    case "attempt_start":
      // Snapshot for the matching reset. Committed entries from earlier
      // attempts (and earlier turns) stay untouched.
      return { ...state, attemptEntries: state.entries.length };

    case "reset": {
      const attempt = (state.live.retrying?.attempt ?? 0) + 1;
      const discarded = event.attemptText.trim();
      // Drop what this attempt flushed mid-stream. The snapshot is
      // `attemptEntries`; without it, reasoning flushed on a tool_call before
      // the failure stayed in the transcript as thinking about work that was
      // thrown away. Older hosts that never saw attempt_start have no
      // snapshot — respect that (undefined) and keep everything, the old
      // behaviour.
      const base = state.attemptEntries ?? state.entries.length;
      const kept = state.entries.slice(0, base);
      return {
        entries: discarded
          ? [...kept, { kind: "notice", tone: "warn", text: `connection interrupted — retrying (attempt ${attempt})` }]
          : kept,
        live: { ...emptyLive(), retrying: { attempt } },
        blocked: undefined,
        attemptEntries: undefined,
      };
    }

    case "tool_start":
      return {
        ...state,
        live: { ...state.live, tool: { name: event.call.function.name, target: describeCall(event.call) } },
      };

    case "tool_result": {
      // No "denied" state: nothing here is gated, so a tool result is either a
      // result or an error, and guessing at a third thing from its text would
      // only mislabel it.
      const entry: Entry = {
        kind: "tool",
        name: event.call.function.name,
        target: describeCall(event.call),
        status: event.error ? "error" : "ok",
        output: event.output,
      };
      // The tool line is finished, so it becomes permanent and the live
      // spinner is cleared in the same step. Any thinking that led here is
      // committed first, or it would surface later as if the tool had prompted it.
      const flushed = flushReasoning(state);
      return { ...flushed, entries: [...flushed.entries, entry], live: { ...flushed.live, tool: undefined } };
    }

    case "tool_call": {
      // The model has finished thinking and decided to act. That is the moment
      // the thinking becomes history, not the moment the turn ends.
      const flushed = flushReasoning(state);
      // Anything the model streamed on its way to the call is the round's own
      // text, and the harness stores it on the tool-call message — so the
      // transcript must store it too, or the next round's tokens append to it
      // and `done` promotes the concatenation as one answer. Committing it
      // here is what keeps a two-round turn rendering as two messages instead
      // of one run-on. A tool call with no prose commits nothing.
      const text = flushed.live.text.trim();
      if (!text) return flushed;
      return {
        ...flushed,
        entries: [...flushed.entries, { kind: "assistant", text, partial: true }],
        live: { ...flushed.live, text: "" },
      };
    }

    case "tool_rejected": {
      // A refused protocol block is a failed call, and it is shown exactly
      // like one: a cross, the name the model asked for, and the reason. It
      // must never reach the answer text — the old behaviour released the raw
      // JSON into the transcript, which taught the model nothing and made the
      // user read its malformed output. No tool ran, so there is no output to
      // show beyond the rejection sentence itself.
      const flushed = flushReasoning(state);
      const entry: Entry = {
        kind: "tool",
        name: event.rejection.name,
        target: "protocol block",
        status: "error",
        output: event.rejection.reason,
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
      // is where a final thought belongs. Anything already committed by an
      // earlier tool call is long since in `entries` and is not repeated.
      const flushed = flushReasoning(state);
      return { ...flushed, entries: [...flushed.entries, answer], live: emptyLive() };
    }

    case "needs_user":
      return {
        ...state,
        live: emptyLive(),
        blocked: { reason: event.reason, message: event.message },
      };

    case "error":
      return {
        ...state,
        entries: [...state.entries, { kind: "notice", tone: "error", text: event.message }],
        live: emptyLive(),
      };

    default:
      return state;
  }
}
