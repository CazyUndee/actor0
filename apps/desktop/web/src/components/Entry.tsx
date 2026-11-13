/* eslint-disable react/no-array-index-key -- A tool result is a string; its diff lines have no identity beyond their position, and the list is append-only. */
import { useState } from "react";
import type { Entry } from "../conversation";

import { Markdown } from "./Markdown";
import { COMMAND_HELP } from "../slash";
import { CopyButton } from "./CopyButton";

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
    case "assistant":
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
    case "reasoning":
      return <ReasoningEntry entry={entry} />;
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

function ReasoningEntry({ entry }: { entry: Extract<Entry, { kind: "reasoning" }> }) {
  const [open, setOpen] = useState(false);
  const firstLine = entry.text.split("\n")[0] ?? "";
  return (
    <div className="entry reasoning">
      <button type="button" className="reasoning-header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="reasoning-mark">{open ? "▾" : "▸"}</span>
        <span className="reasoning-label">thought</span>
        {entry.durationSeconds !== undefined ? <span className="reasoning-time">{formatDuration(entry.durationSeconds)}</span> : null}
        <span className="reasoning-preview">{firstLine}</span>
      </button>
      {open ? <pre className="reasoning-body">{entry.text}</pre> : null}
    </div>
  );
}
