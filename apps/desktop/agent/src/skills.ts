import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills — progressive disclosure of reusable instructions.
 *
 * A skill is a named playbook the model loads on demand. The system prompt
 * always carries each skill's name and one-line description (cheap, so a
 * project can have many skills without bloating the prompt); the full body is
 * read only when the model calls the `skill` tool. That split — always-on
 * listing, on-demand body — is the whole feature.
 */

/** Where project-local skills live, relative to the working directory. */
export const SKILLS_DIR = [".actor0", "skills"] as const;

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

export type LoadResult = { skills: Skill[]; notes: string[] };

const MAX_DESC_CHARS = 200;
const LISTING_BUDGET_CHARS = 4_000;
const MAX_SKILL_BODY_CHARS = 32_000;

/**
 * Parse `---`-fenced `key: value` frontmatter and the body after it.
 *
 * Minimal on purpose: the fields are four scalar strings, and a YAML parser for
 * four keys is not worth a dependency. CRLF is normalised so a Windows-authored
 * skill parses like a Unix one.
 */
export function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { fields: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { fields: {}, body: text };
  const block = text.slice(4, end);
  const afterFence = text.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1).replace(/^\n+/, "");
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body };
}

/** The always-on listing: name, description, and when-to-use, within a budget. */
export function formatSkillListing(skills: Skill[]): string {
  const listed = skills.filter((skill) => !skill.disableModelInvocation);
  if (listed.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const skill of listed) {
    const description = skill.description.length > MAX_DESC_CHARS ? `${skill.description.slice(0, MAX_DESC_CHARS)}...` : skill.description;
    const when = skill.whenToUse ? ` (use when: ${skill.whenToUse})` : "";
    const line = `- ${skill.name}: ${description}${when}`;
    if (used + line.length > LISTING_BUDGET_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** Discover every skill under `.actor0/skills/` in `cwd`. */
export function loadSkills(cwd: string): LoadResult {
  const dir = join(cwd, ...SKILLS_DIR);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { skills: [], notes: [] };
  }
  const skills: Skill[] = [];
  const notes: string[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      notes.push(`${file}: could not be read (${(error as Error).message})`);
      continue;
    }
    const { fields, body } = parseFrontmatter(raw);
    const name = fields.name?.trim() || file.slice(0, -3);
    const description = fields.description?.trim() || "";
    if (!description) {
      notes.push(`${file}: skipped (no description in frontmatter)`);
      continue;
    }
    skills.push({
      name,
      description,
      ...(fields.when_to_use?.trim() ? { whenToUse: fields.when_to_use.trim() } : {}),
      body: body.trim(),
      path,
      disableModelInvocation: /^(true|yes|1)$/i.test(fields["disable-model-invocation"]?.trim() ?? ""),
    });
  }
  return { skills, notes };
}

export type SkillLookup =
  | { ok: true; skill: Skill }
  | { ok: false; reason: "not_found"; names: string[] }
  | { ok: false; reason: "ambiguous"; paths: string[] }
  | { ok: false; reason: "disabled" };

/** Find one skill by name, refusing to guess between duplicates. */
export function findSkill(skills: Skill[], name: string): SkillLookup {
  const wanted = name.trim();
  const matches = skills.filter((skill) => skill.name === wanted);
  if (matches.length === 0) return { ok: false, reason: "not_found", names: skills.map((skill) => skill.name) };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", paths: matches.map((skill) => skill.path) };
  const skill = matches[0]!;
  if (skill.disableModelInvocation) return { ok: false, reason: "disabled" };
  return { ok: true, skill };
}

/** The skill body with `$ARGUMENTS` filled in, capped. */
export function renderSkill(skill: Skill, args: string | undefined): string {
  const withArgs = args === undefined ? skill.body : skill.body.split("$ARGUMENTS").join(args);
  const body =
    withArgs.length > MAX_SKILL_BODY_CHARS
      ? `${withArgs.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[skill body truncated at ${MAX_SKILL_BODY_CHARS.toLocaleString("en-US")} characters]`
      : withArgs;
  return `# Skill: ${skill.name}\n\n${body}`;
}
