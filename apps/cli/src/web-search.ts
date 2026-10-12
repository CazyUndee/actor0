import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Web search + page fetch, via the `mst` and `webclaw` binaries.
 *
 * Both are Apache-2.0 command-line tools actor0 *spawns as separate
 * processes* — it never imports or links their code — so actor0 stays MIT and
 * a user who never searches pays nothing. `mst` is keyless meta-search
 * (fan-out to engines, RRF-ranked, JSON out); `webclaw` is keyless page
 * extraction (URL → clean markdown). Together: `mst` discovers, `webclaw`
 * reads.
 *
 * Each binary is pinned and auto-installed to `~/.local/bin` on first use —
 * downloaded from its GitHub release, SHA256-verified, extracted — so search
 * works out of the box with no API key and no config. A missing binary or a
 * failed install is a clear, actionable error, never a silent empty result.
 *
 * `~/.local/bin` and the binary paths are overridable by env vars
 * (`ACTOR0_BIN_DIR`, `ACTOR0_MST_BIN`, `ACTOR0_WEBCLAW_BIN`) so the spawn and
 * parsing layers are testable without the real tools or the network.
 */

/** Pinned versions — bump only when it is worth it (see AGENTS.md). */
const TOOLS = {
  mst: { repo: "openmtx/meta-search-tool", tag: "v0.3.2", sums: "SHA256SUMS.txt" },
  webclaw: { repo: "0xMassi/webclaw", tag: "v0.6.14", sums: "SHA256SUMS" },
} as const;

export type ToolName = keyof typeof TOOLS;

/** One ranked result from `mst`. */
export type SearchResult = {
  rank: number;
  title: string;
  url: string;
  score: number;
  engines: string[];
  snippet?: string;
};

export type SearchEnvelope = {
  query: string;
  tookMs: number;
  results: SearchResult[];
};

/** The release archive + executable name for a tool on this platform. */
export type AssetSpec = { asset: string; exe: string };

/**
 * Map a platform/arch to the release archive + binary name.
 *
 * `mst` names archives `mst-<tag>-<os>-<arch>.{tar.gz,zip}` (zip on Windows);
 * `webclaw` uses Rust target triples (`…-unknown-linux-gnu`, `…-apple-darwin`,
 * `x86_64-pc-windows-msvc`) with zip only on Windows. Returns undefined for an
 * unsupported platform rather than guessing an asset that 404s.
 */
export function assetSpec(name: ToolName, platform: NodeJS.Platform, arch: string): AssetSpec | undefined {
  const { tag } = TOOLS[name];
  const exe = platform === "win32" ? `${name}.exe` : name;
  if (name === "mst") {
    const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
    const a = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
    if (!os || !a) return undefined;
    const ext = platform === "win32" ? "zip" : "tar.gz";
    return { asset: `mst-${tag}-${os}-${a}.${ext}`, exe };
  }
  // webclaw — Rust triples.
  const triple =
    platform === "win32" && arch === "x64" ? "x86_64-pc-windows-msvc"
    : platform === "darwin" && arch === "x64" ? "x86_64-apple-darwin"
    : platform === "darwin" && arch === "arm64" ? "aarch64-apple-darwin"
    : platform === "linux" && arch === "x64" ? "x86_64-unknown-linux-gnu"
    : platform === "linux" && arch === "arm64" ? "aarch64-unknown-linux-gnu"
    : undefined;
  if (!triple) return undefined;
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return { asset: `webclaw-${tag}-${triple}.${ext}`, exe };
}

/** The directory the binaries install into. */
export function binDir(): string {
  return process.env.ACTOR0_BIN_DIR ?? join(homedir(), ".local", "bin");
}

/** A binary already on PATH or in the bin dir, or undefined. */
export function resolveBin(name: ToolName): string | undefined {
  const override = process.env[name === "mst" ? "ACTOR0_MST_BIN" : "ACTOR0_WEBCLAW_BIN"];
  if (override) return override;
  const local = join(binDir(), assetSpec(name, process.platform, process.arch)?.exe ?? name);
  if (existsSync(local)) return local;
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (!found.error && found.status === 0 && found.stdout.trim()) return found.stdout.trim().split("\n")[0]!.trim();
  return undefined;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Ensure the binary is present, downloading + verifying + extracting it if not.
 *
 * The download is SHA256-checked against the release's checksum file before
 * anything is executed — an unverified binary is never run. Extraction shells
 * out to `tar` (bsdtar handles both .tar.gz and .zip on every platform we
 * support). Any failure is a clear message naming the tool and the cause.
 */
export async function ensureBin(name: ToolName): Promise<string> {
  const found = resolveBin(name);
  if (found) return found;
  const spec = assetSpec(name, process.platform, process.arch);
  if (!spec) {
    throw new Error(`web search: no ${name} build for ${process.platform}/${process.arch}. Install ${name} manually and put it on PATH.`);
  }
  const { repo, tag, sums } = TOOLS[name];
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), `actor0-${name}-`));
    const archive = await download(`${base}/${spec.asset}`);
    const sumsText = (await download(`${base}/${sums}`)).toString("utf8");
    const expected = expectedSum(sumsText, spec.asset);
    if (!expected) throw new Error(`no SHA256 for ${spec.asset} in ${sums}`);
    if (sha256(archive) !== expected) throw new Error(`SHA256 mismatch for ${spec.asset} — refusing to run an unverified binary`);
    const archivePath = join(scratch, spec.asset);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(archivePath, archive);
    const extract = spawnSync("tar", ["-xf", archivePath, "-C", scratch], { encoding: "utf8" });
    if (extract.error || extract.status !== 0) {
      throw new Error(`could not extract ${spec.asset} (is tar installed?): ${extract.error?.message ?? extract.stderr ?? ""}`);
    }
    const exePath = findBinary(scratch, spec.exe);
    if (!exePath) throw new Error(`${spec.exe} not found in ${spec.asset}`);
    mkdirSync(binDir(), { recursive: true });
    const dest = join(binDir(), spec.exe);
    renameSync(exePath, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
    return dest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`web search: could not install ${name} ${tag}: ${message}. Check your connection, or install ${name} manually and put it on PATH.`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The checksum line for `asset` in a SHA256SUMS file (`<hash>  <name>`). */
function expectedSum(sumsText: string, asset: string): string | undefined {
  for (const line of sumsText.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?\s*(.+?)\s*$/.exec(line.trim());
    if (match && match[2] === asset) return match[1]!.toLowerCase();
  }
  return undefined;
}

/** The extracted executable named `exe`, at most two levels down (a JS walk, so it needs no `find`). */
function findBinary(dir: string, exe: string): string | undefined {
  const walk = (d: string, depth: number): string | undefined => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isFile() && entry.name === exe) return full;
      if (entry.isDirectory() && depth < 2) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(dir, 0);
}

/** Parse `mst --format json` output into an envelope; tolerant of junk lines. */
export function parseSearchEnvelope(stdout: string): SearchEnvelope {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return { query: "", tookMs: 0, results: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return { query: "", tookMs: 0, results: [] };
  }
  const obj = raw as { query?: unknown; took_ms?: unknown; results?: unknown };
  const results = Array.isArray(obj.results) ? obj.results : [];
  return {
    query: typeof obj.query === "string" ? obj.query : "",
    tookMs: typeof obj.took_ms === "number" ? obj.took_ms : 0,
    results: results.map((r, i) => {
      const row = (r ?? {}) as Record<string, unknown>;
      return {
        rank: typeof row.rank === "number" ? row.rank : i + 1,
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        score: typeof row.score === "number" ? row.score : 0,
        engines: Array.isArray(row.engines) ? row.engines.filter((e): e is string => typeof e === "string") : [],
        ...(typeof row.snippet === "string" ? { snippet: row.snippet } : {}),
      };
    }),
  };
}

/** Render results for the model: numbered, with title, url, engines, snippet. */
export function formatWebResults(envelope: SearchEnvelope): string {
  if (envelope.results.length === 0) return `No web results for "${envelope.query}".`;
  const lines = envelope.results.map((r) => {
    const head = `${r.rank}. ${r.title || "(untitled)"}\n   ${r.url}`;
    const meta = r.engines.length > 0 ? `\n   [${r.engines.join(", ")}]` : "";
    const snip = r.snippet ? `\n   ${r.snippet}` : "";
    return `${head}${meta}${snip}`;
  });
  return `${envelope.results.length} result${envelope.results.length === 1 ? "" : "s"} for "${envelope.query}":\n\n${lines.join("\n\n")}`;
}

const SEARCH_TIMEOUT_MS = 60_000;

/** Run `mst` for a query and return the parsed envelope. */
export async function webSearch(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchEnvelope> {
  const bin = await ensureBin("mst");
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 10;
  const stdout = await run(bin, ["--format", "json", "--limit", String(limit), "--stdin"], query, options.signal, SEARCH_TIMEOUT_MS, "mst");
  return parseSearchEnvelope(stdout);
}

/** Fetch a URL with `webclaw` and return clean, LLM-ready markdown. */
export async function openUrl(url: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  const bin = await ensureBin("webclaw");
  const out = await run(bin, ["-f", "llm", url], undefined, options.signal, SEARCH_TIMEOUT_MS, "webclaw");
  return out.trim() || `(no content extracted from ${url})`;
}

/** Spawn a tool, optionally feeding stdin, capturing stdout, with timeout + abort. */
async function run(bin: string, args: string[], stdin: string | undefined, signal: AbortSignal | undefined, timeoutMs: number, label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error(`${label} cancelled`)));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish(() => reject(new Error(`could not run ${label}: ${error.message}`))));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${label} exited ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      });
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}
