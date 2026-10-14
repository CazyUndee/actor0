// One-shot probe: does this provider accept candidate D's oneOf union schema?
// The spec says if the provider's structured tool-calling rejects it, D must be
// marked unsupported for that provider — never assumed. Prints the verdict and
// records it in d-oneof-probe-<provider>.txt.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CANDIDATE_D } from "./candidates.js";
import { createModel } from "@actor0/providers";
import { loadConfig, resolveProvider } from "../../src/config.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const providerName = flag("--provider");
const config = loadConfig();
const provider = resolveProvider(providerName ? { ...config, activeProvider: providerName } : config);
const client = createModel(provider);
const tools = CANDIDATE_D.tools.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);

try {
  const iter = client.stream(
    [{ role: "user", content: "list the files in the current directory, briefly" }],
    tools,
    controller.signal,
  );
  let first = "";
  for await (const event of iter) {
    if (event.type === "status" && !first) first = event.note;
    if (event.type === "tool_call" || event.type === "done") break;
  }
  const verdict = "accepted — the provider streamed with D's oneOf union schema (first status: " + (first || "(none)") + ")";
  writeFileSync(join(process.cwd(), "apps/cli/scripts/benchmark", `d-oneof-probe-${providerName ?? "active"}.txt`), `${verdict}\n`);
  console.log(`D oneOf vs ${provider.model} @ ${provider.baseUrl}: ${verdict}`);
} catch (error) {
  const message = String(error);
  const rejected = /invalid|oneof|one_of|bad request|400/i.test(message);
  const verdict = rejected
    ? "rejected — D must be marked unsupported for this provider"
    : `undetermined: ${message.slice(0, 200)}`;
  writeFileSync(join(process.cwd(), "apps/cli/scripts/benchmark", `d-oneof-probe-${providerName ?? "active"}.txt`), `${verdict}\n`);
  console.log(`D oneOf vs ${provider.model} @ ${provider.baseUrl}: ${verdict}`);
} finally {
  clearTimeout(timer);
}
