# actor0 desktop

A native window around the same harness the CLI runs. Two processes, on purpose:

```
 Neutralino shell (C++ core + OS webview)
   serves resources/app   ← the React UI (this package's `src`)
   spawns  node resources/agent/agent.mjs  ← the agent core (apps/desktop/agent)
                │
                └── its own localhost WebSocket ← the UI's `src/client.ts`
```

The shell is a *host*, not an engine: it owns the window, the native filesystem
API the agent's tools can use, and the process supervision. The agent is a
second headless host of `@actor0/harness` — sibling to the CLI's `print.ts` and
`mcp-serve.ts` — and it imports no CLI code.

## Development

The UI runs in a browser with the agent beside it, which is the fastest loop:

```bash
# terminal 1 — the agent, on the dev default port
ACTOR0_AGENT_PORT=3000 npm --workspace @actor0/desktop-agent run dev

# terminal 2 — the UI
npm --workspace @actor0/desktop-web run dev
```

Open http://127.0.0.1:5174. The UI finds the agent at `ws://127.0.0.1:3000`
because there is no shell to write `.tmp/agent.json`.

To run the real window, build both halves and let Neutralino serve them:

```bash
npm --workspace @actor0/desktop-web run shell     # build UI + agent, then `neu run`
```

`neu` needs the platform binaries in `apps/desktop/web/bin`, which
`npx neu update` fetches once. The agent binary is a stock Node ≥ 22 named in
the config's `commandAllowList`, so the shell can start it and nothing else.

## Packaging

```bash
npm --workspace @actor0/desktop-web run package:win
```

`neu build` produces the platform binary and `resources.neu`, which contains
both `resources/app` (the UI) and `resources/agent/agent.mjs` (the agent). The
runner must be present beside the binary as `node`/`node.exe`; the config's
`commandAllowList` names it.

## Where the state lives

The same places the CLI uses, in the same formats:

- `$ACTOR0_CONFIG_DIR` (default `~/.config/actor0`) — `config.json`
- `$ACTOR0_DATA_DIR` (default `~/.local/share/actor0`) — `sessions/*.json`, `usage.jsonl`

So a conversation started in the CLI resumes here, and the other way round.
