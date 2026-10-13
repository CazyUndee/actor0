import type { JsonSchema, RawTool } from "./candidates.js";

/**
 * A searchable tool catalog — the Codex "deferred tool discovery" pattern.
 *
 * Codex does not put every tool in context. It exposes a small eager set plus a
 * `tool_search` tool that searches deferred tool metadata and "exposes matching
 * tools for the next model call". Its search text is built exactly as
 * `default_tool_search_text` builds it in `codex-rs/tools/src/tool_search.rs`:
 * the name, the name with underscores turned into spaces, the description, and
 * — recursively — every schema field name and its description. So a query like
 * "change file contents" reaches `edit` through its `old`/`new` fields, not just
 * its name.
 *
 * Provider adaptation (documented, not hidden): Codex leans on the Responses
 * API's `defer_loading`, which marks a matched tool loadable-for-next-call. Our
 * OpenAI-compatible gateway has no such feature, so `find_tool` here instead
 * *returns the matching tool's full definition as text* — name, JSON schema,
 * description — for the model to then call as a normal tool on its next turn.
 * Same discovery economy; one extra round trip, which is a real cost this
 * candidate is being measured on.
 */

export type EagerTool = RawTool & {
  /** True when this tool is advertised up front rather than only via find_tool. */
  eager: boolean;
};

/** Recursively collect searchable text from a JSON schema, like Codex does. */
function schemaText(schema: JsonSchema, out: string[]): void {
  const push = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out.push(trimmed);
    }
  };
  push(schema.description);
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (properties) {
    for (const [name, child] of Object.entries(properties)) {
      out.push(name);
      schemaText(child, out);
    }
  }
  if (schema.items) schemaText(schema.items as JsonSchema, out);
  const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (variants) for (const variant of variants) schemaText(variant, out);
}

/** The searchable text for one tool: name, spaced name, description, schema. */
export function toolSearchText(tool: RawTool): string {
  const parts: string[] = [tool.name, tool.name.replace(/_/g, " "), tool.description];
  schemaText(tool.input_schema, parts);
  return parts.join(" ").toLowerCase();
}

export function searchCatalog(catalog: RawTool[], query: string, limit = 5): RawTool[] {
  // Stopwords carry no signal here and actively mislead: "a" appears in most
  // descriptions, so it ties unrelated tools. Rank on content words only.
  const STOP = new Set(["a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "by", "it", "is", "my", "me", "some", "any"]);
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
  if (terms.length === 0) return catalog.slice(0, limit);
  const scored = catalog.map((tool) => {
    const text = toolSearchText(tool);
    const name = tool.name.toLowerCase().replace(/_/g, " ");
    const desc = tool.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      // Name matches dominate: a query naming a tool should return it, not a
      // tool whose field descriptions happen to share a word.
      if (name === term) score += 10;
      else if (name.includes(term)) score += 6;
      // Then the description — the human summary of what the tool is for.
      if (desc.includes(term)) score += 3;
      // Then the deep schema/field text (Codex's recursive crawl), weakest.
      else if (text.includes(term)) score += 1;
    }
    return { tool, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((entry) => entry.tool);
}

/** Render a tool definition as the text `find_tool` hands back to the model. */
export function renderToolDefinition(tool: RawTool): string {
  return [
    `tool: ${tool.name}`,
    `description: ${tool.description}`,
    `arguments (JSON): ${JSON.stringify(tool.input_schema)}`,
    "Call it next with this exact schema.",
  ].join("\n");
}
