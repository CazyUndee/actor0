/**
 * A POSIX tar.gz writer, from scratch, with explicit mode bits.
 *
 * Why not use `tar` from PATH: this script is run from `npm run package`, and
 * on Windows that means `cmd.exe`, where the `tar` on PATH is System32's
 * bsdtar — and libarchive on Windows derives a file's mode from the read-only
 * attribute, so every regular file lands in the archive as `0666`. Nobody
 * notices at archive time; the user on macOS or Linux extracts it and finds
 * that the launcher, the app binary and the bundled Node have no execute bit
 * and nothing runs. The permissively-mounted case (Git Bash's msys tar reports
 * `0755` for everything) makes it *look* correct in a check from one shell and
 * wrong in the archive another user downloads — the worst kind of green.
 *
 * So the modes are written here rather than read from the filesystem: they are
 * a property of the *package* (this file is a program, this one is content),
 * not of whatever NTFS reports. The rest of the format is plain ustar.
 *
 * The output is verified against an independent implementation in
 * package.test.mjs: `tar -tvf` (GNU tar in CI and Git Bash, bsdtar on a plain
 * Windows shell) must list exactly the modes this module was told to write.
 */

import {
  createReadStream,
  createWriteStream,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createGzip, gunzipSync } from "node:zlib";

const BLOCK = 512;

/** Octal field, NUL-padded: `<digits> + NUL` stops inside the width. */
function octal(value, length) {
  const digits = Math.floor(value).toString(8).padStart(length - 1, "0");
  if (digits.length > length - 1) throw new Error(`value ${value} does not fit in ${length} bytes`);
  return Buffer.from(`${digits}\0`, "utf8");
}

/**
 * Split a path into ustar's 155-byte prefix and 100-byte name.
 *
 * The split has to happen at a `/`, and trying every slash from the right
 * finds the placement that satisfies both limits if one exists. Refusing to
 * fabricate an over-long entry matters here: truncating silently produces an
 * archive that extracts into a different tree than the one that was built.
 */
function ustarSplit(path) {
  const nameBytes = (s) => Buffer.byteLength(s, "utf8");
  if (nameBytes(path) <= 100) return { prefix: "", name: path };
  for (let cut = path.length - 1; cut > 0; cut -= 1) {
    if (path[cut] !== "/") continue;
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (nameBytes(prefix) <= 155 && nameBytes(name) <= 100) return { prefix, name };
  }
  throw new Error(`path does not fit a ustar header (${path.length} bytes): ${path}`);
}

/** The 512-byte ustar header for one entry. */
function header(entry) {
  const { name, prefix } = ustarSplit(entry.name);
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, 100, "utf8");
  octal(entry.mode, 8).copy(buf, 100);
  octal(entry.uid ?? 0, 8).copy(buf, 108);
  octal(entry.gid ?? 0, 8).copy(buf, 116);
  octal(entry.size ?? 0, 12).copy(buf, 124);
  // ustar stores seconds since the epoch; a Date here would otherwise be
  // written as its millisecond value, which overflows the 12-byte field.
  const mtime = entry.mtime instanceof Date ? Math.floor(entry.mtime.getTime() / 1000) : (entry.mtime ?? 0);
  octal(mtime, 12).copy(buf, 136);
  buf.write("        ", 148, 8, "utf8"); // checksum placeholder: eight spaces
  buf.write(entry.type, 156, 1, "utf8");
  if (prefix) buf.write(prefix, 345, 155, "utf8");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write(entry.user ?? "root", 265, 32, "utf8");
  buf.write(entry.group ?? "root", 297, 32, "utf8");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return buf;
}

function walk(dir, base, out) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(base, abs).split(sep).join("/");
    if (entry.isDirectory()) {
      out.push({ name: `${rel}/`, type: "5", mode: 0o755, size: 0, mtime: statSync(abs).mtime, abs });
      walk(abs, base, out);
    } else if (entry.isFile()) {
      out.push({
        rel,
        name: rel,
        type: "0",
        mode: 0o644,
        size: statSync(abs).size,
        mtime: statSync(abs).mtime,
        abs,
      });
    }
  }
}

/**
 * Pack `srcDir` into `outFile` as a gzip'd ustar archive.
 *
 * `executable(relPath)` decides the mode of each regular file; directories are
 * always 0755 because a directory without its execute bit cannot be entered at
 * all, whatever the archive says. `prefix` puts the whole tree under one
 * top-level directory, which a user extracting a tarball expects and which
 * cannot be added afterwards without rewriting the archive.
 */
export async function createTarGz(srcDir, outFile, { executable = () => false, mtime, prefix = "", level = 9 } = {}) {
  const root = prefix.replace(/\/+$/, "");
  const entries = [];
  walk(srcDir, srcDir, entries);
  for (const entry of entries) {
    if (entry.type !== "0") continue;
    entry.mode = executable(entry.rel) ? 0o755 : 0o644;
  }

  const gzip = createGzip({ level });
  const out = createWriteStream(outFile);
  gzip.pipe(out);
  let fatal;
  const write = async (buf) => {
    if (!gzip.write(buf)) await Promise.race([once(gzip, "drain"), failed]);
    if (fatal) throw fatal;
  };
  // Rejected through an immediately-attached handler: an error that no one is
  // currently racing must not surface as an unhandled rejection three awaits
  // later, which would take the whole packaging run down for a reason none of
  // its messages names.
  const failed = new Promise((_resolve, reject) => {
    gzip.on("error", reject);
    out.on("error", reject);
  }).catch((error) => {
    fatal = error;
  });

  try {
    for (const entry of entries) {
      const name = root ? `${root}/${entry.name}` : entry.name;
      await write(header({ ...entry, name, mtime: mtime ?? entry.mtime }));
      if (entry.type !== "0") continue;
      const padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
      let written = 0;
      for await (const chunk of createReadStream(entry.abs)) {
        written += chunk.length;
        await write(chunk);
      }
      if (written !== entry.size) {
        // The size in the header and the bytes in the stream came from two
        // reads of the same file; a staging tree that changed underneath the
        // archive is a corrupt archive with no error to show for it.
        throw new Error(`${entry.name}: size changed while archiving (${entry.size} -> ${written})`);
      }
      if (padding) await write(Buffer.alloc(padding, 0));
    }
    await write(Buffer.alloc(BLOCK * 2, 0));
    gzip.end();
    await Promise.race([once(out, "finish"), failed]);
    if (fatal) throw fatal;
  } catch (error) {
    gzip.destroy();
    out.destroy();
    throw error;
  } finally {
    gzip.destroy();
  }
  return outFile;
}

/** Which paths in a staged tree are programs (mode 0755) rather than content. */
export function makeExecutablePredicate(binaryName, { entryName = "actor0" } = {}) {
  return (rel) => {
    const parts = rel.split("/");
    const base = parts[parts.length - 1];
    if (parts.includes("runtime")) return base === "node" || base === "node.exe";
    if (rel.endsWith(".sh") || rel.endsWith(".command")) return true;
    if (base === entryName || base === binaryName) return true;
    return false;
  };
}
/** NUL-terminated ASCII field, as ustar writes names and numbers. */
function field(block, offset, length) {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.toString("utf8", 0, end === -1 ? slice.length : end);
}

/** The `path` record of a PAX extended header, if it carries one. */
function paxPath(data) {
  let path;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.toString("ascii", offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/**
 * Read a gzip'd tar, writing only the entries `only(relPath)` accepts.
 *
 * Used to pull `bin/node` out of a 50MB Node distribution without unpacking
 * the other 4,000 files. GNU tar is not assumed: the packaging script runs on
 * Windows, where the tar on PATH is bsdtar, and a cross-built Linux tarball
 * would otherwise depend on whatever libarchive printed that day.
 *
 * The path guard is not theoretical: an archive is input from the network, and
 * `../../.ssh/authorized_keys` in a member name must never be written outside
 * `destDir`.
 */
export function extractTarGz(archive, destDir, { only = () => true } = {}) {
  const tar = gunzipSync(readFileSync(archive));
  const root = resolve(destDir);
  mkdirSync(root, { recursive: true });
  const written = [];
  let offset = 0;
  let pendingName;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const name = field(block, 0, 100);
    const prefix = field(block, 345, 155);
    const size = Number.parseInt(field(block, 124, 12).trim() || "0", 8);
    const mode = Number.parseInt(field(block, 100, 8).trim() || "644", 8);
    const type = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
    const full = pendingName ?? (prefix ? `${prefix}/${name}` : name);
    pendingName = undefined;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (!Number.isFinite(size) || dataEnd > tar.length) {
      throw new Error(`${archive}: truncated tar entry ${full}`);
    }
    if (type === "x" || type === "g") {
      const extended = paxPath(tar.subarray(dataStart, dataEnd));
      if (extended) pendingName = extended;
    } else if (type === "L") {
      pendingName = field(tar.subarray(dataStart, dataEnd), 0, size);
    } else {
      const target = resolve(root, full);
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error(`${archive}: refusing to extract ${full} outside ${root}`);
      }
      if (type === "5") {
        if (only(full.replace(/\/$/, ""))) mkdirSync(target, { recursive: true });
      } else if ((type === "0" || type === "7") && only(full)) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, tar.subarray(dataStart, dataEnd), { mode: mode & 0o777 });
        // writeFileSync's mode is filtered through the umask and ignored on
        // Windows; the archive states the mode, so the extracted file does too.
        chmodSync(target, mode & 0o777);
        written.push(full);
      }
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return written;
}

