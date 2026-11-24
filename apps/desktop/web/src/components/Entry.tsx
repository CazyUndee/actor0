/* eslint-disable react/no-array-index-key -- A tool result is a string; its diff lines have no identity beyond their position, and the list is append-only. */
import { useEffect, useRef, useState } from "react";
import type { Entry } from "../conversation";

import { Markdown } from "./Markdown";
import { COMMAND_HELP } from "../slash";
import { CopyButton } from "./CopyButton";
import { Caret } from "./Caret";

/**
 * The transcript's entries, one component per kind.
 *
 * These mirror the CLI's surfaces: a user bubble, an assistant answer with real
 * markdown, a collapsible reasoning block with its duration, a tool line with a
 * status glyph and its output, a plan, and the help listing. "Component parity
 * over pixel identity" is the rule — each CLI surface has an explicit
 * counterpart here, driven by the same state.
 */

function formatDuration(seconds?: number): string {
  if (seconds === undefined) return "";
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** A tool's output as a few dimmed lines, capped the way the CLI caps it. */
function outputLines(status: "ok" | "error", output: string): string[] {
  const text = output.replace(/\r/g, "").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const max = status === "error" ? 8 : 6;
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… ${lines.length - max} more line${lines.length - max === 1 ? "" : "s"}`];
}

export function ToolEntry({ entry }: { entry: Extract<Entry, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const text = typeof entry.output?.text === "string" ? entry.output.text : String(entry.output?.data ?? "");
  // `edit` reports a diff, and a diff is the one tool result worth colouring:
  // it is the only one whose shape a reader scans rather than reads.
  const isDiff = entry.name === "edit" && /^[+-]/m.test(text);
  const lines = outputLines(entry.status, text);

  return (
    <div className={`tool-entry ${entry.status}`}>
      <button type="button" className="tool-header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`tool-glyph ${entry.status === "ok" ? "ok" : "err"}`}>{entry.status === "ok" ? "✓" : "✗"}</span>
        <span className="tool-name">{entry.name}</span>
        {entry.target ? <span className="tool-target">{entry.target}</span> : null}
        <span className="tool-toggle">{open ? "−" : "+"}</span>
      </button>
      {open && text ? (
        <pre className="tool-output">
          {isDiff
            ? text.split("\n").map((line, index) => (
                <div className={`diff-line ${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}`} key={index}>
                  {line}
                </div>
              ))
            : lines.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

export function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="entry user">
          <div className="user-bubble">{entry.text}</div>
        </div>
      );
    case "assistant": {
      if (!entry.text.trim() && !entry.partial) return null;
      return (
        <div className={`entry assistant ${entry.partial ? "has-partial" : ""}`}>
          <div className={`assistant-box ${entry.partial ? "partial" : ""}`}>
            <Markdown text={entry.text} />
            {entry.partial ? <div className="partial-note">incomplete</div> : null}
          </div>
          {/* A click is the mouse-first equivalent of the CLI's Ctrl+C. The raw
              markdown is what is copied, not the rendered DOM, because the
              answer is the thing the user wants in a paste elsewhere. */}
          <CopyButton text={entry.text} title="Copy the answer" className="entry-copy" />
        </div>
      );
    }
    case "reasoning":
      // History opens collapsed (you were not watching it arrive); anything
      // without a stored index was built during this session.
      return (
        <div className="entry reasoning">
          <ReasoningEntry
            text={entry.text}
            durationSeconds={entry.durationSeconds}
            initialOpen={entry.messageIndex === undefined}
          />
        </div>
      );
    case "tool":
      return (
        <div className="entry tool">
          <ToolEntry entry={entry} />
        </div>
      );
    case "plan":
      return (
        <div className="entry plan">
          <div className="plan-box">
            <div className="plan-title">{entry.title}</div>
            <pre className="plan-body">{entry.plan}</pre>
          </div>
          <CopyButton text={`${entry.title}\n\n${entry.plan}`} title="Copy the plan" className="entry-copy" />
        </div>
      );
    case "help":
      return (
        <div className="entry help">
          {/* The command list as a bordered reference the user can go back to,
              not transcript chatter — the same decision the CLI's help box
              makes. The `/name  /alias` columns are what teach the aliases. */}
          <div className="help-box">
            <div className="help-title">commands</div>
            {COMMAND_HELP.map(([command, description]) => (
              <div className="help-row" key={command}>
                <span className="help-command">{command}</span>
                <span className="help-description">{description}</span>
              </div>
            ))}
            <div className="help-note">Enter sends · Shift+Enter adds a line · Esc cancels a turn</div>
          </div>
        </div>
      );
    default:
      return null;
  }
}

/**
 * The thinking block.
 *
 * Collapsed it is one line in a rounded box; opened it is a *window* onto the
 * reasoning, not a tail that follows the newest line — it scrolls, and opening
 * always starts at the top. That distinction is the whole reason it has a fixed
 * height instead of a max-height that grows: eight lines of context you can
 * read is not the same object as the last eight lines the model wrote.
 *
 * A block that is streaming says "thinking…" with the same shimmer as the
 * status line and counts up; once it stops it says "thought for 3.4s". Nothing
 * separates the header from the body but the surface itself: two bordered
 * halves attached to each other read as two blocks, which is not what this is.
 */
export function ReasoningEntry(props: {
  text: string;
  durationSeconds?: number;
  /** Still arriving: the header counts up instead of reporting a duration. */
  live?: boolean;
  /** Persisted history opens collapsed; a block that just streamed opens. */
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.initialOpen ?? Boolean(props.live));
  /**
   * A manual close is a decision, not a state. The auto-collapse below may put
   * a block away, but it may never overrule someone who deliberately closed it.
   */
  const closedByUser = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!props.live) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [props.live]);

  // Collapse only once the block has been off screen for three seconds: a
  // block scrolling past on its way out is still being read.
  useEffect(() => {
    if (props.live || typeof IntersectionObserver === "undefined") return;
    const node = rootRef.current;
    if (!node) return;
    let timer = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        window.clearTimeout(timer);
        const visible = entries.some((entry) => entry.isIntersecting);
        if (!visible && !closedByUser.current) timer = window.setTimeout(() => setOpen(false), 3_000);
      },
      { threshold: 0 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [props.live]);

  // Opening starts at the top of the reasoning. It is a window onto it, not a
  // log that follows the end.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open]);

  const toggle = (): void => {
    if (open) closedByUser.current = true;
    setOpen(!open);
  };

  return (
    <div className={`reasoning-box ${open ? "open" : ""} ${props.live ? "live" : ""}`} ref={rootRef}>
      <button type="button" className="reasoning-header" onClick={toggle} aria-expanded={open}>
        <span className="reasoning-mark"><Caret open={open} /></span>
        {props.live ? (
          <span className="reasoning-label shimmer">thinking…</span>
        ) : (
          <span className="reasoning-label">
            {props.durationSeconds !== undefined ? `thought for ${formatDuration(props.durationSeconds)}` : "thought"}
          </span>
        )}
        {props.live && elapsed >= 0.1 ? <span className="reasoning-time">{elapsed.toFixed(1)}s</span> : null}
      </button>
      {open ? (
        <pre className="reasoning-body" ref={bodyRef}>
          {props.text}
        </pre>
      ) : null}
    </div>
  );
}
