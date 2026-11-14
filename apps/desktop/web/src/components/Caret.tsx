/**
 * The chevron caret, as an SVG.
 *
 * A text glyph (▾ or ⌄) sits on the font's baseline and comes from a different
 * typeface than the UI text, so it never centres optically. A vector chevron
 * does: it is drawn around the box's own centre, at any size, and the stroke
 * weight matches the hairline aesthetic of the rest of the chrome.
 */
export function Caret({ open, size = 10 }: { open?: boolean; size?: number }) {
  // Collapsed points right (into the thing it opens); open points down.
  return (
    <svg
      className="caret-svg"
      width={size}
      height={size}
      viewBox="0 0 10 10"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }}
    >
      <path d="M3 1.5 L7.5 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
