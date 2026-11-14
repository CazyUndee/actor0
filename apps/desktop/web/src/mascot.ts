import { FACE_CHAR, type Face } from "./conversation";

/** Platform as the desktop shell reports it. "mac" collapses Darwin to the one name that matters for layout. */
export function platform(): "mac" | "windows" | "linux" | "other" {
  const os = typeof window !== "undefined" ? (window as { NL_OS?: string }).NL_OS : undefined;
  if (os === "Darwin") return "mac";
  if (os === "Windows") return "windows";
  if (os === "Linux") return "linux";
  // Fallback for browser/dev without Neutralino globals.
  if (typeof navigator !== "undefined") {
    const p = navigator.platform.toLowerCase();
    if (p.includes("mac")) return "mac";
    if (p.includes("win")) return "windows";
    if (p.includes("linux")) return "linux";
  }
  return "other";
}

const FACE_COLOR: Record<Face, string> = {
  idle: "#c97a7a",
  normal: "#c97a7a",
  thinking: "#c97a7a",
  confused: "#c97a7a",
  suffering: "#c46b6b",
  dead: "#c46b6b",
  happy: "#6bc47a",
};

/** An SVG data URI of the mascot face, suitable for a favicon or an <img>. */
export function mascotDataUri(face: Face): string {
  const char = FACE_CHAR[face];
  const color = FACE_COLOR[face];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1a1a1a"/>
  <rect x="3" y="3" width="58" height="58" rx="11" fill="none" stroke="rgba(125,124,121,0.5)" stroke-width="3"/>
  <text x="32" y="40" text-anchor="middle" dominant-baseline="middle" font-size="22" font-weight="700" font-family="ui-monospace, Consolas, monospace" fill="${color}">${escapeXml(char)}</text>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  // In borderless window mode we draw our own. In chrome mode the native
  // browser chrome provides controls (and we can't remove it), so custom
  // controls would be redundant/confusing — but the title bar layout still
  // applies. We only show custom control buttons when borderless.
  if (typeof window === "undefined") return false;
  // Neutralino window mode: check if we're in window mode (not chrome/browser).
  const mode = (window as { NL_MODE?: string }).NL_MODE;
  if (mode === "window") return true;
  return false;
}
