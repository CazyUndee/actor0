import assert from "node:assert/strict";
import { test } from "node:test";
import { moveSelection, providerMenuRows } from "./ProviderMenu.js";
import type { NamedProvider } from "../config.js";

/**
 * The provider menu's pure logic — the row model and the wrap-around — tested
 * without a terminal. The rendering and key handling need Ink and are exercised
 * by the TUI preview; what is worth pinning here is the shape the keyboard acts
 * on, because an off-by-one in it selects the wrong endpoint.
 */

const provider = (name: string, model?: string): NamedProvider => ({
  name,
  baseUrl: `https://${name}/v1`,
  ...(model ? { model } : {}),
});

test("the menu always ends with the add action", () => {
  const rows = providerMenuRows([], undefined);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["add"],
    "with no providers, add is all there is — BYOK has no built-in row",
  );
});

test("providers come first, and the active one is marked", () => {
  const rows = providerMenuRows([provider("a.example.com", "m-a"), provider("b.example.com", "m-b")], "b.example.com");
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["provider", "provider", "add"],
  );
  const [first, second] = rows as Extract<(typeof rows)[number], { kind: "provider" }>[];
  assert.equal(first!.active, false);
  assert.equal(second!.active, true);
});

test("a provider row shows its model, or its host when it has no model yet", () => {
  const rows = providerMenuRows([provider("a.example.com", "m-a"), provider("b.example.com")], "a.example.com");
  const providers = rows.filter((row) => row.kind === "provider");
  assert.equal(providers[0]!.kind === "provider" && providers[0]!.detail, "m-a");
  assert.equal(providers[1]!.kind === "provider" && providers[1]!.detail, "https://b.example.com/v1");
});

test("selection wraps at both ends", () => {
  assert.equal(moveSelection(0, 3, -1), 2, "up from the top wraps to the bottom");
  assert.equal(moveSelection(2, 3, 1), 0, "down from the bottom wraps to the top");
  assert.equal(moveSelection(1, 3, 1), 2);
  assert.equal(moveSelection(1, 3, -1), 0);
});

test("a delta larger than the list still lands on a real row", () => {
  assert.equal(moveSelection(0, 3, 4), 1, "4 forward in a list of 3 is 1");
  assert.equal(moveSelection(0, 3, -4), 2, "and 4 back is 2");
});

test("an empty menu selects nothing rather than throwing", () => {
  assert.equal(moveSelection(0, 0, 1), 0);
  assert.equal(moveSelection(5, 0, -1), 0);
});
