import { useEffect, useMemo, useState } from "react";
import type { SessionSummary } from "../protocol";
import { Caret } from "./Caret";

/**
 * The conversation picker in the top bar.
 *
 * "session: <title>" next to the provider selector, as a dropdown:
 *
 *   - conversations are grouped by the directory they happened in, the group
 *     named by the last path segment (d:/projects/actor0 -> "actor0");
 *   - the conversation currently streaming shimmers, the current one carries a
 *     tick, and ones the agent stopped on while the app was open carry a dot;
 *   - "new" opens a form that takes a path (or opens the file manager);
 *   - "delete" turns the list into a checkbox picker for removing conversations.
 *
 * All of the state it shows (busy, stopped, current) is handed in — the
 * dropdown renders, it does not own, conversation state.
 */

/** The group label for a session's cwd: the last path segment, or "unsaved" when a session predates cwd capture. */
function groupOf(cwd?: string): string {
  if (!cwd) return "elsewhere";
  // Normalize separators, drop a trailing one, take the final segment.
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

export function SessionDropdown(props: {
  title?: string;
  sessions: SessionSummary[];
  currentId: string | null;
  /** The session currently streaming a turn — it shimmers. */
  busy: boolean;
  /** Sessions the agent stopped on while the app was open — a dot. */
  stopped: ReadonlySet<string>;
  onLoad: (id: string) => void;
  onNew: (cwd?: string) => void;
  onDelete: (ids: string[]) => void;
  /** Opens the system folder picker; resolves the picked directory or undefined. */
  onPickFolder: () => Promise<string | undefined>;
  /**
   * Controlled open state, for a caller that has to close this menu when
   * another one opens. Omitted, the dropdown owns the state itself.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Test affordance: start open when uncontrolled (state does not survive SSR). */
  initiallyOpen?: boolean;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.initiallyOpen ?? false);
  const open = props.open ?? uncontrolledOpen;
  // One setter for both modes: an uncontrolled dropdown keeps the value, a
  // controlled one is told instead. Nothing else may write `uncontrolledOpen`,
  // or the two modes drift and a menu stops closing.
  const setOpen = (next: boolean | ((value: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    if (props.open === undefined) setUncontrolledOpen(value);
    props.onOpenChange?.(value);
  };
  const [mode, setMode] = useState<"list" | "new" | "delete">("list");
  const [newPath, setNewPath] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Reset the sub-mode whenever the dropdown closes, so reopening starts at
  // the list rather than wherever the user left it.
  useEffect(() => {
    if (!open) {
      setMode("list");
      setChecked(new Set());
    }
  }, [open]);

  const grouped = useMemo(() => {
    const groups = new Map<string, SessionSummary[]>();
    for (const session of props.sessions) {
      const key = groupOf(session.cwd);
      const bucket = groups.get(key) ?? [];
      bucket.push(session);
      groups.set(key, bucket);
    }
    // Most-recently-touched group first, sessions sorted by updatedAt inside.
    return [...groups.entries()]
      .map(([name, list]) => ({
        name,
        sessions: [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .sort((a, b) => (b.sessions[0]?.updatedAt ?? "").localeCompare(a.sessions[0]?.updatedAt ?? ""));
  }, [props.sessions]);

  const label = props.title ?? "new conversation";
  const untitled = (session: SessionSummary): string =>
    session.title ?? session.updatedAt.replace(/^(\d{4})-(\d{2})-(\d{2}).*?(\d{2})-(\d{2}).*/, "$1-$2-$2 $4:$5");

  return (
    <div className="session-dd">
      <button
        type="button"
        className={`dropdown-trigger session-trigger ${props.busy ? "streaming" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="Conversations"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="dropdown-value">session: {label}</span>
        <span className="dropdown-caret"><Caret open={open} /></span>
      </button>

      {open ? (
        <div className="session-menu" role="menu">
          {mode === "list" ? (
            <>
              <div className="session-menu-actions">
                <button type="button" className="session-action" onClick={() => setMode("new")}>
                  + new conversation
                </button>
                <button
                  type="button"
                  className="session-action danger"
                  onClick={() => setMode("delete")}
                  disabled={props.sessions.length === 0}
                >
                  delete conversations…
                </button>
              </div>
              {grouped.length === 0 ? <div className="session-empty">no saved conversations</div> : null}
              {grouped.map((group) => (
                <div key={group.name} className="session-group">
                  <div className="session-group-name">{group.name}</div>
                  {group.sessions.map((session) => {
                    const isCurrent = session.id === props.currentId;
                    const isBusy = isCurrent && props.busy;
                    const isStopped = props.stopped.has(session.id);
                    return (
                      <button
                        type="button"
                        key={session.id}
                        className={`session-item ${isBusy ? "active-turn" : ""}`}
                        role="menuitem"
                        onClick={() => {
                          if (!isCurrent) props.onLoad(session.id);
                          setOpen(false);
                        }}
                      >
                        <span className="session-item-status">
                          {isCurrent ? <span className="tick" title="current">✓</span> : <span className="tick-spacer" />}
                        </span>
                        <span className={`session-item-title ${isStopped ? "stopped" : ""}`}>{untitled(session)}</span>
                        {isStopped ? <span className="stopped-dot" title="stopped — waiting for a reply" /> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </>
          ) : null}

          {mode === "new" ? (
            <div className="session-new">
              <div className="session-new-hint">Start a conversation in a directory:</div>
              <div className="session-new-row">
                <input
                  className="session-new-input form-input"
                  value={newPath}
                  placeholder="d:/projects/actor0"
                  spellCheck={false}
                  onChange={(event) => setNewPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      props.onNew(newPath.trim() || undefined);
                      setOpen(false);
                    }
                    if (event.key === "Escape") {
                      // Consumed here: stepping back to the list must not also
                      // reach the app's Escape handler, which closes the whole
                      // menu and would take the typed path with it.
                      event.preventDefault();
                      event.stopPropagation();
                      setMode("list");
                    }
                  }}
                />
                <button
                  type="button"
                  className="session-action"
                  onClick={async () => {
                    const picked = await props.onPickFolder();
                    if (picked) setNewPath(picked);
                  }}
                >
                  browse…
                </button>
              </div>
              <div className="session-new-row">
                <button
                  type="button"
                  className="session-action primary"
                  onClick={() => {
                    props.onNew(newPath.trim() || undefined);
                    setOpen(false);
                  }}
                >
                  start
                </button>
                <button type="button" className="session-action" onClick={() => setMode("list")}>
                  cancel
                </button>
              </div>
            </div>
          ) : null}

          {mode === "delete" ? (
            <div className="session-delete">
              <div className="session-menu-actions">
                <button
                  type="button"
                  className="session-action danger"
                  disabled={checked.size === 0}
                  onClick={() => {
                    props.onDelete([...checked]);
                    setChecked(new Set());
                    setMode("list");
                  }}
                >
                  delete {checked.size > 0 ? `${checked.size}` : ""}
                </button>
                <button type="button" className="session-action" onClick={() => setMode("list")}>
                  cancel
                </button>
              </div>
              {grouped.flatMap((group) =>
                group.sessions.map((session) => {
                  const isCurrent = session.id === props.currentId;
                  const isChecked = checked.has(session.id);
                  return (
                    <button
                      type="button"
                      key={session.id}
                      className={`session-item checkable ${isChecked ? "checked" : ""}`}
                      disabled={isCurrent}
                      title={isCurrent ? "you cannot delete the conversation you are in" : undefined}
                      onClick={() => {
                        setChecked((prev) => {
                          const next = new Set(prev);
                          if (next.has(session.id)) next.delete(session.id);
                          else next.add(session.id);
                          return next;
                        });
                      }}
                    >
                      <span className="session-check">{isCurrent ? "—" : isChecked ? "✓" : ""}</span>
                      <span className="session-item-title">{untitled(session)}</span>
                    </button>
                  );
                }),
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
