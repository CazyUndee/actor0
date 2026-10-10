import { Box, Text } from "ink";
import { color } from "../theme.js";

/**
 * The `/` command popup.
 *
 * As the composer's draft starts with `/`, this lists the commands whose name
 * matches what has been typed, with a one-line description each — the
 * discoverability a bare prompt cannot offer. It is a pure presentational
 * component: the App owns the filter and the highlighted index, and completes a
 * command on Tab. Modeled on the Codex CLI's command popup.
 */
export type SlashPopupProps = {
  commands: { name: string; description: string }[];
  /** Index of the highlighted command. */
  selected: number;
};

export function SlashPopup({ commands, selected }: SlashPopupProps) {
  if (commands.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {commands.map((command, index) => {
        const active = index === selected;
        return (
          <Text key={command.name} color={active ? color.accent : color.text}>
            {active ? "❯ " : "  "}
            <Text color={active ? color.accent : color.text}>{`/${command.name}`}</Text>
            <Text color={color.dim}>{`  ${command.description}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
