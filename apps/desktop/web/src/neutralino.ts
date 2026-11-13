/**
 * The slice of Neutralino's global API this app uses.
 *
 * Declared once, here, rather than in each module that touches it: two
 * `declare global` blocks for the same property are a type error, and the
 * duplication is how they drift. Only the methods this app actually calls are
 * described — a hand-written declaration that claims more than the framework
 * ships is worse than none, because the compiler would then bless a call that
 * fails at runtime.
 */

export type NeutralinoSpawnedProcess = { id: number; pid: number };

export type NeutralinoEvent = { detail: { id: string; action: string; data?: string } };

export type NeutralinoApi = {
  os?: {
    spawnProcess(command: string, options?: { cwd?: string; envs?: Record<string, string> }): Promise<NeutralinoSpawnedProcess>;
    updateSpawnedProcess?(id: number, event: string, data?: unknown): Promise<void>;
    getEnv(key: string): Promise<string>;
    /** Open a URL in the user's default browser — the desktop equivalent of `xdg-open`. */
    open(url: string): Promise<void>;
    showNotification?(title: string, content: string, icon?: string): Promise<void>;
  };
  filesystem?: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    createDirectory(path: string): Promise<void>;
  };
  events?: { on(name: string, handler: (event: NeutralinoEvent) => void): Promise<void> };
  window?: {
    setTitle(title: string): Promise<void>;
    minimize?(): Promise<void>;
    close?(): Promise<void>;
  };
};

declare global {
  interface Window {
    Neutralino?: NeutralinoApi;
    /** The app directory. */
    NL_PATH?: string;
    /** The shell's own port. */
    NL_PORT?: string;
  }
}
