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
  /** Default body text — the highest-contrast role; everything else defers to it. */
  text: cronix.color.text,
  /** De-emphasised but still readable: hints, paths, timestamps. */
  muted: cronix.color.textMuted,
  /**
   * Subordinate text: rules, fence markers, inactive affordances.
   *
   * Deliberately below WCAG AA so it recedes behind body and muted text —
   * `dim` must not compete for attention. CronixUI's `textDim` (#444342,
   * ~2:1) is the right token: visible but clearly secondary. Raising it to
   * `textMuted` made every fence marker and hint shout, destroying the
   * visual hierarchy.
   */
  dim: cronix.color.textDim,
  /**
   * The accent that marks the user's own input and interactive affordances.
   * `accentLight` (#8a3535) is only ~2.5:1 as text, so it is remapped to
   * `accentText` (#c97a7a, ~6.2:1), the token designed for accent-coloured
   * text on the dark background.
   */
  accent: cronix.color.accentText,
  accentText: cronix.color.accentText,
  /**
   * Actual crimson for filled accents and box borders — the user's own
   * message blocks and the composer box. Distinct from `accent`: `accent`
   * is a readable text colour (#c97a7a), which reads as pink on a border;
   * `crimson` (#6b2323) is the design system's real crimson red.
   */
  crimson: cronix.color.accent,
  success: cronix.color.successText,
  warning: cronix.color.warningText,
  error: cronix.color.errorText,
  info: cronix.color.infoText,
  /** Filled background for highlighted blocks (tool calls). */
  surface: cronix.color.surface2,
  /**
   * The frame's border grey — visible enough to define structure without
   * competing with the content inside it.
   */
  border: cronix.color.textMuted,
  /**
   * Text-selection background. The surface tokens are all dark fills meant to
   * sit under text; a selection has to be legible the other way, so it reuses
   * the accent's fill at low saturation rather than inventing a token.
   */
  selectionBg: cronix.color.surface3,
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
