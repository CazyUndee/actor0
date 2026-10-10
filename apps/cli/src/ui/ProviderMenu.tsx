import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { color } from "../theme.js";
import type { NamedProvider } from "../config.js";
import { providerLabel } from "../provider-presets.js";

/**
 * The provider menu `/provider` opens.
 *
 * It replaces the composer while it is open, so it owns the keyboard the way a
 * modal does: the composer's input is inactive, and this component's `useInput`
 * handles the arrow keys, enter, and the few letter shortcuts. That is the same
 * division the app already uses — one interactive region at a time — and it is
 * why nothing here reaches into the composer.
 *
 * The row model and the wrap-around are pure functions below the component, so
 * the navigation can be tested without a terminal; only the rendering and the
 * key handling need Ink.
 */

export type MenuRow =
  | { kind: "provider"; name: string; label: string; model?: string; active: boolean }
  | { kind: "add" };

/**
 * The rows the menu shows: the registered providers, then the add action.
 *
 * Each provider row carries a readable label ("Claude Code - Pro subscription",
 * "Anthropic API - Direct") rather than a URL — the whole point of recognising
 * several providers at a glance. `name` stays as the identity for callbacks.
 */
export function providerMenuRows(providers: NamedProvider[], activeName: string | undefined): MenuRow[] {
  const rows: MenuRow[] = providers.map((provider) => ({
    kind: "provider",
    name: provider.name,
    label: providerLabel(provider),
    model: provider.model,
    active: provider.name === activeName,
  }));
  rows.push({ kind: "add" });
  return rows;
}

/** Move `current` by `delta`, wrapping at both ends. */
export function moveSelection(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

export type ProviderMenuProps = {
  providers: NamedProvider[];
  activeName: string | undefined;
  onActivate: (name: string) => void;
  onAdd: () => void;
  onRemove: (name: string) => void;
  onCancel: () => void;
};

export function ProviderMenu({ providers, activeName, onActivate, onAdd, onRemove, onCancel }: ProviderMenuProps) {
  const rows = providerMenuRows(providers, activeName);
  const [selected, setSelected] = useSelection(rows.length);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelected((index) => moveSelection(index, rows.length, -1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((index) => moveSelection(index, rows.length, 1));
      return;
    }
    if (key.return) {
      const row = rows[selected];
      if (!row) return;
      if (row.kind === "provider") onActivate(row.name);
      else onAdd();
      return;
    }
    if (input === "n") {
      onAdd();
      return;
    }
    // `d` removes the highlighted provider, and only a provider — the built-in
    // row and the add action are not removable, so `d` there does nothing
    // rather than something surprising.
    if (input === "d") {
      const row = rows[selected];
      if (row?.kind === "provider") onRemove(row.name);
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color.muted} bold>
        providers
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {providers.length === 0 ? (
          // First run: BYOK means there is nothing to talk to yet. Say so, and
          // point at the one action that fixes it, rather than an empty list
          // the user has to interpret.
          <Text color={color.dim}>{"none yet — add one to start"}</Text>
        ) : null}
        {rows.map((row, index) => (
          <MenuRowView key={rowKey(row, index)} row={row} selected={index === selected} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={color.dim}>{"↑/↓ move · enter select · n new · d remove · esc close"}</Text>
      </Box>
    </Box>
  );
}

function MenuRowView({ row, selected }: { row: MenuRow; selected: boolean }) {
  const tone = selected ? color.accent : color.text;
  const marker = selected ? "❯ " : "  ";

  if (row.kind === "add") {
    return <Text color={tone}>{`${marker}+ add new provider`}</Text>;
  }

  // Sibling `<Text>`s in a row `Box`, not nested `<Text>`: Ink wraps the
  // children of a `<Text>`, and two unkeyed nested `<Text>`s collide on an empty
  // key. As flex siblings they need no keys and reconcile cleanly.
  const bullet = row.active ? "● " : "○ ";
  return (
    <Box flexDirection="row">
      <Text color={tone}>{`${marker}${bullet}${row.label}`}</Text>
      {row.model ? <Text color={color.dim}>{`  ${row.model}`}</Text> : null}
      {row.active ? <Text color={color.dim}>{"  (in use)"}</Text> : null}
    </Box>
  );
}

function rowKey(row: MenuRow, index: number): string {
  return row.kind === "provider" ? `provider:${row.name}` : `${row.kind}:${index}`;
}

/**
 * A selection index that resets to the top whenever the row count changes.
 *
 * The count changes when a removal shrinks the list while the menu stays open.
 * Clamping instead of resetting would keep pointing at an index that now names a
 * different row — or none — which is the off-by-one that selects the wrong
 * endpoint. Resetting to the top is honest: the row that was highlighted a
 * moment ago is gone or moved.
 */
function useSelection(count: number): [number, (update: (index: number) => number) => void] {
  const [index, setIndex] = useState(0);
  const [seen, setSeen] = useState(count);
  useEffect(() => {
    if (count !== seen) {
      setSeen(count);
      setIndex(0);
    }
  }, [count, seen]);
  const clamped = count <= 0 ? 0 : Math.min(index, count - 1);
  return [clamped, setIndex];
}
