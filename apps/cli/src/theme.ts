import { cronix } from "./theme.generated.js";

/**
 * Semantic colour roles for the terminal.
 *
 * Components never reference `cronix.color.*` directly — they use these names.
 * The mapping is the only place that decides "which CronixUI token paints a tool
 * failure", so a token change lands in one file and the vocabulary stays small
 * enough to hold in your head.
 *
 * Ink renders through chalk, which accepts hex, so the generated values are
 * used directly with no further conversion.
 */

export const color = {
  /** Default body text. */
  text: cronix.color.text,
  /** De-emphasised text: hints, paths, timestamps. */
  muted: cronix.color.textMuted,
  /** Barely-there text: rules, inactive affordances. */
  dim: cronix.color.textDim,
  /** The accent that marks the user's own input and interactive affordances. */
  accent: cronix.color.accentLight,
  accentText: cronix.color.accentText,
  success: cronix.color.successText,
  warning: cronix.color.warningText,
  error: cronix.color.errorText,
  info: cronix.color.infoText,
} as const;

export const space = cronix.space;

/**
 * Motion.
 *
 * `--cn-transition-*` are the design system's own durations. A terminal cannot
 * tween, so these set how often the live region redraws while waiting on the
 * model — the nearest honest equivalent of the web UI's spinner cadence.
 */
export const timing = {
  /** Delay between spinner frames, from `--cn-transition-base`. */
  spinnerMs: cronix.transition.base,
  /** Idle tick for the elapsed-time counter. */
  tickMs: cronix.transition.slow,
} as const;

/** Braille spinner — dense enough to read as rotation at this frame rate. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Glyphs used for completed tool calls, one per status. */
export const toolGlyph = {
  ok: "✓",
  error: "✗",
} as const;

/** Horizontal rule, drawn in the dimmest token so it recedes. */
export const rule = (width: number): string => "─".repeat(Math.max(0, width));
