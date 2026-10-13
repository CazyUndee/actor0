import { C_TOOLS, CANDIDATE_C2, type JsonSchema, type RawCandidate, type RawTool } from "./candidates.js";

/**
 * The optimization search space for the grouped-tool interface.
 *
 * The C -> C2 experiment moved exactly one thing — how much each grouped tool's
 * description says — and the result was a trade (first-call validity up, churn
 * up) that is still within single-run noise. This builds grouped candidates
 * programmatically over two knobs so the loop can search for the point that
 * keeps C's cheapness and 9/9 completion while fixing first-call validity, if
 * one exists:
 *
 *  - desc: how explicitly the description states each op's required args.
 *      none     = C verbatim (op enum only; model omits required fields)
 *      required = terse, required-args-only ("grep→pattern, index→query")
 *      full     = C2 verbatim (required + optional args, prose)
 *  - pool: the advertised field set.
 *      full    = C's permissive pool (all fields, all optional)
 *      trimmed = drop the rarely-used fields (offset, literal, depth, all)
 *
 * desc=none+pool=full reproduces C; desc=full+pool=full reproduces C2. The
 * dispatcher path is C's for all of them (enforced op-specific required fields,
 * permissive extras), so only the two knobs differ.
 */

export type DescStyle = "none" | "required" | "full";
export type PoolMode = "full" | "trimmed";
export type VariantConfig = { desc: DescStyle; pool: PoolMode };

export const variantId = (c: VariantConfig): string => `g-${c.desc}-${c.pool}`;

const REQUIRED_DESC: Record<string, string> = {
  inspect:
    "Read-only local inspection. Pick op and give its required argument: read→path; grep→pattern; glob→pattern; tree→(path optional); index→query; skill→name.",
  modify:
    "Change one file. Pick op and give its required arguments: write→path+content; edit→path+old+new; delete→path.",
  web: "Search the web or fetch a URL. op=search→query; op=fetch→url.",
};

const FULL_DESC: Record<string, string> = Object.fromEntries(
  CANDIDATE_C2.tools.map((t: RawTool) => [t.name, t.description]),
);

/** Fields dropped when pool=trimmed — present but rarely the point of a call. */
const DROP_FIELDS = ["offset", "literal", "depth", "all"] as const;

export function buildGroupedCandidate(config: VariantConfig): RawCandidate {
  const tools: RawTool[] = C_TOOLS.map((tool) => {
    const description =
      config.desc === "required"
        ? REQUIRED_DESC[tool.name] ?? tool.description
        : config.desc === "full"
          ? FULL_DESC[tool.name] ?? tool.description
          : tool.description;
    let input_schema = tool.input_schema;
    if (config.pool === "trimmed" && input_schema.properties) {
      const properties: JsonSchema = { ...(input_schema.properties as JsonSchema) };
      for (const field of DROP_FIELDS) delete properties[field];
      input_schema = { ...input_schema, properties };
    }
    return { ...tool, description, input_schema };
  });
  return { id: variantId(config), label: `grouped desc=${config.desc} pool=${config.pool}`, tools };
}

/** The default search plan: the two known points plus three new probes. */
export const DEFAULT_PLAN: VariantConfig[] = [
  { desc: "none", pool: "full" },     // == C (baseline)
  { desc: "full", pool: "full" },     // == C2 (verbose)
  { desc: "required", pool: "full" }, // terse-args, full pool
  { desc: "required", pool: "trimmed" }, // terse-args, lean pool
  { desc: "full", pool: "trimmed" },  // verbose, lean pool
];

// --- The eager/deferred boundary: how much of the catalog to carry up front ---

/**
 * How many tools to carry eagerly. Codex's deferred-discovery insight is that
 * the saving comes from *not* carrying the catalog, so where the boundary sits
 * is the second axis worth searching: too few eager tools and every task pays a
 * find_tool round trip; too many and the token cost creeps back toward a flat
 * interface. These presets span that boundary against a fixed, terse catalog.
 */
export const EAGER_PRESETS: { id: string; eager: string[] }[] = [
  { id: "read-write", eager: ["read", "write"] },
  { id: "read-grep-edit-write", eager: ["read", "grep", "edit", "write"] },
  { id: "plus-shell-glob", eager: ["read", "grep", "edit", "write", "shell", "glob"] },
];
