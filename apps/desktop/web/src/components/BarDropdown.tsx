import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Caret } from "./Caret";

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
 * trigger's right edge, in which case it hangs from that edge instead — and
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [alignEnd, setAlignEnd] = useState(false);

  useLayoutEffect(() => {
    if (!props.open) {
      setAlignEnd(false);
      return;
    }
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;
    const trigger = wrap.getBoundingClientRect();
    // Measure the menu's own preferred width with any clamp from a previous open
    // removed, or the second open is narrower than the first.
    menu.style.maxWidth = "";
    const natural = menu.offsetWidth;
    // A layout effect runs before paint, so neither the side nor the clamp is a
    // visible jump.
    const margin = 16;
    const roomLeft = window.innerWidth - trigger.left - margin;
    const roomRight = trigger.right - margin;
    // Hang from whichever side of the trigger has more window behind it, then
    // clamp to that room: a 460px panel in a 520px window fits neither edge, so
    // the choice alone was never enough.
    const useEnd = roomRight > roomLeft;
    setAlignEnd(useEnd);
    const room = useEnd ? roomRight : roomLeft;
    if (natural > room) menu.style.maxWidth = `${Math.max(240, room)}px`;
  }, [props.open]);

  return (
    <div className="session-dd" ref={wrapRef}>
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
        <div className={`session-menu bar-menu ${alignEnd ? "align-end" : ""}`} role="menu" ref={menuRef}>
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
