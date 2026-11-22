import { useLayoutEffect, useRef, useState } from "react";

/**
 * Where a top-bar menu hangs: the one measurement both menus share.
 *
 * The session picker and the bar's own dropdowns are separate components ,  the
 * picker has sub-modes (new, delete) and its own open state ,  but there is one
 * right answer to "where does a bar menu go", and both have to give it. It was
 * written twice for one commit and the picker's copy was missing the fuse, so
 * the two menus met the bar differently: exactly the kind of drift a shared
 * measurement prevents.
 *
 * Everything here is measured rather than declared, and in a layout effect, so
 * the correction happens before paint and nothing is seen moving:
 *
 *  - the panel is measured at its own preferred width, with any clamp from the
 *    previous open cleared first, or the second open is narrower than the first;
 *  - it hangs from whichever side of the trigger has more window behind it;
 *  - it is clamped to that side's room, because a 460px panel in a 520px window
 *    fits neither edge, so picking a side was never enough on its own;
 *  - a trigger at the bar's left wall opens from the bar's own left wall (so the
 *    panel and the bar share one vertical line), which is what makes the two
 *    read as a single fused shape.
 */
export function useMenuAnchor(open: boolean): {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  menuClass: string;
  wrapClass: string;
} {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [alignEnd, setAlignEnd] = useState(false);
  const [origin, setOrigin] = useState<"wall" | "caret" | "trigger">("trigger");

  useLayoutEffect(() => {
    if (!open) {
      setAlignEnd(false);
      setOrigin("trigger");
      return;
    }
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;

    const trigger = wrap.getBoundingClientRect();
    menu.style.maxWidth = "";
    menu.style.left = "";
    const natural = menu.offsetWidth;

    const margin = 16;
    const roomRight = window.innerWidth - trigger.left - margin;
    const roomLeft = trigger.right - margin;
    const useEnd = roomLeft > roomRight;
    setAlignEnd(useEnd);
    const room = useEnd ? roomLeft : roomRight;
    if (natural > room) menu.style.maxWidth = `${Math.max(240, room)}px`;

    // A menu opens from the caret of the control to its left, not from its own
    // edge: the caret is where the previous control visibly ends, so the panel
    // reads as continuing the row rather than starting under this trigger. The
    // leftmost has no caret before it, so it opens from the bar's own left wall.
    const bar = wrap.closest(".top-bar")?.getBoundingClientRect();
    const previousCaret = wrap.previousElementSibling?.querySelector(".dropdown-caret");
    const caret = previousCaret?.getBoundingClientRect();
    const caretLeft = caret && caret.width > 0 ? caret.left : undefined;
    const left = caretLeft ?? bar?.left;
    const chained = left !== undefined && !useEnd;
    setOrigin(!chained ? "trigger" : caretLeft !== undefined ? "caret" : "wall");
    wrap.style.setProperty("--menu-left", `${(left ?? trigger.left) - trigger.left}px`);
    if (chained) {
      menu.style.left = `${left! - trigger.left}px`;
      // It may not run past the bar's right wall either.
      const barRoom = (bar?.right ?? window.innerWidth) - left! - 4;
      if (natural > barRoom) menu.style.maxWidth = `${Math.max(240, barRoom)}px`;
    } else if (bar) {
      const barRoom = bar.width - 4;
      if (natural > barRoom) menu.style.maxWidth = `${barRoom}px`;
    }
    wrap.style.setProperty("--menu-width", `${menu.offsetWidth}px`);
  }, [open]);

  const state = [
    "menu-open",
    origin === "wall" ? "flush-left" : "",
    origin === "caret" ? "chained" : "",
    alignEnd ? "align-end" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    wrapRef,
    menuRef,
    wrapClass: open ? state : "",
    menuClass: [
      "fused",
      alignEnd ? "align-end" : "",
      origin === "wall" ? "flush-left" : "",
      origin === "caret" ? "chained" : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
