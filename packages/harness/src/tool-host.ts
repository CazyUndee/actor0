import type { ToolCall, ToolHost } from "./types.js";

/**
 * Combine tool hosts, so a caller can offer one model several sets of tools.
 *
 * The harness has a single `ToolHost` port, but a real host is often several:
 * the CLI's own file and shell tools, plus whatever an MCP server exposes.
 * These two combinators let those be assembled without any of them knowing
 * about the others. They are pure and transport-neutral — no spawning, no
 * network, no JSON-RPC — so they live beside the port they operate on rather
 * than in any one host's implementation.
 */

/**
 * A host whose every tool name carries `prefix`, so it cannot collide with
 * another host's.
 *
 * The prefix is stripped again on the way in, so the wrapped host is unchanged
 * and never learns it was namespaced. A call that does not carry the prefix is
 * refused here rather than forwarded: forwarding it would run some other
 * namespace's tool under this one's name.
 */
export function namespacedToolHost(prefix: string, host: ToolHost): ToolHost {
  return {
    definitions: () =>
      host.definitions().map((definition) => ({
        ...definition,
        function: { ...definition.function, name: `${prefix}${definition.function.name}` },
      })),
    async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
      if (!call.function.name.startsWith(prefix)) {
        throw new Error(`tool "${call.function.name}" is not in the "${prefix}" namespace`);
      }
      return host.execute(
        { ...call, function: { ...call.function, name: call.function.name.slice(prefix.length) } },
        signal,
      );
    },
  };
}

/**
 * Merge hosts into one. Definitions concatenate in order; a call is routed to
 * the first host that offers a tool of that name.
 *
 * Two hosts offering the same tool name is the caller's problem — namespace one
 * with `namespacedToolHost` first — because taking the first silently makes the
 * second host's tool of that name unreachable, with nothing anywhere to say so.
 */
export function compositeToolHost(hosts: ToolHost[]): ToolHost {
  return {
    definitions: () => hosts.flatMap((host) => host.definitions()),
    async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
      for (const host of hosts) {
        const offers = host
          .definitions()
          .some((definition) => definition.function.name === call.function.name);
        if (offers) return host.execute(call, signal);
      }
      const known = hosts.flatMap((host) => host.definitions().map((d) => d.function.name));
      throw new Error(`unknown tool "${call.function.name}". Available: ${known.join(", ")}`);
    },
  };
}
