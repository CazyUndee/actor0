import { Box, Text } from "ink";
import { color } from "../theme.js";
import type { SlashCommandDef } from "../slash.js";

/**
 * The `/` command popup.
 *
 * As the composer's draft starts with `/`, this lists the commands whose name
 * or alias matches what has been typed — command, its short alias, and a
 * one-line description, in aligned columns so the list scans at a glance. Pure
 * and presentational: the App owns the filter and the highlighted index and
 * completes a command on Tab. Modeled on the Codex CLI's command popup.
 */
export type SlashPopupProps = {
  commands: SlashCommandDef[];
  /** Index of the highlighted command. */
  selected: number;
};

export function SlashPopup({ commands, selected }: SlashPopupProps) {
  if (commands.length === 0) return null;
  // Align the command column to the widest name, so the alias and description
  // line up down the list instead of drifting with each name's length.
  const nameWidth = Math.max(...commands.map((command) => command.name.length));
  return (
    <Box flexDirection="column" marginBottom={1}>
      {commands.map((command, index) => {
        const active = index === selected;
        const tone = active ? color.accent : color.text;
        const alias = command.aliases[0] ?? "";
        return (
          // Sibling `<Text>`s in a row `Box`, not nested `<Text>` — nested ones
          // collide on an empty React key.
          <Box flexDirection="row" key={command.name}>
            <Text color={color.dim}>{`${index + 1} `}</Text>
            <Text color={tone}>{`${active ? "❯" : " "} /${command.name}`.padEnd(nameWidth + 4)}</Text>
            <Text color={color.dim}>{`/${alias}`.padEnd(5)}</Text>
            <Text color={tone}>{command.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
