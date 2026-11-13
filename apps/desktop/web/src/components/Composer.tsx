import { useEffect, useRef, useState } from "react";
import { filterSlashCommands, type SlashCommandDef } from "../slash";

/**
 * The composer, and the slash popup above it.
 *
 * A textarea rather than an input, because a coding agent's prompt is often
 * several lines — a pasted stack trace, a command, an error. Enter sends and
 * Shift+Enter adds a line, which is the convention this kind of app has taught
 * everyone; a bare textarea would make the common case the awkward one.
 *
 * While a turn is streaming the send button becomes a stop button, because that
 * is the only thing a user wants to do with a turn that is going wrong, and
 * hiding it behind a keyboard shortcut would not be an affordance.
 */

const SLASH_TRIGGER = /^\/[^\s]*$/;

export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  blocked: boolean;
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const showSlash = !dismissed && SLASH_TRIGGER.test(props.value);
  const query = showSlash ? props.value.slice(1) : "";
  const matches = showSlash ? filterSlashCommands(query) : [];

  useEffect(() => {
    setSlashIndex(0);
  }, [query]);

  useEffect(() => {
    // Any edit re-opens the popup: dismissing it and then typing again is a
    // request for it, not a reason to keep it hidden.
    if (!SLASH_TRIGGER.test(props.value)) setDismissed(false);
  }, [props.value]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    // Grow with the content up to a point, so a pasted block does not scroll
    // inside a one-line box.
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [props.value]);

  function choose(command: SlashCommandDef): void {
    props.onChange(`/${command.name} `);
    setDismissed(true);
    textareaRef.current?.focus();
  }

  return (
    <div className="composer-area">
      {matches.length > 0 ? (
        <div className="slash-popup" role="listbox" aria-label="Commands">
          {matches.map((command, index) => (
            <div
              key={command.name}
              role="option"
              aria-selected={index === slashIndex}
              className={`slash-item ${index === slashIndex ? "selected" : ""}`}
              onMouseEnter={() => setSlashIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(command);
              }}
            >
              <span className="slash-name">
                /{command.name} <span className="muted">/{command.aliases[0]}</span>
              </span>
              <span className="slash-desc">{command.description}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className={`composer ${props.busy ? "busy" : ""}`}>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={props.value}
          placeholder={props.placeholder ?? "Ask anything, or type / for commands…"}
          rows={1}
          spellCheck={false}
          aria-label="Message"
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (matches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((index) => Math.min(matches.length - 1, index + 1));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((index) => Math.max(0, index - 1));
                return;
              }
              if (event.key === "Tab" || (event.key === "Enter" && matches.length > 0)) {
                const command = matches[slashIndex];
                if (command && !(event.key === "Enter" && props.value.includes(" "))) {
                  event.preventDefault();
                  choose(command);
                  return;
                }
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="action-btn"
            onClick={() => (props.busy ? props.onCancel() : props.onSubmit())}
            disabled={!props.busy && !props.value.trim()}
            title={props.busy ? "Stop (Esc)" : "Send (Enter)"}
            aria-label={props.busy ? "Stop" : "Send"}
          >
            {props.busy ? "■" : "⏎"}
          </button>
        </div>
      </div>
      <div className="footer">
        {props.blocked ? "The agent stopped and needs a reply to continue." : "Actor0 is an experimental agent and may make mistakes."}
      </div>
    </div>
  );
}
