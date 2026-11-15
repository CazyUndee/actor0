import { FACE_CHAR, type Face } from "./conversation";

/** Platform as the desktop shell reports it. "mac" collapses Darwin to the one name that matters for layout. */
export function platform(): "mac" | "windows" | "linux" | "other" {
  const os = typeof window !== "undefined" ? (window as { NL_OS?: string }).NL_OS : undefined;
  if (os === "Darwin") return "mac";
  if (os === "Windows") return "windows";
  if (os === "Linux") return "linux";
  if (typeof navigator !== "undefined") {
    const p = navigator.platform.toLowerCase();
    if (p.includes("mac")) return "mac";
    if (p.includes("win")) return "windows";
    if (p.includes("linux")) return "linux";
  }
  return "other";
}

const FACE_COLOR: Record<Face, string> = {
  idle: "#e89090",
  normal: "#e89090",
  thinking: "#e89090",
  confused: "#e89090",
  suffering: "#e07070",
  dead: "#e07070",
  happy: "#7ee08f",
};

/**
 * The face as vector shapes, in a 64x64 box.
 *
 * Drawn, not typeset. A font glyph (`-_-` in Consolas at 30/64 units) does not
 * survive being scaled to a 16px taskbar icon: the underscores sit on the
  // baseline, the scale drops them below the tile, and what is left reads as a
 * lone dash. Rects and arcs scale exactly, at every size, and match the
 * in-app status mascot glyph for glyph.
 */
function faceShapes(face: Face): string {
  const c = FACE_COLOR[face];
  const dash = (x: number, y: number, w = 14, h = 6): string =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${c}"/>`;
  const ring = (cx: number, cy: number, r = 7): string =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="5"/>`;
  const cross = (cx: number, cy: number, s = 6): string =>
    `<path d="M${cx - s} ${cy - s}L${cx + s} ${cy + s}M${cx + s} ${cy - s}L${cx - s} ${cy + s}" stroke="${c}" stroke-width="5" stroke-linecap="round"/>`;
  const happyEye = (cx: number, cy: number): string =>
    `<path d="M${cx - 8} ${cy + 3}a8 8 0 0 1 16 0" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"/>`;

  switch (face) {
    case "idle":
      // -_-  : two dashes at mid height, one low between them
      return dash(9, 26) + dash(25, 42) + dash(41, 26);
    case "suffering":
    case "dead":
      return cross(19, 32) + cross(45, 32);
    case "happy":
      return happyEye(19, 34) + happyEye(45, 34);
    default:
      // o_o : normal, thinking, confused
      return ring(19, 32) + ring(45, 32);
  }
}

/** An SVG data URI of the mascot face, suitable for a favicon or an <img>. */
export function mascotDataUri(face: Face): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<rect width="64" height="64" rx="14" fill="#1a1a1a"/>'
    + '<rect x="3" y="3" width="58" height="58" rx="11" fill="none" stroke="rgba(125,124,121,0.5)" stroke-width="3"/>'
    + faceShapes(face)
    + "</svg>";
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

/** Keep the document favicon in sync with the mascot's current state. */
export function setFavicon(face: Face): void {
  if (typeof document === "undefined") return;
  const href = mascotDataUri(face);
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = href;
}

/** True when the app is running in a frameless window that needs custom controls. */
export function needsCustomControls(): boolean {
  if (typeof window === "undefined") return false;
  const mode = (window as { NL_MODE?: string }).NL_MODE;
  if (mode === "window") return true;
  return false;
}

/** The glyph text for a face, kept for anything that still wants the characters. */
export function faceText(face: Face): string {
  return FACE_CHAR[face];
}