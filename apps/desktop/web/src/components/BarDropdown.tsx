import type { ReactNode } from "react";
import { Caret } from "./Caret";

/**
 * A top-bar menu: the trigger-and-popover shape the session picker uses, shared
 * by every trigger in the selector group.
 *
 * The open state is the caller's. That is the point: when each trigger owned its
 * own `open`, nothing could enforce that only one menu is up at a time, so the
 * session picker stayed open underneath a panel and could be opened again while
 * one was up.
 */
export function BarDropdown(props: {
  label: string;
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Which trigger edge the menu hangs from. A menu on the right of the bar has
   * to open inward, or its fixed width runs off the window.
   */
  align?: "start" | "end";
  children: ReactNode;
}) {
  return (
    <div className="session-dd">
      <button
        type="button"
        className="dropdown-trigger"
        title={props.title}
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <span className="dropdown-value">{props.label}</span>
        <span className="dropdown-caret"><Caret open={props.open} /></span>
      </button>
      {props.open ? (
        <div className={`session-menu bar-menu ${props.align === "end" ? "align-end" : ""}`} role="menu">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
