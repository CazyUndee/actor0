import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { color } from "../theme.js";

/**
 * The `/thinking` picker: reasoning effort — low, medium, high — plus an "off"
 * entry that clears it. Applies to the active provider for models that support
 * it (o-series, Claude extended thinking). Up/down to move, Enter to set.
 */
export type ThinkingPickerProps = {
  active: "low" | "medium" | "high" | undefined;
  onSelect: (effort: "low" | "medium" | "high" | undefined) => void;
  onCancel: () => void;
};

const OPTIONS: { effort: "low" | "medium" | "high" | undefined; label: string; hint: string }[] = [
  { effort: "low", label: "low", hint: "fastest, least reasoning" },
  { effort: "medium", label: "medium", hint: "balanced" },
  { effort: "high", label: "high", hint: "most reasoning, slowest" },
  { effort: undefined, label: "off", hint: "let the model decide" },
];

export function ThinkingPicker({ active, onSelect, onCancel }: ThinkingPickerProps) {
  const [cursor, setCursor] = useState(() => Math.max(0, OPTIONS.findIndex((o) => o.effort === active)));

  useInput((input, key) => {
    if (key.upArrow || input === "k") return setCursor((c) => wrap(c, OPTIONS.length, -1));
    if (key.downArrow || input === "j") return setCursor((c) => wrap(c, OPTIONS.length, 1));
    if (key.return) {
      const option = OPTIONS[cursor];
      if (option) onSelect(option.effort);
      return;
    }
    if (key.escape) return onCancel();
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color.muted} bold>reasoning effort</Text>
      <Box flexDirection="column" marginLeft={2}>
        {OPTIONS.map((option, index) => {
          const selected = index === cursor;
          const inUse = option.effort === active;
          return (
            <Text key={option.label} color={selected ? color.accent : color.text}>
              {selected ? "❯ " : "  "}
              {inUse ? "● " : "○ "}
              {option.label}
              <Text color={color.dim}>{`  ${option.hint}`}</Text>
              {inUse ? <Text color={color.dim}>{"  (in use)"}</Text> : null}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={color.dim}>{"↑/↓ move · enter select · esc cancel"}</Text>
      </Box>
    </Box>
  );
}

function wrap(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}
