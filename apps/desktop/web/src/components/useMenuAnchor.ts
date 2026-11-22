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
} {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [alignEnd, setAlignEnd] = useState(false);
  const [flushLeft, setFlushLeft] = useState(false);

  useLayoutEffect(() => {
    if (!open) {
      setAlignEnd(false);
      setFlushLeft(false);
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

    const bar = wrap.closest(".top-bar")?.getBoundingClientRect();
    const atLeftWall = Boolean(bar) && !useEnd && trigger.left - bar!.left <= 20;
    setFlushLeft(atLeftWall);
    if (atLeftWall) {
      menu.style.left = `${bar!.left - trigger.left}px`;
      const barRoom = bar!.width - 4;
      if (natural > barRoom) menu.style.maxWidth = `${barRoom}px`;
    }
  }, [open]);

  return {
    wrapRef,
    menuRef,
    menuClass: [alignEnd ? "align-end" : "", flushLeft ? "flush-left" : ""].filter(Boolean).join(" "),
  };
}
