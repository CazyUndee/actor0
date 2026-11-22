import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
 *  - the panel hangs from the *bar's* bottom edge, not the trigger's, because
 *    below 820px the bar wraps onto two rows and a first-row trigger ends far
 *    above it;
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
  // Re-running the measurement needs a dependency that changes; a window resize
  // is the one event that can invalidate every number taken here at once.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const bump = (): void => setRevision((value) => value + 1);
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, [open]);

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

    // A menu opens from the caret of the control to its left, not from its own
    // edge: the caret is where the previous control visibly ends, so the panel
    // reads as continuing the row rather than starting under this trigger. The
    // leftmost has no caret before it, so it opens from the bar's own left wall.
    const bar = wrap.closest(".top-bar")?.getBoundingClientRect();
    const previousCaret = wrap.previousElementSibling?.querySelector(".dropdown-caret");
    const caret = previousCaret?.getBoundingClientRect();
    const caretLeft = caret && caret.width > 0 ? caret.left : undefined;

    // Which side of the trigger has more window behind it, then a width that
    // fits that room. A 460px panel in a 520px window fits neither edge, so
    // picking a side was never enough on its own.
    const margin = 16;
    const roomRight = window.innerWidth - trigger.left - margin;
    const roomLeft = trigger.right - margin;
    const useEnd = roomLeft > roomRight;
    setAlignEnd(useEnd);
    const room = useEnd ? roomLeft : roomRight;
    if (natural > room) menu.style.maxWidth = `${Math.max(240, room)}px`;
    // ... and never wider than the bar it hangs from.
    const barRoom = (bar?.width ?? window.innerWidth) - 4;
    if (menu.offsetWidth > barRoom) menu.style.maxWidth = `${Math.max(240, barRoom)}px`;

    // The panel hangs from the *bar's* bottom edge, not the trigger's: below
    // 820px the bar wraps onto two rows, so a first-row trigger ends 24px above
    // the bar's bottom and `top: 100%` would open the panel inside the bar, over
    // the directory line. `- 2` puts the panel's first row exactly on the bar's
    // 2px bottom border, which is what covers it.
    wrap.style.setProperty("--menu-top", `${(bar ? bar.bottom - trigger.top : trigger.height) - 2}px`);

    const chained = caretLeft !== undefined && !useEnd;
    const width = menu.offsetWidth;
    // The leftmost control has no caret before it, so it opens from the bar's
    // own left wall: sharing one vertical line is what makes the panel and the
    // bar read as a single fused shape.
    const wanted = chained ? caretLeft : useEnd ? trigger.right - width : (bar?.left ?? trigger.left);
    const wall = bar?.left ?? margin;
    const finalLeft = Math.min(Math.max(wanted, wall), Math.max(wall, window.innerWidth - width - margin));

    // The x is computed rather than delegated to CSS. `align-end` alone cannot
    // express it (pinned by its right edge, a 420px panel still runs past the
    // left wall at 520px), and a class-based clamp cannot be *measured* in the
    // same pass it is applied in, so the dressing below would classify a panel
    // that is already at the wall as though it were still chained.
    menu.style.left = `${finalLeft - trigger.left}px`;
    // At the bar's own wall the two shapes share an edge and no fillet belongs
    // outside the bar; the bar also squares that corner, so the union is one
    // continuous outline.
    const atWall = Math.abs(finalLeft - wall) <= 1;
    setOrigin(atWall ? "wall" : chained ? "caret" : "trigger");
    wrap.style.setProperty("--menu-left", `${finalLeft - trigger.left}px`);
    wrap.style.setProperty("--menu-width", `${width}px`);
  }, [open, revision]);

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
