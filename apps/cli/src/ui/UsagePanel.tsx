import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { color } from "../theme.js";
import {
  formatTokens,
  readUsage,
  startOfDay,
  startOfMonth,
  startOfWeek,
  usageByModel,
  usageSince,
} from "../usage.js";

/**
 * The `/usage` panel: tokens used, switchable between today, this week and this
 * month with Tab, plus the provider's quota when it reports one.
 *
 * Token counts come from the local log — exact and universal, since every
 * provider reports them — so today/week/month are totalled with no round trip.
 * Quota *remaining* is provider-specific; `quota` is passed in when the caller
 * can fetch it, and the panel says so plainly when it cannot rather than
 * inventing a number.
 */

type Period = "day" | "week" | "month";

const PERIODS: { key: Period; label: string; since: (now: Date) => number }[] = [
  { key: "day", label: "Today", since: startOfDay },
  { key: "week", label: "This week", since: startOfWeek },
  { key: "month", label: "This month", since: startOfMonth },
];

export type UsagePanelProps = {
  /** Quota remaining, when the provider reports it; undefined when it does not. */
  quota?: { label: string; remaining: string };
  onCancel: () => void;
};

export function UsagePanel({ quota, onCancel }: UsagePanelProps) {
  const [index, setIndex] = useState(0);
  const entries = readUsage();
  const now = new Date();
  const period = PERIODS[index]!;
  const bucket = usageSince(entries, period.since(now));
  const allTime = usageSince(entries, 0);
  const byModel = usageByModel(entries, period.since(now));

  useInput((input, key) => {
    if (key.tab || key.rightArrow) return setIndex((n) => (n + 1) % PERIODS.length);
    if (key.leftArrow) return setIndex((n) => (n - 1 + PERIODS.length) % PERIODS.length);
    if (input >= "1" && input <= "3") return setIndex(Number(input) - 1);
    if (key.escape) return onCancel();
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color.muted} bold>usage</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text color={color.dim}>{PERIODS.map((p, i) => (i === index ? `[${p.label}]` : ` ${p.label} `)).join(" ")}</Text>
        <Text color={color.text}>
          {`${formatTokens(bucket.tokens)} tokens`}
          <Text color={color.dim}>{`  across ${bucket.turns} turn${bucket.turns === 1 ? "" : "s"}`}</Text>
        </Text>
        <Text color={color.dim}>{`all time: ${formatTokens(allTime.tokens)} tokens across ${allTime.turns} turns`}</Text>
        {byModel.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {byModel.slice(0, 5).map((row) => (
              <Text key={row.model} color={color.muted}>
                {`  ${formatTokens(row.tokens).padStart(7)}  ${row.model}`}
              </Text>
            ))}
          </Box>
        ) : null}
        <Text color={quota ? color.text : color.dim}>
          {quota ? `quota: ${quota.remaining} ${quota.label}` : "quota: not reported by this provider"}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={color.dim}>{"tab or 1/2/3 switches period · esc closes"}</Text>
      </Box>
    </Box>
  );
}
