/**
 * Slash commands.
 *
 * Deliberately five. A coding-agent command language is a project of its own,
 * and the useful thing here is the conversation — not a DSL. Parsing is a pure
 * function so the command surface is testable without a terminal.
 */

export type SlashCommand =
  | { name: "help" }
  | { name: "clear" }
  | { name: "model"; model?: string }
  | { name: "quit" }
  | { name: "unknown"; input: string };

export const COMMANDS = ["help", "clear", "model", "quit"] as const;

export const HELP_TEXT: [string, string][] = [
  ["/help", "show this list"],
  ["/clear", "start a new conversation"],
  ["/model", "list the models you have used"],
  ["/model <name>", "switch to a model by name"],
  ["/quit", "exit (Ctrl+D does the same)"],
];

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
  const name = head.toLowerCase();
  const argument = rest.join(" ").trim();

  switch (name) {
    case "help":
      return { name: "help" };
    case "clear":
      return { name: "clear" };
    case "quit":
    case "exit":
      return { name: "quit" };
    case "model":
      return argument ? { name: "model", model: argument } : { name: "model" };
    default:
      return { name: "unknown", input: trimmed };
  }
}
