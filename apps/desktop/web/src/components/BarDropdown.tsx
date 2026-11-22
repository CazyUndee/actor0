import type { ReactNode } from "react";
import { Caret } from "./Caret";
import { useMenuAnchor } from "./useMenuAnchor";

/**
 * A top-bar menu: the trigger-and-popover shape the session picker uses, shared
 * by every trigger in the selector group.
 *
 * The open state is the caller's. That is the point: when each trigger owned its
 * own `open`, nothing could enforce that only one menu is up at a time, so the
 * session picker stayed open underneath a panel and could be opened again while
 * one was up.
 *
 * Which edge the menu hangs from is *measured*, not declared, and so is its
 * width. A menu opens rightward from its trigger's left edge (the same edge, so
 * it reads as that control's panel) unless the window has more room behind the
 * trigger's right edge, in which case it hangs from that edge instead, and
 * either way it is clamped to the room that side actually has. It was a
 * caller-supplied flag for one commit: the model picker's 460px panel, anchored
 * right at a 1100px window, reached back to x=26 and started against the left
 * wall of the app. A flag cannot know the width it is being asked about; the
 * element can.
 */
export function BarDropdown(props: {
  label: string;
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { wrapRef, menuRef, menuClass, wrapClass } = useMenuAnchor(props.open);

  return (
    <div className={`session-dd ${wrapClass}`} ref={wrapRef}>
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
        <div
          className={`session-menu bar-menu ${menuClass}`}
          role="menu"
          ref={menuRef}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
