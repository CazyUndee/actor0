import type { ChatMessage } from "@actor0/harness";

/**
 * History compaction.
 *
 * A tool-using session grows without bound, and the saved payload is what a
 * resume replays, so something has to give.
 *
 * The obvious answer — keep the last N messages — is the worst available one.
 * It throws away whole exchanges to save bytes that were mostly observational,
 * and it cuts at an arbitrary point, which is how a saved transcript ends up
 * starting with a `tool` result whose call was trimmed away. The API rejects
 * that shape outright, so the session fails on *every* request; a resumed
 * conversation is not degraded, it is dead.
 *
 * So the mechanism is not dropping messages. It is clearing the payload of
 * stale tool results and leaving every message exactly where it was. A cleared
 * result is still a result: the call stays, the pairing stays, the structure
 * stays valid, and the model can still see that the call happened and how big
 * the answer was. What it loses is the bytes, which it can get back by
 * re-running the tool.
 *
 * The invariant, and it is the whole module:
 *
 *   compaction may reduce payloads. It never drops a conversation unit and
 *   never makes a structural cut.
 *
 * There is no budget-driven path that removes anything. If every clearable
 * payload is gone and the history is still over budget, the answer is the
 * intact history: the remaining bulk is user and assistant text, and cutting
 * that would trade a correct conversation for a smaller wrong one.
 *
 * The endpoint does not trim. It rejects a request that does not fit, so an
 * over-budget history is a request that fails, not one that gets smaller on
 * the way out. The request path recovers from that by compacting and asking
 * again once (see `OVERFLOW_RECOVERY_TOKENS` in `turn.ts`); what is kept
 * here is the first line, because a session file that only just fits is a
 * resume that has to recover to work at all.
 *
 * Only *observational* results are clearable. A `write` or `edit` result is
 * the record of a change that was actually made; dropping it would erase the
 * evidence that the work happened, and it is a sentence long anyway.
 *
 * The budget is in tokens and the estimate is deliberately the same crude
 * characters-per-token ratio the provider endpoint uses, so the number here
 * and the number there mean roughly the same thing.
 */

/** Chars per token. Matches the endpoint's own estimate — see its CHARS_PER_TOKEN. */
export const CHARS_PER_TOKEN = 4;

/**
 * Default budget for a persisted history.
 *
 * This is the file a resume replays, and a resume sends the whole file. So the
 * budget is sized against what can be sent back, not against what a session
 * may grow to: a history that only fits because the provider happens to be
 * generous is a resume that breaks on the next model.
 *
 * It also has to be a number that *fires*. The first version of this was 32k
 * tokens, which no realistic session reaches — so the mechanism existed, was
 * tested in isolation, and in practice never ran once. A budget that never
 * binds is not a budget. 16k clears the payloads behind results the model has
 * already moved past, while the results it is still reasoning about stay
 * intact — which is the whole reason this clears payloads instead of cutting
 * turns.
 */
export const DEFAULT_TOKEN_BUDGET = 16_000;

/**
 * Tool results that may be cleared, oldest first.
 *
 * `read` and `shell` return whatever the user asked them to, which is
 * unbounded in both directions — a 50KB file, a 160KB build log. Everything
 * else returns a fixed short sentence about a change that happened.
 *
 * This is checked against the real tool registry in `history.test.ts`, so a
 * tool that is renamed or removed fails a test rather than silently becoming
 * un-clearable.
 */
export const CLEARABLE_TOOLS: ReadonlySet<string> = new Set(["read", "shell"]);

/** Prefix of a cleared result, so a second pass can recognise one. */
const CLEARED_PREFIX = "[result cleared";

/**
 * Budget for the tool results in ONE message.
 *
 * The global budget bounds the whole file, but a single turn can burst past
 * every per-result cap on its own: several `shell` calls in one round, each
 * returning a build log, produce a single recent message that outweighs
 * everything else in the session. Clearing oldest-first does not reach it —
 * the burst is the newest thing in the history. So one user message's tool
 * results are bounded directly: its largest clearable payloads go (in whole,
 * no truncation — see the invariant) until the message's results fit.
 *
 * Sized so that a normal parallel round — a handful of reads, a directory
 * listing — never trips it. 12k chars is an order of magnitude above what
 * those return and a fraction of a build log.
 */
export const PER_MESSAGE_RESULT_BUDGET = 12_000;

export type CompactionOptions = {
  /** Budget for the whole history. */
  maxTokens?: number;
  /** Which tools' results may be cleared. */
  clearable?: ReadonlySet<string>;
  /** Emitted instead of a cleared payload. */
  marker?: (toolName: string, clearedChars: number) => string;
  /**
   * Called for every payload a pass replaces with a marker.
   *
   * Compaction is the only thing this CLI does to a conversation that nobody
   * asked for, and it is invisible from the outside: the transcript on
   * screen keeps showing what each tool returned, because that is what
   * happened and nobody is going to un-see it. So a caller that wants to
   * answer "what can the model no longer read?" has no way to — the array
   * that comes back is the same conversation with different text, and
   * diffing it afterwards is guesswork once a payload was already cleared by
   * an earlier pass. The size reported is the original payload, not the
   * arithmetic saving: what was lost is what the model could once read.
   */
  onClear?: (toolName: string, clearedChars: number) => void;
  /**
   * How many of the newest clearable results are kept whatever the budget says.
   *
   * Zero by default, and the default is not a shrug: the overflow recovery is
   * the last attempt a turn gets, and a result the model is told to re-read is
   * a better outcome than a turn that never starts. Everything else passes a
   * number — see `SESSION_KEEP_RECENT`.
   *
   * A save is the other story. Nothing is failing there, the budget merely
   * wants the file smaller, and the newest results are the ones the model is
   * reasoning about *right now*. Clearing them to save bytes buys a smaller
   * session file with a re-read on the next turn, and ordering the clears
   * oldest-first does not prevent it: the order only says which go first, not
   * which are allowed to go last. A budget large enough for a few ordinary
   * rounds stops at the recent results exactly when the recent results are
   * the only ones left to take, which is the case the floor exists for.
   */
  keepRecent?: number;
};

/**
 * Results a save must not clear, however over budget the file is.
 *
 * Two, not one: the last result is the answer to the question in flight, and
 * the one before it is usually the file that result is about. A round that
 * read three files keeps the last two and loses the first, which the marker
 * names and the model can re-read — the recoverable kind of loss. A round that
 * kept none of them leaves the model reasoning about a result it cannot see,
 * which is the kind that produces a confident wrong answer.
 */
export const SESSION_KEEP_RECENT = 2;

/**
 * The indices of the newest `keepRecent` clearable results in `messages`.
 *
 * Already-cleared results do not count: they hold a marker instead of a
 * payload, so one of them is not working context and protecting it would spend
 * the floor on nothing. An empty or negative count protects nothing, which is
 * what the recovery path asks for.
 */
function protectedResults(
  messages: ChatMessage[],
  clearable: ReadonlySet<string>,
  keepRecent: number,
): ReadonlySet<number> {
  const protectedIndexes = new Set<number>();
  if (keepRecent <= 0) return protectedIndexes;
  const names = toolNamesByCallId(messages);
  for (let i = messages.length - 1; i >= 0 && protectedIndexes.size < keepRecent; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "tool" || isCleared(message.content)) continue;
    const name = names.get(message.tool_call_id ?? "") ?? message.name;
    if (name && clearable.has(name)) protectedIndexes.add(i);
  }
  return protectedIndexes;
}

export const defaultMarker = (toolName: string, clearedChars: number): string =>
  `${CLEARED_PREFIX}: ${toolName} returned ${clearedChars.toLocaleString("en-US")} chars — re-run ${toolName} if needed]`;

/** Is this content already a cleared marker? */
export function isCleared(content: string): boolean {
  return content.startsWith(CLEARED_PREFIX);
}

/**
 * Approximate size of a history, in characters.
 *
 * Counts the text that actually reaches the model: message content, the
 * serialized tool calls, and a small constant per message for its role and
 * framing. Deliberately an estimate — anything exact would need the tokenizer
 * the endpoint uses, and the difference does not change a decision that is
 * this coarse.
 */
export function measureHistory(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.content.length + 24;
    if (message.tool_calls?.length) total += JSON.stringify(message.tool_calls).length;
  }
  return total;
}

/**
 * Map every tool call id to the tool that answered it.
 *
 * Taken from the assistant messages rather than from `message.name` on the
 * result, because `name` is optional on `ChatMessage` and this is the one
 * thing that must not be missing. A result whose call cannot be found is not
 * clearable: guessing wrong would empty a `write` record.
 */
function toolNamesByCallId(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
  }
  return names;
}

/** One indivisible stretch: a message, or a call together with every result it awaits. */
type Unit = ChatMessage[];

/**
 * Repair a history the API would reject, however it got broken.
 *
 * The validity pass behind both compaction entry points, exported because
 * compaction is not the only way a broken history arrives: a session file
 * written by an older build, a hand-edit, or a truncated download all load
 * through `loadSession` untouched, and a resume then sends the broken shape
 * to the provider — which rejects the whole request. Repair on load, like
 * repair on save: a resumed conversation that fails on every request is not
 * degraded, it is dead.
 */
export function repairHistory(messages: ChatMessage[]): ChatMessage[] {
  return keepValidUnits(messages).flat();
}

/**
 * Partition into units, discarding fragments the API would reject.
 *
 * This is a *validity* pass, not a budgeting one, and it runs whatever the
 * budget says. It only ever removes something that was already unanswerable:
 *
 *   - a `tool` message whose call is not in this history. The provider
 *     rejects the whole request on an unpaired result.
 *   - an assistant message whose `tool_calls` never got all of their results.
 *     Rejected just as firmly.
 *
 * A turn interrupted between a call and its results saves a history in exactly
 * that state, and it is *short* — so this is not a rare case, and it is why
 * there is deliberately no "small enough, return it unchanged" fast path. A
 * fast path that skips the only interesting work is a fast path to a broken
 * file.
 */
function keepValidUnits(messages: ChatMessage[]): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    // A `tool` message reached here was not consumed as a result below, so its
    // call is not in this history: it is an orphan.
    if (message.role === "tool") continue;
    if (message.role === "system" || !message.tool_calls?.length) {
      units.push([message]);
      continue;
    }
    const awaited = new Set(message.tool_calls.map((call) => call.id));
    const unit: Unit = [message];
    while (i + 1 < messages.length && awaited.size > 0) {
      const next = messages[i + 1]!;
      if (next.role !== "tool" || !next.tool_call_id || !awaited.has(next.tool_call_id)) break;
      unit.push(next);
      awaited.delete(next.tool_call_id);
      i += 1;
    }
    if (awaited.size === 0) units.push(unit);
  }
  return units;
}

/**
 * Clear the payloads of stale tool results until the history fits, or until
 * there is nothing left that may be cleared.
 *
 * Never removes or reorders a message, so the conversation stays exactly as
 * valid as it was — there is no cut to land badly, and therefore no way to
 * produce an orphaned call. Oldest results go first, because the recent ones
 * are the ones the model is still reasoning about.
 *
 * Returns new message objects for the ones it changed and shares the rest. The
 * caller's array is never mutated: it is the live conversation the UI is
 * rendering, and emptying it here would blank results the user can still see.
 */
export function compactHistory(
  messages: ChatMessage[],
  options: CompactionOptions = {},
): ChatMessage[] {
  const budget = (options.maxTokens ?? DEFAULT_TOKEN_BUDGET) * CHARS_PER_TOKEN;
  const clearable = options.clearable ?? CLEARABLE_TOOLS;
  const marker = options.marker ?? defaultMarker;
  const onClear = options.onClear;
  const keepRecent = options.keepRecent ?? 0;

  // Repair first, always — see `keepValidUnits`. Not budget-driven: a history
  // can be unanswerable and small at the same time.
  const source = keepValidUnits(messages).flat();
  const names = toolNamesByCallId(source);
  const result: ChatMessage[] = source.slice();
  // Computed against the repaired history, not the caller's: repair can drop
  // messages, so an index into the caller's array is not an index into this
  // one, and the floor would protect whichever result happened to sit at that
  // position after the shift.
  const floor = protectedResults(source, clearable, keepRecent);
  let total = measureHistory(source);
  if (total <= budget) return result;

  for (let i = 0; i < result.length && total > budget; i += 1) {
    if (floor.has(i)) continue;
    const message = result[i]!;
    if (message.role !== "tool") continue;
    if (isCleared(message.content)) continue;
    const name = names.get(message.tool_call_id ?? "") ?? message.name;
    if (!name || !clearable.has(name)) continue;

    const replacement = marker(name, message.content.length);
    result[i] = { ...message, content: replacement };
    total -= message.content.length - replacement.length;
    onClear?.(name, message.content.length);
  }

  // Over budget with nothing left to clear. Returning the history intact is
  // the answer, and it is the only answer consistent with the invariant: what
  // remains is user and assistant text, and there is no honest way to make a
  // conversation that says those things smaller.
  return result;
}

/**
 * The per-message budget, applied on its own.
 *
 * The global budget above bounds the whole file, but a single turn can burst
 * past any per-result cap on its own: several `shell` calls in one round, each
 * returning a build log, produce one recent message that outweighs everything
 * else in the session, and oldest-first never reaches it — the burst is the
 * newest thing in the history. So each message's tool results are bounded
 * directly: its largest clearable payloads go, whatever their age, until the
 * group fits. Messages are judged independently, so one huge round does not
 * clear results in innocent neighbours.
 *
 * Runs even when the global budget is met — the two bound different things.
 * Every invariant holds unchanged: clear-only, marker-prefixed, never a cut,
 * caller's array untouched.
 */
export function compactHistoryPerMessage(
  messages: ChatMessage[],
  options: CompactionOptions = {},
): ChatMessage[] {
  const clearable = options.clearable ?? CLEARABLE_TOOLS;
  const marker = options.marker ?? defaultMarker;
  const onClear = options.onClear;
  const names = toolNamesByCallId(messages);
  const result: ChatMessage[] = messages.slice();
  // The floor is history-wide, not per-message: this pass bounds one round's
  // burst, and the burst it is looking at is usually the newest round, so a
  // per-round floor would protect the wrong results entirely.
  const floor = protectedResults(messages, clearable, options.keepRecent ?? 0);

  for (let i = 0; i < result.length; i += 1) {
    const message = result[i]!;
    // The call lives on the ASSISTANT message; the harness records it there
    // and the results follow it. (The tool_use request envelope rides on the
    // assistant turn — a user message never carries tool_calls.)
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;

    // The results this message's calls are awaiting, in file order.
    const awaited = new Set(message.tool_calls.map((call) => call.id));
    const group: number[] = [];
    for (let j = i + 1; j < result.length && awaited.size > 0; j += 1) {
      const next = result[j]!;
      if (next.role !== "tool" || !next.tool_call_id || !awaited.has(next.tool_call_id)) break;
      group.push(j);
      awaited.delete(next.tool_call_id);
    }
    if (group.length === 0) continue;

    let used = 0;
    for (const index of group) used += result[index]?.content.length ?? 0;
    if (used <= PER_MESSAGE_RESULT_BUDGET) continue;

    // Largest first: the burst is what must give, and clearing many small
    // results around one huge one would touch history for no gain.
    const clearableIndexes = group
      .filter((index) => {
        if (floor.has(index)) return false;
        const target = result[index]!;
        if (isCleared(target.content)) return false;
        const name = names.get(target.tool_call_id ?? "") ?? target.name;
        return name !== undefined && clearable.has(name);
      })
      .sort((a, b) => (result[b]?.content.length ?? 0) - (result[a]?.content.length ?? 0));

    for (const index of clearableIndexes) {
      if (used <= PER_MESSAGE_RESULT_BUDGET) break;
      const target = result[index]!;
      const name = names.get(target.tool_call_id ?? "") ?? target.name ?? "tool";
      const replacement = marker(name, target.content.length);
      result[index] = { ...target, content: replacement };
      used -= target.content.length - replacement.length;
      onClear?.(name, target.content.length);
    }
  }

  return result;
}
