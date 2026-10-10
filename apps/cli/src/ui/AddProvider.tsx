import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { color } from "../theme.js";
import { TextInput } from "./prompts.js";
import { PROVIDER_KINDS, type ProviderKind } from "../provider-presets.js";
import { fetchModelInfos, fetchClaudePlan } from "../models.js";
import { runOAuthSignIn } from "../sign-in.js";
import { openBrowser } from "../oauth.js";
import { providerName, type NamedProvider } from "../config.js";
import type { OAuthTokens } from "../oauth.js";

/**
 * The add-provider flow `/provider → add` opens.
 *
 * A provider is a transport × auth choice, so this is three phases:
 *
 *   1. pick a kind (Claude, Anthropic, OpenAI-compatible — ChatGPT is prepared
 *      but its transport is not shipped, so it is not offered here);
 *   2. authenticate — sign in with OAuth in the browser, or paste a key;
 *   3. choose which of the *fetched* models to remember, or all, or none.
 *
 * The models are fetched from the provider itself rather than a hardcoded
 * catalog, because BYOK means the endpoint is the source of truth about itself
 * and a baked-in list goes stale the day a provider ships a model.
 *
 * "Remembering" a model means it joins the `/model` list and one becomes the
 * active model — the same shape `/model` already uses — so this adds exactly one
 * provider, not one per model.
 */

/** The kinds `/provider → add` offers — every transport the CLI can drive. */
const OFFERED = PROVIDER_KINDS;

export type AddProviderProps = {
  /** Register one provider, remember these models (first is active), and store any context windows. */
  onDone: (provider: NamedProvider, models: string[], contextWindows?: Record<string, number>) => void;
  onCancel: () => void;
  /** First run: frame the kind picker as a welcome rather than "add a provider". */
  onboarding?: boolean;
};

type Base = Omit<NamedProvider, "name" | "model">;

type Phase =
  | { kind: "kind" }
  | { kind: "key"; provider: ProviderKind }
  | { kind: "working"; provider: ProviderKind; note: string }
  | { kind: "models"; provider: ProviderKind; base: Base; models: string[]; cursor: number; chosen: Set<string>; windows: Record<string, number> }
  | { kind: "error"; provider: ProviderKind; message: string };

export function AddProvider({ onDone, onCancel, onboarding = false }: AddProviderProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "kind" });
  const [kindCursor, setKindCursor] = useState(0);
  const [key, setKey] = useState("");
  // A model typed by hand when the provider listed none — setup must not
  // dead-end on an empty model list.
  const [manual, setManual] = useState("");
  // Aborts an in-flight OAuth sign-in, which closes its loopback server — a
  // cancelled ChatGPT sign-in must not leave port 1455 occupied for the next one.
  const signInAbort = useRef<AbortController | null>(null);

  const signIn = (provider: ProviderKind) => {
    if (!provider.oauth) return;
    const controller = new AbortController();
    signInAbort.current = controller;
    setPhase({ kind: "working", provider, note: "opening your browser to authorize…" });
    void runOAuthSignIn(provider.oauth, {
      signal: controller.signal,
      // Show the URL as well as opening it, so a headless machine can complete
      // the flow by hand instead of hanging on a browser that never launched.
      openBrowser: (url) => {
        setPhase({ kind: "working", provider, note: `authorize in your browser (or open this URL):\n${url}` });
        openBrowser(url);
      },
    })
      .then(async (tokens) => {
        // Claude's plan is not in the token; fetch it from the profile so the
        // label reads "Claude Code - Max subscription" rather than a URL.
        const withPlan =
          provider.transport === "anthropic" && !tokens.plan
            ? { ...tokens, plan: await fetchClaudePlan(tokens.accessToken).catch(() => undefined) }
            : tokens;
        listModels(provider, buildBase(provider, { auth: "oauth", oauth: withPlan }));
      })
      .catch((error: Error) => setPhase({ kind: "error", provider, message: error.message }));
  };

  const listModels = (provider: ProviderKind, base: Base) => {
    setPhase({ kind: "working", provider, note: "listing models…" });
    void fetchModelInfos(base)
      .then((infos) => {
        // Keep any context window the provider publishes, so the status line can
        // show "Context N% used" without a hand-maintained table.
        const windows: Record<string, number> = {};
        for (const info of infos) if (info.contextWindow !== undefined) windows[info.id] = info.contextWindow;
        setPhase({ kind: "models", provider, base, models: infos.map((info) => info.id), cursor: 0, chosen: new Set(), windows });
      })
      .catch((error: Error) => setPhase({ kind: "error", provider, message: error.message }));
  };

  const register = (chosen: string[]) => {
    if (phase.kind !== "models") return;
    const active = chosen[0] ?? phase.models[phase.cursor];
    const provider: NamedProvider = { ...phase.base, name: providerName(phase.base.baseUrl), ...(active ? { model: active } : {}) };
    onDone(provider, chosen, phase.windows);
  };

  useInput((input, keypress) => {
    if (keypress.escape) {
      // Abort a running sign-in first, so its loopback closes before we leave.
      signInAbort.current?.abort();
      onCancel();
      return;
    }
    if (phase.kind === "kind") {
      if (keypress.upArrow || input === "k") return setKindCursor((n) => wrap(n, OFFERED.length, -1));
      if (keypress.downArrow || input === "j") return setKindCursor((n) => wrap(n, OFFERED.length, 1));
      if (keypress.return) {
        const chosen = OFFERED[kindCursor]!;
        if (chosen.auth.length === 1 && chosen.auth[0] === "oauth") signIn(chosen);
        else {
          setKey("");
          setPhase({ kind: "key", provider: chosen });
        }
      }
      return;
    }
    if (phase.kind === "error") {
      if (keypress.return) {
        const retry = phase.provider;
        if (retry.auth.includes("oauth") && retry.oauth && retry.auth.length === 1) signIn(retry);
        else {
          setKey("");
          setPhase({ kind: "key", provider: retry });
        }
      }
      return;
    }
    if (phase.kind === "models") {
      // An empty list hands the keyboard to the manual-entry input below.
      if (phase.models.length === 0) return;
      if (keypress.upArrow || input === "k") return setPhase({ ...phase, cursor: wrap(phase.cursor, phase.models.length, -1) });
      if (keypress.downArrow || input === "j") return setPhase({ ...phase, cursor: wrap(phase.cursor, phase.models.length, 1) });
      if (input === " ") {
        const model = phase.models[phase.cursor];
        if (!model) return;
        const chosen = new Set(phase.chosen);
        if (chosen.has(model)) chosen.delete(model);
        else chosen.add(model);
        return setPhase({ ...phase, chosen });
      }
      if (input === "a") return register(phase.models);
      if (input === "n") return register([]);
      if (keypress.return) {
        const model = phase.models[phase.cursor];
        return register(model ? [model] : []);
      }
    }
  });

  if (phase.kind === "kind") {
    return (
      <Box flexDirection="column" marginTop={1}>
        {onboarding ? (
          <>
            <Text color={color.accent} bold>welcome to actor0</Text>
            <Text color={color.dim}>{"bring your own provider — pick one to start"}</Text>
          </>
        ) : (
          <Text color={color.muted} bold>add a provider</Text>
        )}
        <Box flexDirection="column" marginLeft={2} marginTop={onboarding ? 1 : 0}>
          {OFFERED.map((kind, index) => (
            <Text key={kind.id} color={index === kindCursor ? color.accent : color.text}>
              {index === kindCursor ? "❯ " : "  "}
              {kind.label}
              <Text color={color.dim}>{`  ${kind.auth.join(" or ")}`}</Text>
            </Text>
          ))}
        </Box>
        <Box marginTop={1}><Text color={color.dim}>{"↑/↓ move · enter choose · esc cancel"}</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "key") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={color.muted} bold>{`${phase.provider.label} — API key`}</Text>
        <Box marginLeft={2}>
          <Text color={color.accent}>{"❯ "}</Text>
          <TextInput
            value={key}
            onChange={setKey}
            onSubmit={(raw) => {
              const apiKey = raw.trim();
              if (!apiKey) {
                setPhase({ kind: "error", provider: phase.provider, message: "an API key is required" });
                return;
              }
              listModels(phase.provider, buildBase(phase.provider, { auth: "api-key", apiKey }));
            }}
            placeholder="paste your API key"
          />
        </Box>
        <Box marginTop={1}><Text color={color.dim}>{"enter to continue · esc cancel"}</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "working") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={color.muted} bold>{phase.provider.label}</Text>
        <Box marginLeft={2}><Text color={color.info}>{phase.note}</Text></Box>
        <Box marginTop={1}><Text color={color.dim}>{"esc to cancel"}</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "error") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={color.error}>{phase.message}</Text>
        <Box marginTop={1}><Text color={color.dim}>{"enter to try again · esc cancel"}</Text></Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {phase.models.length === 0 ? (
        <>
          <Text color={color.muted} bold>{`${phase.provider.label} — no models listed`}</Text>
          <Text color={color.dim}>{"type a model name, or enter to add it and set one later with /model"}</Text>
          <Box marginLeft={2} marginTop={1}>
            <Text color={color.accent}>{"❯ "}</Text>
            <TextInput
              value={manual}
              onChange={setManual}
              onSubmit={(raw) => register(raw.trim() ? [raw.trim()] : [])}
              placeholder="model name"
            />
          </Box>
        </>
      ) : (
        <>
          <Text color={color.muted} bold>{`${phase.provider.label} — ${phase.models.length} models`}</Text>
          <Box flexDirection="column" marginLeft={2}>
            {phase.models.map((model, index) => (
              <Text key={model} color={index === phase.cursor ? color.accent : color.text}>
                {index === phase.cursor ? "❯ " : "  "}
                {phase.chosen.has(model) ? "◉ " : "○ "}
                {model}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={color.dim}>{"space toggles · a all · n none · enter uses highlighted · esc cancel"}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function wrap(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

function buildBase(
  provider: ProviderKind,
  auth: { auth: "api-key"; apiKey: string } | { auth: "oauth"; oauth: OAuthTokens },
): Base {
  return {
    baseUrl: provider.baseUrl,
    transport: provider.transport,
    ...(provider.path ? { path: provider.path } : {}),
    ...auth,
  };
}
