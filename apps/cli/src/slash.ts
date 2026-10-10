/**
 * Slash commands.
 *
 * Deliberately five. A coding-agent command language is a project of its own,
 * and the useful thing here is the conversation — not a DSL. Parsing is a pure
 * function so the command surface is testable without a terminal.
 *
 * `/provider` is the one that exists because the endpoint is configurable: a
 * feature you cannot inspect is a feature you cannot debug, and the previous
 * single-endpoint design had exactly that property.
 */

export type SlashCommand =
  | { name: "help" }
  | { name: "clear" }
  | { name: "model"; model?: string }
  | { name: "provider" }
  | { name: "setup" }
  | { name: "usage" }
  | { name: "thinking"; effort?: string }
  | { name: "quit" }
  | { name: "unknown"; input: string };

/** A slash command: its name, the short aliases that reach it, and a one-liner. */
export type SlashCommandDef = {
  name: string;
  /** Short forms — single letters where possible — so a command is fast to type. */
  aliases: string[];
  description: string;
};

/**
 * The command surface, ordered by how often it is reached.
 *
 * Every command has a one-letter alias, because the thing you reach for twenty
 * times a session should not cost six keystrokes. The popup and `/help` show
 * the alias beside the name, so it is learned rather than hidden.
 */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "provider", aliases: ["p", "endpoint"], description: "manage providers — switch, sign in, add, remove" },
  { name: "setup", aliases: ["s"], description: "re-run the setup wizard" },
  { name: "model", aliases: ["m"], description: "switch to a model by name" },
  { name: "thinking", aliases: ["t"], description: "reasoning effort — low, medium, high" },
  { name: "clear", aliases: ["c"], description: "start a new conversation" },
  { name: "usage", aliases: ["u"], description: "token usage and quota — today, this week, this month" },
  { name: "help", aliases: ["h", "?"], description: "show all commands" },
  { name: "quit", aliases: ["q", "exit"], description: "exit" },
];

export const COMMANDS = SLASH_COMMANDS.map((command) => command.name);

/** Alias → canonical name, so `/p`, `/q`, `/exit` all resolve. */
const ALIASES = new Map<string, string>();
for (const command of SLASH_COMMANDS) for (const alias of command.aliases) ALIASES.set(alias, command.name);

/** The canonical command name for a typed word, resolving aliases; unknown words pass through. */
export function resolveCommand(word: string): string {
  const lower = word.toLowerCase();
  return ALIASES.get(lower) ?? lower;
}

export const HELP_TEXT: [string, string][] = SLASH_COMMANDS.map((command) => [
  `/${command.name}  /${command.aliases[0]}`,
  command.description,
]);

/** Commands whose name or alias starts with the typed query, in list order. */
export function matchSlashCommands(query: string): SlashCommandDef[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter(
    (command) => command.name.startsWith(q) || command.aliases.some((alias) => alias.startsWith(q)),
  );
}

/**
 * Parse a line of input. Returns undefined when the input is ordinary text, so
 * the caller can send it to the model without branching on a sentinel.
 */
export function parseSlash(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  // A lone "/" is a half-typed command, not an unknown one.
  if (trimmed === "/") return undefined;

  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = resolveCommand(head);
  const argument = rest.join(" ").trim();

  switch (name) {
    case "help":
      return { name: "help" };
    case "clear":
      return { name: "clear" };
    case "quit":
      return { name: "quit" };
    case "model":
      return argument ? { name: "model", model: argument } : { name: "model" };    // An argument is accepted and ignored rather than rejected: a user who
    // types `/provider openai` is asking where requests go, and telling them
    // the command takes no argument is less useful than showing it.
    case "provider":
      return { name: "provider" };
    case "setup":
      return { name: "setup" };
    case "usage":
      return { name: "usage" };
    case "thinking":
      return argument ? { name: "thinking", effort: argument.toLowerCase() } : { name: "thinking" };
    default:
      return { name: "unknown", input: trimmed };
  }
}
