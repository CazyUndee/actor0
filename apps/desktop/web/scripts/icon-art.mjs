/**
 * The mascot icon, drawn and encoded in pure Node.
 *
 * Why this exists: the packaging build has to run on macOS and Linux too,
 * and the original generator shelled out to PowerShell's System.Drawing.
 * That is present on every Windows box and on none of the others, so the
 * first `npm run package` on a mac runner would have shipped a package with
 * no window icon, and the Windows .ico step would have thrown before the
 * archive was written.
 *
 * The shapes are the ones the PowerShell version drew, in 64-unit tile
 * coordinates, and still mirror faceShapes() in src/mascot.ts: a rounded
 * tile, a hairline stroke, and three rounded bars (two mid dashes and the low
 * mouth of -_-). Drawing each size from the geometry rather than scaling a
 * 256px bitmap is what keeps 16px legible - the reason the original went to
 * the trouble of drawing instead of downscaling.
 *
 * The rasterizer is a 4x4 supersample of a signed-distance field. That is
 * enough for an icon (16 coverage levels; the shapes are axis-aligned), and it
 * needs no native image library, which would have been a prebuilt binary per
 * platform - the exact dependency the packaging is trying to avoid.
 */
import { deflateSync } from "node:zlib";

const TILE = 64;
const BG = [26, 26, 26];
const STROKE = [125, 124, 121];
const STROKE_ALPHA = 128 / 255;
const ACCENT = [232, 144, 144];

/** The face, in tile units: left dash, low dash, right dash (w=14, h=6). */
const BARS = [
  { x: 9, y: 26, w: 14, h: 6 },
  { x: 25, y: 42, w: 14, h: 6 },
  { x: 41, y: 26, w: 14, h: 6 },
];

/** Signed distance from (px,py) to a rounded box; negative inside. */
function sdRoundBox(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const bx = (x1 - x0) / 2;
  const by = (y1 - y0) / 2;
  const qx = Math.abs(px - cx) - bx + r;
  const qy = Math.abs(py - cy) - by + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
}

/** Source-over in premultiplied space, which is what averaging samples needs. */
function over(state, rgb, alpha) {
  state.r = (rgb[0] / 255) * alpha + state.r * (1 - alpha);
  state.g = (rgb[1] / 255) * alpha + state.g * (1 - alpha);
  state.b = (rgb[2] / 255) * alpha + state.b * (1 - alpha);
  state.a = alpha + state.a * (1 - alpha);
}

/** One size, as straight (non-premultiplied) RGBA bytes. */
export function renderIcon(size) {
  if (!Number.isInteger(size) || size < 1) throw new Error("bad icon size " + size);
  const scale = size / TILE;
  const samples = 4;
  const perPixel = samples * samples;
  const data = Buffer.alloc(size * size * 4);
  // The tile sits half a unit inside the canvas, matching the original's
  // rectangle(0, 0, size-1, size-1): without that the stroke is clipped
  // asymmetrically and the mark reads as one pixel off-centre at 16px.
  const inset = 0.5;
  const tile = { x0: inset, y0: inset, x1: TILE - inset, y1: TILE - inset, r: 14 };
  const strokeHalf = 1.5;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const acc = { r: 0, g: 0, b: 0, a: 0 };
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / scale;
          const y = (py + (sy + 0.5) / samples) / scale;
          const state = { r: 0, g: 0, b: 0, a: 0 };
          const dTile = sdRoundBox(x, y, tile.x0, tile.y0, tile.x1, tile.y1, tile.r);
          if (dTile <= 0) over(state, BG, 1);
          if (Math.abs(dTile) <= strokeHalf) over(state, STROKE, STROKE_ALPHA);
          for (const bar of BARS) {
            const d = sdRoundBox(x, y, bar.x, bar.y, bar.x + bar.w, bar.y + bar.h, bar.h / 2);
            if (d <= 0) over(state, ACCENT, 1);
          }
          acc.r += state.r;
          acc.g += state.g;
          acc.b += state.b;
          acc.a += state.a;
        }
      }
      const i = (py * size + px) * 4;
      const alpha = acc.a / perPixel;
      if (alpha > 0) {
        data[i] = Math.round((acc.r / acc.a) * 255);
        data[i + 1] = Math.round((acc.g / acc.a) * 255);
        data[i + 2] = Math.round((acc.b / acc.a) * 255);
        data[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return { width: size, height: size, data };
}

// --- PNG ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** 8-bit RGBA PNG. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  if (rgba.length !== stride * height) throw new Error("RGBA buffer does not match the dimensions");
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG bytes for one rendered size. */
export function pngFor(size) {
  const icon = renderIcon(size);
  return encodePng(icon.width, icon.height, icon.data);
}

// --- ICO ------------------------------------------------------------------

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Multi-image .ico with PNG-compressed entries (Vista+).
 *
 * The sizes are drawn, not downscaled: a 16px nearest-neighbour of the 256px
 * mark aliases the stroke away, and that is the icon Explorer actually uses in
 * its list view.
 */
export function encodeIco() {
  const images = ICO_SIZES.map((size) => ({ size, png: pngFor(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

// --- ICNS -----------------------------------------------------------------

/**
 * The macOS icon container.
 *
 * ICNS entries are (type, length, PNG) and Finder accepts PNG payloads for
 * every modern type, so no proprietary encoder is needed. Only the sizes the
 * icon is drawn at are included: Finder scales the rest, and inventing a
 * 512/1024 entry by upscaling a 256 would just make the dock icon soft.
 */
const ICNS_TYPES = [
  { type: "icp4", size: 16 },
  { type: "icp5", size: 32 },
  { type: "icp6", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic11", size: 32 },
  { type: "ic12", size: 64 },
  { type: "ic13", size: 256 },
];

export function encodeIcns() {
  const pngs = new Map();
  const entries = [];
  for (const { type, size } of ICNS_TYPES) {
    if (!pngs.has(size)) pngs.set(size, pngFor(size));
    const png = pngs.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    entries.push(Buffer.concat([header, png]));
  }
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

export const ICO_SIZES_EXPORTED = ICO_SIZES;
