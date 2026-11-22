import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The app's own right-click menu.
 *
 * A WebView's default menu offers "Reload", "Inspect" and "Save as…": three
 * things this app has no use for, and nothing it is made of. So the default is
 * suppressed and this replaces it with the actions the transcript actually has,
 * decided by what was right-clicked.
 *
 * It is positioned from the pointer and clamped to the window: a menu opened at
 * the bottom-right corner of a 520px window has to fit inside it, and a menu
 * that runs off the edge is a menu whose last item cannot be clicked.
 */

export type MenuAction = {
  label: string;
  /** Secondary line, for an action whose effect is not obvious from its name. */
  hint?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** A visual break above this item: options that act on the conversation. */
  separatorBefore?: boolean;
  danger?: boolean;
};

export function ContextMenu(props: {
  x: number;
  y: number;
  actions: MenuAction[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number }>({ left: props.x, top: props.y });

  // Clamp to the window before paint, so the menu never renders off an edge even
  // for a frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `offsetWidth`/`offsetHeight`, not `getBoundingClientRect`: the menu animates
    // from `scaleY(0.55)`, and the rect reports the *transformed* box, so a clamp
    // measured with it puts a 195px menu 88px too low and it hangs off the bottom
    // edge of the window. The offset box is the untransformed layout size, which
    // is the size the menu must fit in once the animation lands.
    const margin = 8;
    const left = Math.max(margin, Math.min(props.x, window.innerWidth - el.offsetWidth - margin));
    const top = Math.max(margin, Math.min(props.y, window.innerHeight - el.offsetHeight - margin));
    setPlaced({ left, top });
  }, [props.x, props.y, props.actions.length]);

  // Escape closes it, a click anywhere else closes it, and so does scrolling:
  // a menu anchored to a pointer that has moved on is a lie about its subject.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    const onPointer = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer, true);
    window.addEventListener("wheel", props.onClose, { passive: true, once: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("wheel", props.onClose);
    };
  }, [props]);

  return (
    <div
      className="context-menu"
      role="menu"
      ref={ref}
      style={{ left: placed.left, top: placed.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {props.actions.map((action) => (
        <button
          // The label is the identity: two actions with the same name in one menu
          // would be a bug in the caller, not a case to design around.
          key={action.label}
          type="button"
          role="menuitem"
          className={`context-item ${action.danger ? "danger" : ""} ${action.separatorBefore ? "separated" : ""}`}
          disabled={action.disabled}
          onClick={() => {
            if (action.disabled) return;
            props.onClose();
            action.onSelect();
          }}
        >
          <span className="context-label">{action.label}</span>
          {action.hint ? <span className="context-hint">{action.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
