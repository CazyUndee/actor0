import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { color } from "../theme.js";

/**
 * Interactive prompts.
 *
 * A terminal cannot use a DOM input, so `TextInput` is a thin accumulator over
 * Ink's `useInput`. Every prompt shares it, which is what keeps the caret, the
 * placeholder and the escape hatch behaving identically across the app.
 */

type TextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isActive?: boolean;
  placeholder?: string;
};

export function TextInput({ value, onChange, onSubmit, isActive = true, placeholder }: TextInputProps) {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (!input) return;

      // A pasted chunk arrives as a single `input` string with no key events,
      // so a pasted newline would otherwise be inserted as a literal control
      // character. Take the first line and submit it, which is what pasting a
      // finished sentence into a prompt should do.
      const newline = input.search(/[\r\n]/);
      if (newline !== -1) {
        onChange(value + input.slice(0, newline));
        onSubmit(value + input.slice(0, newline));
        return;
      }
      onChange(value + input);
    },
    { isActive },
  );

  const empty = value.length === 0;

  return (
    <Text>
      {/*
        The caret goes *before* the placeholder, not after it. With the caret
        last, `❯ ask something, or /help▏` reads as a filled input whose cursor
        happens to sit at the end of the placeholder — so the first keystroke
        looked like it was overwriting something. In front, it reads as "type
        here", which is what it is.
      */}
      {isActive && empty ? <Text color={color.accent}>▏ </Text> : null}
      {empty && placeholder ? (
        <Text color={color.dim}>{placeholder}</Text>
      ) : (
        <Text color={color.text}>{value}</Text>
      )}
      {isActive && !empty ? <Text color={color.accent}>▏</Text> : null}
    </Text>
  );
}

/** The main input line, with up/down history. */
export function Composer({
  value,
  onChange,
  onSubmit,
  history,
  isActive,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  history: string[];
  isActive: boolean;
  busy: boolean;
}) {
  const [cursor, setCursor] = useState<number | null>(null);
  // `null` means "editing a fresh line"; a number indexes back through history.
  const position = cursor === null ? history.length : cursor;

  useInput(
    (_input, key) => {
      if (!key.upArrow && !key.downArrow) return;
      if (history.length === 0) return;
      if (key.upArrow) {
        const next = position <= 0 ? 0 : position - 1;
        setCursor(next);
        onChange(history[next] ?? "");
        return;
      }
      const next = position + 1;
      if (next >= history.length) {
        setCursor(null);
        onChange("");
        return;
      }
      setCursor(next);
      onChange(history[next] ?? "");
    },
    { isActive: isActive && busy === false },
  );

  return (
    <Box>
      <Text color={busy ? color.dim : color.accent} bold>
        {busy ? "·" : "❯"}{" "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        isActive={isActive && !busy}
        placeholder={busy ? "working — Esc to cancel" : "ask something, or /help"}
      />
    </Box>
  );
}
