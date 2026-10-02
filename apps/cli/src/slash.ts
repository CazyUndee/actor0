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
  | { name: "quit" }
  | { name: "unknown"; input: string };

export const COMMANDS = ["help", "clear", "model", "provider", "quit"] as const;

export const HELP_TEXT: [string, string][] = [
  ["/help", "show this list"],
  ["/clear", "start a new conversation"],
  ["/model", "list the models you have used"],
  ["/model <name>", "switch to a model by name"],
  ["/provider", "show the endpoint, model and credential in use"],
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
      return argument ? { name: "model", model: argument } : { name: "model" };    // An argument is accepted and ignored rather than rejected: a user who
    // types `/provider openai` is asking where requests go, and telling them
    // the command takes no argument is less useful than showing it.
    case "provider": case "endpoint":
      return { name: "provider" };
    default:
      return { name: "unknown", input: trimmed };
  }
}
