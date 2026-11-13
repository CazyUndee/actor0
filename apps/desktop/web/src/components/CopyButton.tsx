import { useState } from "react";
import { copyText } from "../clipboard";

/**
 * A small copy affordance on each entry.
 *
 * The CLI's transcript is selected with the keyboard and copied with Ctrl+C; a
 * mouse-first surface wants the one-click equivalent on the entries that are
 * most often copied — the assistant's answer, a tool's command. The button
 * reports what happened, because a copy that silently does nothing is
 * undiagnosable: a checkmark says it landed, a dash says it did not.
 */
export function CopyButton(props: { text: string; title?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function onCopy(): Promise<void> {
    const ok = await copyText(props.text);
    setState(ok ? "copied" : "failed");
    if (ok) setTimeout(() => setState("idle"), 1_500);
  }

  return (
    <button
      type="button"
      className={`copy-button copy-${state} ${props.className ?? ""}`}
      onClick={() => void onCopy()}
      title={props.title ?? "Copy"}
      aria-label={props.title ?? "Copy"}
    >
      {state === "copied" ? "✓" : state === "failed" ? "×" : "⎘"}
    </button>
  );
}
