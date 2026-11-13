/**
 * The command surface, mirrored from the CLI.
 *
 * Every command has a one-letter alias, because the thing you reach for twenty
 * times a session should not cost six keystrokes, and the popup shows the alias
 * beside the name so it is learned rather than hidden. Parsing is a pure
 * function, which is what makes the command set testable without a window.
 */

export type SlashCommandDef = {
  name: string;
  aliases: string[];
  description: string;
};

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "provider", aliases: ["p", "endpoint"], description: "switch, sign in, add or remove" },
  { name: "setup", aliases: ["s"], description: "re-run the setup wizard" },
  { name: "model", aliases: ["m"], description: "switch to a model" },
  { name: "mcp", aliases: ["mc"], description: "manage MCP servers" },
  { name: "thinking", aliases: ["t"], description: "reasoning effort" },
  { name: "clear", aliases: ["c"], description: "start a new conversation" },
  { name: "session", aliases: ["r", "resume"], description: "switch to a saved session" },
  { name: "usage", aliases: ["u"], description: "tokens and quota" },
  { name: "help", aliases: ["h", "?"], description: "the command list" },
  { name: "quit", aliases: ["q", "exit"], description: "exit" },
];

const ALIASES = new Map<string, string>();
for (const command of SLASH_COMMANDS) for (const alias of command.aliases) ALIASES.set(alias, command.name);

/** The canonical command name for a typed word, resolving aliases. */
export function resolveCommand(word: string): string {
  const lower = word.toLowerCase();
  return ALIASES.get(lower) ?? lower;
}

/** The command listing `/help` shows: the name, its first alias, and the one-liner. */
export const COMMAND_HELP: [string, string][] = SLASH_COMMANDS.map((command) => [
  `/${command.name}  /${command.aliases[0]}`,
  command.description,
]);

/** Commands whose name or alias starts with the typed query, in list order. */
export function matchSlashCommands(query: string): SlashCommandDef[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(q) || command.aliases.some((alias) => alias.startsWith(q)));
}

/** The commands whose name, alias or description contains the query. */
/** Commands whose name, alias or description contains the query. */
export function filterSlashCommands(query: string): SlashCommandDef[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter(
    (command) =>
      command.name.includes(q) || command.aliases.some((alias) => alias.includes(q)) || command.description.toLowerCase().includes(q),
  );
}

export type ParsedSlash = { name: string; argument?: string };

/**
 * Parse a line of input, or undefined when it is ordinary text.
 *
 * A lone `/` is a half-typed command, not an unknown one — returning undefined
 * for it is what lets the popup open without the app also thinking the user
 * asked for something.
 */
export function parseSlash(input: string): ParsedSlash | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed === "/") return undefined;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = resolveCommand(head ?? "");
  const argument = rest.join(" ").trim();
  return { name, ...(argument ? { argument } : {}) };
}
