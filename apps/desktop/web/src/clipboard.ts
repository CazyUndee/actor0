/**
 * The clipboard, as a port.
 *
 * A browser's `navigator.clipboard` is only available in a secure context, and
 * it silently fails when the document does not have focus — the desktop app has
 * a real window, but the same bundle runs in a plain browser and in a test, and
 * a copy that "worked" is worse than one that reported failure. So the sink is a
 * parameter with a browser default, and the shell gets to provide its own
 * (`Neutralino.clipboard`), which works even where the web API is unavailable.
 */

export type ClipboardSink = (text: string) => Promise<boolean>;

/** The browser's async clipboard, with the permission failure turned into a boolean. */
export const browserClipboard: ClipboardSink = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * The current sink. Overridable because the shell's clipboard API is injected
 * when the app boots, and because a test wants a deterministic recorder.
 */
let sink: ClipboardSink = browserClipboard;

/** Point the clipboard at a different implementation (the shell, a test). */
export function setClipboard(next: ClipboardSink): void {
  sink = next;
}

/** Copy text through the current sink, reporting whether it actually landed. */
export async function copyText(text: string): Promise<boolean> {
  return sink(text);
}
