import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills — progressive disclosure of reusable instructions.
 *
 * A skill is a named playbook the model can load on demand. The system prompt
 * always carries each skill's name and one-line description (cheap, so a
 * project can have many skills without bloating the prompt); the full body is
 * only read when the model calls the `skill` tool. That split — always-on
 * listing, on-demand body — is the whole feature, and it is what lets a skill
 * be long without costing context on every turn.
 *
 * See `docs/skills.md` for the design and the reference implementations
 * (Claude Code's Skill tool, codex's mention/implicit triggers).
 */

/** Where project-local skills live, relative to the working directory. */
export const SKILLS_DIR = [".actor0", "skills"] as const;

/** A skill, parsed from one `.actor0/skills/<name>.md` file. */
export type Skill = {
  name: string;
  /** One line, for the prompt listing. */
  description: string;
  /** Extra "when to reach for this", for the listing. */
  whenToUse?: string;
  /** The instructions, loaded only on demand. */
  body: string;
  /** Absolute path, for an error that names the file. */
  path: string;
  /** When true, the model may not invoke it — user-invocable only. */
  disableModelInvocation: boolean;
};

/** What discovery found, plus anything it had to skip and why. */
export type LoadResult = {
  skills: Skill[];
  /** Files that were skipped (malformed, missing name/description), with the reason. */
  notes: string[];
};

/** Per-description cap in the listing. The body is loaded on demand, so a long description is waste. */
const MAX_DESC_CHARS = 200;
/** Whole-listing cap. The prompt does not know the context window here, so this is a fixed budget. */
const LISTING_BUDGET_CHARS = 4_000;
/** A single skill body is capped, so one pathological skill cannot blow the window. */
const MAX_SKILL_BODY_CHARS = 32_000;

/**
 * Parse `---`-fenced `key: value` frontmatter and the body after it.
 *
 * Minimal on purpose: the fields are simple strings (`name`, `description`,
 * `when_to_use`, `disable-model-invocation`), and pulling in a YAML parser for
 * four scalar keys is not worth the dependency. A file with no leading `---`
 * is all body and no fields. CRLF is normalised so a Windows-authored skill
 * parses the same as a Unix one.
 */
export function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { fields: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { fields: {}, body: text };
  const block = text.slice(4, end);
  // The body starts after the closing fence's newline; the blank line that
  // usually follows it is not part of the body.
  const afterFence = text.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1).replace(/^\n+/, "");
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    // Strip one layer of matching quotes; a description may be quoted to protect a colon.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body };
}

/** One line of the listing for a skill: `- name: description`, capped. */
function listingLine(skill: Skill): string {
  const desc = skill.whenToUse ? `${skill.description} — ${skill.whenToUse}` : skill.description;
  const shown = desc.length > MAX_DESC_CHARS ? `${desc.slice(0, MAX_DESC_CHARS - 1)}…` : desc;
  return `- ${skill.name}: ${shown}`;
}

/**
 * The progressive-disclosure listing for the system prompt.
 *
 * `- name: description` per skill, in discovery order, capped to a character
 * budget with an "and N more" note — the same shape Claude Code uses, so the
 * model reads a stable, skimmable list and reaches for the `skill` tool to load
 * a body. Skills the model may not invoke are left out entirely.
 */
export function formatSkillListing(skills: Skill[]): string {
  const listed = skills.filter((skill) => !skill.disableModelInvocation);
  if (listed.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const skill of listed) {
    const line = listingLine(skill);
    if (used + line.length + 1 > LISTING_BUDGET_CHARS && shown > 0) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const more = listed.length - shown;
  if (more > 0) lines.push(`- …and ${more} more (use the \`skill\` tool to load one by name)`);
  return lines.join("\n");
}

/**
 * Discover every skill under `.actor0/skills/` in `cwd`.
 *
 * A missing directory is "no skills", not an error — most projects have none.
 * A file that cannot be a skill (no name, no description) is skipped with a
 * note rather than failing the turn: one malformed playbook must not stop the
 * agent. Duplicate names are kept and reported so the ambiguity is visible, not
 * silently collapsed.
 */
export function loadSkills(cwd: string): LoadResult {
  const dir = join(cwd, ...SKILLS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { skills: [], notes: [] };
  }
  const skills: Skill[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const file of names.sort()) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      notes.push(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const { fields, body } = parseFrontmatter(content);
    const name = (fields.name ?? file.replace(/\.md$/, "")).trim();
    const description = (fields.description ?? "").trim();
    if (!description) {
      notes.push(`skipped ${path}: no description in frontmatter`);
      continue;
    }
    if (seen.has(name)) {
      notes.push(`${path}: duplicate skill name "${name}" — it is ambiguous; resolve it by renaming one`);
    }
    seen.add(name);
    skills.push({
      name,
      description,
      ...(fields.when_to_use ? { whenToUse: fields.when_to_use.trim() } : {}),
      body,
      path,
      disableModelInvocation: (fields["disable-model-invocation"] ?? "").trim().toLowerCase() === "true",
    });
  }
  return { skills, notes };
}

/** The outcome of resolving a name the model asked for. */
export type SkillLookup =
  | { ok: true; skill: Skill }
  | { ok: false; reason: "not_found" | "ambiguous" | "disabled"; names: string[]; paths?: string[] };

/**
 * Resolve a skill by name.
 *
 * A plain name resolves only when it is **unique** — codex refuses to
 * auto-select an ambiguous name, and so does this: two skills called `deploy`
 * must not have one silently win. A disabled skill resolves to `disabled` so the
 * model is told it exists but may not be invoked, rather than "not found".
 */
export function findSkill(skills: Skill[], name: string): SkillLookup {
  const wanted = name.trim().replace(/^\//, "");
  const matches = skills.filter((skill) => skill.name === wanted);
  if (matches.length === 0) {
    return { ok: false, reason: "not_found", names: skills.map((skill) => skill.name) };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", names: matches.map((s) => s.name), paths: matches.map((s) => s.path) };
  }
  const skill = matches[0]!;
  if (skill.disableModelInvocation) {
    return { ok: false, reason: "disabled", names: [skill.name] };
  }
  return { ok: true, skill };
}

/**
 * Render a skill's body as the tool result the model reads.
 *
 * `$ARGUMENTS` is substituted with `args` when given, so a skill can be written
 * once and parameterised. The substitution is a literal split/join, not
 * `String.replace` — a body containing `$&` or `$1` must survive verbatim (the
 * same trap `edit` avoids). The body is data the model reads, never executed.
 */
export function renderSkill(skill: Skill, args?: string): string {
  const withArgs = args === undefined ? skill.body : skill.body.split("$ARGUMENTS").join(args);
  const body = withArgs.length > MAX_SKILL_BODY_CHARS
    ? `${withArgs.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[skill body truncated at ${MAX_SKILL_BODY_CHARS.toLocaleString("en-US")} characters]`
    : withArgs;
  return `[skill: ${skill.name}]\n\n${body.trim()}\n`;
}
