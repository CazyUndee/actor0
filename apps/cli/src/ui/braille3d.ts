/**
 * A tiny 3D → braille renderer for the empty-transcript mascot.
 *
 * Each terminal cell is a 2×4 dot matrix (U+2800 block), so a W×H grid of
 * cells gives 2W × 4H dots. Points are rotated around Y (and a touch of X),
 * projected with a simple perspective, and lines are rasterised with Bresenham.
 */

// Braille dot bit positions: (x in 0..1, y in 0..3) -> bit
const DOT_BIT: number[][] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export type BrailleCanvas = {
  cellsW: number;
  cellsH: number;
  dots: Uint8Array; // length cellsW * cellsH, each 0..255
};

export function makeCanvas(cellsW: number, cellsH: number): BrailleCanvas {
  return { cellsW, cellsH, dots: new Uint8Array(cellsW * cellsH) };
}

export function setDot(c: BrailleCanvas, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= c.cellsW * 2 || y >= c.cellsH * 4) return;
  const cx = Math.floor(x / 2);
  const cy = Math.floor(y / 4);
  const dx = x % 2;
  const dy = y % 4;
  c.dots[cy * c.cellsW + cx] |= DOT_BIT[dy]![dx]!;
}

export function drawLine(c: BrailleCanvas, x0: number, y0: number, x1: number, y1: number): void {
  let x = Math.round(x0), y = Math.round(y0);
  const ex = Math.round(x1), ey = Math.round(y1);
  const dx = Math.abs(ex - x), dy = Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx - dy;
  while (true) {
    setDot(c, x, y);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

export function canvasToLines(c: BrailleCanvas): string[] {
  const out: string[] = [];
  for (let y = 0; y < c.cellsH; y++) {
    let row = "";
    for (let x = 0; x < c.cellsW; x++) {
      row += String.fromCharCode(0x2800 + c.dots[y * c.cellsW + x]!);
    }
    out.push(row);
  }
  return out;
}

// --- 3D helpers ---

type V3 = { x: number; y: number; z: number };

function rotY(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}
function rotX(p: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

function project(p: V3, cx: number, cy: number, scale: number): { x: number; y: number } {
  // Perspective: closer (negative z) is bigger.
  const z = p.z + 6;
  const f = 6 / Math.max(0.5, z);
  return { x: cx + p.x * scale * f, y: cy + p.y * scale * f };
}

// Box: 8 corners of a unit cube centered at origin.
const BOX: V3[] = [
  { x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 },
  { x: 1, y: 1, z: -1 }, { x: -1, y: 1, z: -1 },
  { x: -1, y: -1, z: 1 }, { x: 1, y: -1, z: 1 },
  { x: 1, y: 1, z: 1 }, { x: -1, y: 1, z: 1 },
];
const BOX_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

// Eyes: two points floating inside the box (z = 0 plane, slightly forward).
const EYES: V3[] = [
  { x: -0.35, y: 0.15, z: 0.6 },
  { x: 0.35, y: 0.15, z: 0.6 },
];
// Mouth: a small arc of points.
const MOUTH: V3[] = [];
for (let i = 0; i <= 6; i++) {
  const t = (i / 6) * Math.PI - Math.PI / 2;
  MOUTH.push({ x: Math.cos(t) * 0.4, y: -0.25, z: 0.6 });
}

export function renderMascot3D(cellsW: number, cellsH: number, frame: number): string[] {
  const canvas = makeCanvas(cellsW, cellsH);
  const cx = (cellsW * 2) / 2;
  const cy = (cellsH * 4) / 2;
  const scale = Math.min(cellsW, cellsH) * 1.6;
  const angle = frame * 0.04;
  const tilt = 0.35;

  const transform = (p: V3): { x: number; y: number } => {
    let q = rotY(p, angle);
    q = rotX(q, tilt);
    return project(q, cx, cy, scale);
  };

  // Draw box edges.
  for (const [a, b] of BOX_EDGES) {
    const pa = transform(BOX[a]!);
    const pb = transform(BOX[b]!);
    drawLine(canvas, pa.x, pa.y, pb.x, pb.y);
  }
  // Draw eyes as small crosses.
  for (const e of EYES) {
    const p = transform(e);
    setDot(canvas, Math.round(p.x), Math.round(p.y));
    setDot(canvas, Math.round(p.x) + 1, Math.round(p.y));
    setDot(canvas, Math.round(p.x), Math.round(p.y) + 1);
    setDot(canvas, Math.round(p.x) - 1, Math.round(p.y));
    setDot(canvas, Math.round(p.x), Math.round(p.y) - 1);
  }
  // Draw mouth.
  for (let i = 0; i < MOUTH.length - 1; i++) {
    const pa = transform(MOUTH[i]!);
    const pb = transform(MOUTH[i + 1]!);
    drawLine(canvas, pa.x, pa.y, pb.x, pb.y);
  }

  return canvasToLines(canvas);
}
