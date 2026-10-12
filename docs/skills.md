# Skills — design

Rebuilding the progressive-disclosure **skills** feature that was lost (it only
ever existed as uncommitted work; no git object holds it). This is a fresh build
guided by the design we settled on and by two reference implementations.

## What a skill is

A skill is a **named, self-contained set of instructions** the model can load on
demand — a reusable playbook ("how we do X in this repo"). It is *progressive
disclosure*: the model always sees the skill's **name + one-line description**
(cheap), and only pays for the **full body** when it decides to use the skill.
That keeps the system prompt small no matter how many skills exist, while making
every skill reachable.

## Reference findings (the mechanism, not the file format)

- **Claude Code** (`tools/SkillTool`, `skills/loadSkillsDir`, `SkillTool/prompt`):
  skill = frontmatter + body in `.claude/skills/`; the prompt carries a
  budget-capped `- name: description` listing (1% of the context window, ~250
  chars/description); a `Skill` tool takes `{skill, args}` and injects the body
  as a message; safety via `disable-model-invocation` + permission rules.
- **Codex** (`skills/{selection,mentions,invocation}.rs`): name+description in
  the prompt, bodies never in the prompt; explicit `$skill-name` mention *or*
  an implicit trigger (running a skill's script, or reading its `SKILL.md`)
  loads the body; safety = disabled skills excluded, **ambiguous duplicate names
  are never auto-selected by plain name**, and name/connector-slug collisions
  are disambiguated.

## Design for actor0

**Source & format.** Skills are markdown files in `.actor0/skills/` (project
root), one file per skill: `.actor0/skills/<name>.md`. Each file is YAML-ish
frontmatter (`---`-fenced) with `name`, `description`, optional `when_to_use`
and optional `disable-model-invocation`, then a body. A minimal `key: value`
frontmatter parser (no full YAML dependency) is enough — the fields are simple
strings. Flat files, not one-dir-per-skill: the model already has `read`/`shell`
for any side resources a skill references, so skills don't need a bundling
mechanism for v1. (One-dir-per-skill with a base-dir header is the natural
follow-up if skills start shipping resources.)

**Discovery** (`loadSkills(cwd)`): read `.actor0/skills/*.md`, parse frontmatter
+ body. Missing dir → no skills (not an error). A malformed file is skipped with
a note rather than failing the turn. Duplicate names are kept and surfaced as a
conflict, never silently collapsed.

**Progressive-disclosure listing** (`formatSkillListing`): `- name: description`
lines (`when_to_use` appended after an em dash when present), each description
capped, the whole listing capped to a character budget with an "and N more"
note. Appended to the system prompt beside the project-context block, so the
model always knows what skills exist.

**The `skill` tool** (in the `tools.ts` registry, like `taskTool`): takes
`{ name, args? }`. It discovers skills from `ctx.cwd`, resolves the name, and
returns the body under a `Skill: <name>` header (the same shape as reading a
file the model was pointed at). Optional `args` are substituted for `$ARGUMENTS`
in the body. Unknown name → an error that lists the available skills. The body
is returned as text and size-capped; it is **never executed** (no shell
expansion of skill content).

**Safety**, drawn from both references:
- `disable-model-invocation: true` → the skill is *not* listed in the prompt and
  the tool refuses to load it (user-invocable only).
- An **ambiguous** name (two skills share it) → the tool refuses rather than
  guessing, and says so. The plain name is only resolved when it is unique.
- Skills live under `.actor0/skills/` inside the working directory (contained,
  like every other path the tools touch); the body is data the model reads, and
  the system prompt already tells the model to treat file/project content as
  data, not instructions.
- The returned body is capped, so one pathological skill cannot blow the window.

**Integration.**
- `apps/cli/src/skills.ts` — types, frontmatter parse, `loadSkills`,
  `formatSkillListing`, `findSkill`, `renderSkill`.
- `apps/cli/src/tools.ts` — `skillTool` added to `TOOLS` (count 7 → 8); it
  discovers + renders on call.
- `apps/cli/src/turn.ts` — `withProjectContext` appends the skill listing.

(When the `@actor0/tools` satellite lands, `skills.ts` + `skillTool` move there;
for now they live in the CLI, matching where `taskTool` lives.)

**Out of scope for v1:** forked/sub-agent skill execution, `allowed-tools`
restriction, model/effort overrides, user-level (`~/.actor0/skills/`) skills,
one-dir-per-skill with bundled resources. All are additive later.

## Tests

`skills.test.ts`: discovery (present/missing/malformed), frontmatter fields,
`disable-model-invocation` exclusion, listing format + budget cap, `findSkill`
uniqueness/ambiguity, `renderSkill` header + `$ARGUMENTS` + size cap.
`tools.test.ts`: tool count 7 → 8, the `skill` tool returns a body and errors on
an unknown name.
