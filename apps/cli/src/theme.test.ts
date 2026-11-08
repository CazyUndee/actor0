import { test } from "node:test";
import assert from "node:assert/strict";
import { color } from "./theme.js";
import { cronix } from "./theme.generated.js";

/** Relative luminance of an sRGB colour (WCAG). */
function luminance(hex: string): number {
  const h = hex.replace(/^#/, "");
  const rgb = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((c) =>
    Number.parseInt(c, 16) / 255,
  );
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

const bg = cronix.color.bg;

test("body text meets WCAG AAA against the background", () => {
  assert.ok(contrast(color.text, bg) >= 7, `${color.text} on ${bg}`);
});

test("muted text meets WCAG AA against the background", () => {
  assert.ok(contrast(color.muted, bg) >= 4.5, `${color.muted} on ${bg}`);
});

test("dim text meets WCAG AA against the background", () => {
  assert.ok(contrast(color.dim, bg) >= 4.5, `${color.dim} on ${bg}`);
});

test("accent text meets WCAG AA against the background", () => {
  assert.ok(contrast(color.accent, bg) >= 4.5, `${color.accent} on ${bg}`);
});

test("status colours meet WCAG AA against the background", () => {
  for (const [name, value] of Object.entries({
    success: color.success,
    warning: color.warning,
    error: color.error,
    info: color.info,
  } as Record<string, string>)) {
    assert.ok(contrast(value, bg) >= 4.5, `${name} (${value}) on ${bg}`);
  }
});

test("frame border meets the 3:1 UI-component bar against the background", () => {
  assert.ok(contrast(color.border, bg) >= 3, `${color.border} on ${bg}`);
});
