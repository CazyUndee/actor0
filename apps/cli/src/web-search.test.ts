import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetSpec,
  formatWebResults,
  openUrl,
  parseSearchEnvelope,
  resolveBin,
  webSearch,
} from "./web-search.js";

/**
 * The web-search layer. The pure parts (asset mapping, envelope parsing,
 * formatting, binary resolution) run everywhere; the spawn integration runs a
 * fake binary, which is only directly spawnable on POSIX, so those two are
 * skipped on Windows.
 */

const posix = process.platform === "win32" ? test.skip : test;

const sample = JSON.stringify({
  query: "rust async",
  took_ms: 6109,
  results: [
    { rank: 1, title: "Tokio vs async-std", url: "https://a.com/x", score: 0.0331, engines: ["brave", "ddg"], snippet: "a comparison" },
    { rank: 2, title: "async-std", url: "https://b.com/y", score: 0.02, engines: ["ddg"] },
  ],
});

// --- asset mapping --------------------------------------------------------

test("assetSpec maps each platform to the right mst archive", () => {
  assert.equal(assetSpec("mst", "linux", "x64")?.asset, "mst-v0.3.2-linux-amd64.tar.gz");
  assert.equal(assetSpec("mst", "linux", "arm64")?.asset, "mst-v0.3.2-linux-arm64.tar.gz");
  assert.equal(assetSpec("mst", "darwin", "arm64")?.asset, "mst-v0.3.2-darwin-arm64.tar.gz");
  assert.equal(assetSpec("mst", "win32", "x64")?.asset, "mst-v0.3.2-windows-amd64.zip");
  assert.equal(assetSpec("mst", "win32", "x64")?.exe, "mst.exe");
  assert.equal(assetSpec("mst", "linux", "x64")?.exe, "mst");
});

test("assetSpec maps each platform to the right webclaw archive (Rust triples)", () => {
  assert.equal(assetSpec("webclaw", "linux", "x64")?.asset, "webclaw-v0.6.14-x86_64-unknown-linux-gnu.tar.gz");
  assert.equal(assetSpec("webclaw", "darwin", "arm64")?.asset, "webclaw-v0.6.14-aarch64-apple-darwin.tar.gz");
  assert.equal(assetSpec("webclaw", "win32", "x64")?.asset, "webclaw-v0.6.14-x86_64-pc-windows-msvc.zip");
});

test("assetSpec returns undefined for an unsupported platform rather than guessing", () => {
  assert.equal(assetSpec("mst", "freebsd" as NodeJS.Platform, "x64"), undefined);
  assert.equal(assetSpec("webclaw", "linux", "mips"), undefined);
});

// --- parsing --------------------------------------------------------------

test("parseSearchEnvelope parses the mst JSON envelope", () => {
  const env = parseSearchEnvelope(sample);
  assert.equal(env.query, "rust async");
  assert.equal(env.tookMs, 6109);
  assert.equal(env.results.length, 2);
  assert.equal(env.results[0]!.url, "https://a.com/x");
  assert.deepEqual(env.results[0]!.engines, ["brave", "ddg"]);
  assert.equal(env.results[0]!.snippet, "a comparison");
});

test("parseSearchEnvelope is tolerant of junk and missing fields", () => {
  assert.deepEqual(parseSearchEnvelope("not json at all"), { query: "", tookMs: 0, results: [] });
  const partial = parseSearchEnvelope('garbage\n{"query":"q","results":[{"url":"u"}]}\nmore');
  assert.equal(partial.query, "q");
  assert.equal(partial.results[0]!.url, "u");
  assert.equal(partial.results[0]!.rank, 1, "rank defaults to position");
  assert.deepEqual(partial.results[0]!.engines, []);
});

// --- formatting -----------------------------------------------------------

test("formatWebResults renders numbered results, or says none", () => {
  const text = formatWebResults(parseSearchEnvelope(sample));
  assert.match(text, /2 results for "rust async"/);
  assert.match(text, /1\. Tokio vs async-std/);
  assert.match(text, /https:\/\/a\.com\/x/);
  assert.match(text, /\[brave, ddg\]/);
  assert.match(formatWebResults({ query: "q", tookMs: 0, results: [] }), /No web results/);
});

// --- resolution -----------------------------------------------------------

test("resolveBin honours the env override, then the bin dir, else undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-ws-"));
  const prevBin = process.env.ACTOR0_BIN_DIR;
  const prevMst = process.env.ACTOR0_MST_BIN;
  try {
    process.env.ACTOR0_MST_BIN = "/custom/mst";
    assert.equal(resolveBin("mst"), "/custom/mst", "the override wins");
    delete process.env.ACTOR0_MST_BIN;
    process.env.ACTOR0_BIN_DIR = dir;
    assert.equal(resolveBin("mst"), undefined, "absent before it is written");
    // Write the platform-appropriate executable name.
    writeFileSync(join(dir, process.platform === "win32" ? "mst.exe" : "mst"), "x");
    assert.equal(resolveBin("mst"), join(dir, process.platform === "win32" ? "mst.exe" : "mst"));
  } finally {
    if (prevBin === undefined) delete process.env.ACTOR0_BIN_DIR; else process.env.ACTOR0_BIN_DIR = prevBin;
    if (prevMst === undefined) delete process.env.ACTOR0_MST_BIN; else process.env.ACTOR0_MST_BIN = prevMst;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- spawn integration (POSIX only) ---------------------------------------

const withFake = async (name: "mst" | "webclaw", body: string, run: () => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-ws-"));
  const fake = join(dir, name);
  writeFileSync(fake, `#!/bin/sh\n${body}\n`);
  chmodSync(fake, 0o755);
  const key = name === "mst" ? "ACTOR0_MST_BIN" : "ACTOR0_WEBCLAW_BIN";
  const prev = process.env[key];
  try {
    process.env[key] = fake;
    await run();
  } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

posix("webSearch runs mst and parses its JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "actor0-ws-"));
  const json = join(dir, "out.json");
  writeFileSync(json, sample);
  await withFake("mst", `cat ${json}`, async () => {
    const env = await webSearch("rust async", { limit: 5 });
    assert.equal(env.query, "rust async");
    assert.equal(env.results.length, 2);
  });
  rmSync(dir, { recursive: true, force: true });
});

posix("openUrl runs webclaw and returns its markdown", async () => {
  await withFake("webclaw", `printf '%s\\n' '# Page' 'content here'`, async () => {
    const md = await openUrl("https://example.com");
    assert.match(md, /# Page/);
    assert.match(md, /content here/);
  });
});
