import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { color } from "../theme.js";

/**
 * The `/model` picker: an interactive list of remembered models, the active one
 * marked, ↑/↓ to move and Enter to switch. `/model <name>` still sets one
 * directly; `/model` alone opens this. Modeled on the selection lists in the
 * Codex / Claude UIs rather than dumping the list as a text notice.
 */
export type ModelPickerProps = {
  models: string[];
  /** The model currently in use, marked in the list. */
  active: string;
  onSelect: (model: string) => void;
  onCancel: () => void;
};

export function ModelPicker({ models, active, onSelect, onCancel }: ModelPickerProps) {
  const [cursor, setCursor] = useState(() => Math.max(0, models.indexOf(active)));

  useInput((input, key) => {
    if (key.upArrow || input === "k") return setCursor((c) => wrap(c, models.length, -1));
    if (key.downArrow || input === "j") return setCursor((c) => wrap(c, models.length, 1));
    if (key.return) {
      const model = models[cursor];
      if (model) onSelect(model);
      return;
    }
    if (key.escape) return onCancel();
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color.muted} bold>model</Text>
      <Box flexDirection="column" marginLeft={2}>
        {models.map((model, index) => {
          const selected = index === cursor;
          const inUse = model === active;
          return (
            <Text key={model} color={selected ? color.accent : color.text}>
              {selected ? "❯ " : "  "}
              {inUse ? "● " : "○ "}
              {model}
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
