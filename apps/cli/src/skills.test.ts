import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSkill,
  formatSkillListing,
  loadSkills,
  parseFrontmatter,
  renderSkill,
  type Skill,
} from "./skills.js";

/**
 * Skills: frontmatter parsing, discovery, the progressive-disclosure listing,
 * name resolution (uniqueness / ambiguity / disabled), and body rendering.
 */

const withDir = <T>(body: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-skills-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: "s",
  description: "do the thing",
  body: "body",
  path: "/x/s.md",
  disableModelInvocation: false,
  ...over,
});

const writeSkill = (dir: string, file: string, content: string): void => {
  mkdirSync(join(dir, ".actor0", "skills"), { recursive: true });
  writeFileSync(join(dir, ".actor0", "skills", file), content, "utf8");
};

// --- frontmatter ----------------------------------------------------------

test("frontmatter splits fields from the body", () => {
  const { fields, body } = parseFrontmatter("---\nname: greet\ndescription: Say hi\n---\n\nHello.\n");
  assert.equal(fields.name, "greet");
  assert.equal(fields.description, "Say hi");
  assert.equal(body, "Hello.\n");
});

test("a file with no frontmatter is all body", () => {
  const { fields, body } = parseFrontmatter("just instructions\n");
  assert.deepEqual(fields, {});
  assert.equal(body, "just instructions\n");
});

test("a quoted value keeps its colon, and CRLF is normalised", () => {
  const { fields } = parseFrontmatter("---\r\ndescription: \"deploy: ship it\"\r\n---\r\nbody\r\n");
  assert.equal(fields.description, "deploy: ship it");
});

// --- discovery ------------------------------------------------------------

test("a missing skills directory is no skills, not an error", () => {
  withDir((dir) => assert.deepEqual(loadSkills(dir), { skills: [], notes: [] }));
});

test("discovery reads name, description, when_to_use and the body", () => {
  withDir((dir) => {
    writeSkill(dir, "deploy.md", "---\nname: deploy\ndescription: Ship the app\nwhen_to_use: before a release\n---\n\nRun the deploy.\n");
    const { skills, notes } = loadSkills(dir);
    assert.deepEqual(notes, []);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "deploy");
    assert.equal(skills[0]!.whenToUse, "before a release");
    assert.equal(skills[0]!.body, "Run the deploy.\n");
  });
});

test("a file with no description is skipped with a note, not fatal", () => {
  withDir((dir) => {
    writeSkill(dir, "bad.md", "---\nname: bad\n---\n\nno description here\n");
    const { skills, notes } = loadSkills(dir);
    assert.equal(skills.length, 0);
    assert.match(notes.join("\n"), /no description/);
  });
});

test("a duplicate name is kept and reported as ambiguous", () => {
  withDir((dir) => {
    writeSkill(dir, "a.md", "---\nname: dup\ndescription: first\n---\n\nA\n");
    writeSkill(dir, "b.md", "---\nname: dup\ndescription: second\n---\n\nB\n");
    const { skills, notes } = loadSkills(dir);
    assert.equal(skills.length, 2);
    assert.match(notes.join("\n"), /duplicate skill name "dup"/);
  });
});

// --- listing --------------------------------------------------------------

test("the listing is one name: description line per skill, when_to_use appended", () => {
  const listing = formatSkillListing([
    skill({ name: "deploy", description: "Ship it", whenToUse: "before a release" }),
    skill({ name: "test", description: "Run tests" }),
  ]);
  assert.equal(listing, "- deploy: Ship it — before a release\n- test: Run tests");
});

test("a model-disabled skill is left out of the listing", () => {
  const listing = formatSkillListing([
    skill({ name: "secret", description: "hidden", disableModelInvocation: true }),
    skill({ name: "open", description: "visible" }),
  ]);
  assert.equal(listing, "- open: visible");
});

test("the listing is capped, with a note for the rest", () => {
  const many = Array.from({ length: 40 }, (_, i) => skill({ name: `s${i}`, description: "x".repeat(200) }));
  const listing = formatSkillListing(many);
  assert.match(listing, /and \d+ more/);
  assert.ok(listing.length <= 4_000 + 200, `listing was ${listing.length} chars`);
});

// --- resolution -----------------------------------------------------------

test("a unique name resolves; an unknown one lists what exists", () => {
  const skills = [skill({ name: "deploy" }), skill({ name: "test" })];
  assert.equal(findSkill(skills, "deploy").ok, true);
  const miss = findSkill(skills, "nope");
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.deepEqual(miss.names.sort(), ["deploy", "test"]);
});

test("an ambiguous name is refused, never guessed", () => {
  const miss = findSkill([skill({ name: "dup", path: "/a.md" }), skill({ name: "dup", path: "/b.md" })], "dup");
  assert.equal(miss.ok, false);
  if (!miss.ok) {
    assert.equal(miss.reason, "ambiguous");
    assert.deepEqual(miss.paths, ["/a.md", "/b.md"]);
  }
});

test("a disabled skill resolves to disabled, not not-found", () => {
  const miss = findSkill([skill({ name: "x", disableModelInvocation: true })], "x");
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.reason, "disabled");
});

// --- rendering ------------------------------------------------------------

test("renderSkill returns the body under a header and fills $ARGUMENTS", () => {
  const out = renderSkill(skill({ name: "greet", body: "Say hello to $ARGUMENTS." }), "Bob");
  assert.match(out, /^\[skill: greet\]/);
  assert.match(out, /Say hello to Bob\./);
});

test("$ARGUMENTS substitution is literal — $& and $1 survive verbatim", () => {
  // String.replace would read $& and $1 as its own syntax and rewrite them.
  const out = renderSkill(skill({ body: "a $ARGUMENTS b $& c $1" }), "X");
  assert.match(out, /a X b \$& c \$1/);
});

test("an oversized body is truncated with a note", () => {
  const out = renderSkill(skill({ body: "y".repeat(40_000) }));
  assert.match(out, /truncated at 32,000 characters/);
  assert.ok(out.length < 40_000);
});
