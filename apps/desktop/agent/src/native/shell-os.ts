import WebSocket from "ws";
import { readNeutralinoAuth } from "./bridge.js";

/**
 * The shell's `os` namespace, as a MinimalNeutralinoClient-shaped object.
 *
 * The opener needs exactly one method (`os.open`), and the bridge already
 * proves the shell is reachable before this runs. A shell that cannot be
 * reached (no Neutralino auth file, no socket) leaves the opener undefined,
 * which `openBrowserInShell` turns into "show the URL by hand" rather than a
 * silent failure.
 */
export function openShellOs(): { open: (url: string) => Promise<void> } | undefined {
  const auth = readNeutralinoAuth();
  if (!auth) return undefined;
  // The connect token is the *second* half of the access token (after the
  // "."), which is what the .tmp/auth_info.json calls nlConnectToken — the
  // first half is the token body and gets the handshake refused. The bridge's
  // own client (native/bridge.ts) uses the same split.
  const connectToken = auth.accessToken.includes(".")
    ? auth.accessToken.split(".")[1]!
    : auth.accessToken;
  return {
    async open(url: string): Promise<void> {
      // The socket is opened *here*, not at boot, and it carries a permanent
      // error listener from the moment it exists.
      //
      // It used to be one socket created eagerly at startup, with listeners
      // attached only once a sign-in asked this closure to use it. A packaged
      // launch whose shell socket refused the probe — a stale
      // `.tmp/auth_info.json` from a previous run, the shell not up yet — then
      // died at boot with "Unhandled 'error' event" on a port it had already
      // written to port.json, and the window could only ever say "disconnected
      // from the agent — retrying". A refused shell socket is a fallback
      // condition here (the caller shows the URL by hand), never a reason to
      // take the agent down with it.
      const client = new WebSocket(
        `ws://127.0.0.1:${auth.port}?connectToken=${encodeURIComponent(connectToken)}`,
      );
      client.on("error", () => undefined);
      const reply = await new Promise<{ success: boolean } | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 5_000);
        const settle = (value: { success: boolean } | undefined): void => {
          clearTimeout(timer);
          resolve(value);
        };
        client.once("message", (raw) => {
          try {
            settle(JSON.parse(String(raw)));
          } catch {
            settle(undefined);
          }
        });
        client.once("close", () => settle(undefined));
        try {
          client.send(
            JSON.stringify({ id: "open", method: "os.open", data: { url }, accessToken: auth.accessToken }),
          );
        } catch {
          settle(undefined);
        }
      });
      try {
        client.close();
      } catch {
        /* already closed by the refusal */
      }
      if (!reply?.success) throw new Error("the shell refused to open the browser");
    },
  };
}
