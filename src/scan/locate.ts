import { CARD_ASPECT } from './parse';

/**
 * Find the card in a photo and straighten it.
 *
 * Works on a ~360 px copy: edge detection, a Hough transform restricted to near-vertical and
 * near-horizontal lines, then the pair of verticals and pair of horizontals that best form a
 * card-shaped rectangle whose sides are actually traced by edges. The four corners are mapped back
 * to full resolution and the card is perspective-corrected into an upright image.
 */

export type Point = [number, number];
export interface Quad {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
}

const WORK = 360;
const MAX_TILT = 14; // degrees either side of upright

interface Line {
  /** Normal angle in radians (0 = vertical line, π/2 = horizontal line). */
  theta: number;
  rho: number;
  votes: number;
}

interface Planes {
  /** Blurred R, G, B planes: edges are found on colour, not just brightness, because a silver
   *  border on a red mat can be nearly the same brightness. */
  ch: [Float32Array, Float32Array, Float32Array];
  w: number;
  h: number;
  scale: number;
}

function toPlanes(src: CanvasImageSource, sw: number, sh: number): Planes {
  const scale = WORK / Math.max(sw, sh);
  const w = Math.max(8, Math.round(sw * scale));
  const h = Math.max(8, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const ch = [0, 1, 2].map((k) => {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = d[i + k]!;
    // 3×3 box blur to tame foil sparkle and sensor noise. Border pixels keep their value so the
    // image's own edge doesn't read as a line.
    const b = Float32Array.from(g);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * w + x + dx]!;
        b[y * w + x] = s / 9;
      }
    return b;
  }) as [Float32Array, Float32Array, Float32Array];
  return { ch, w, h, scale };
}

interface Edges {
  /** 1 = edge of a near-vertical line, 2 = near-horizontal, 0 = none. */
  kind: Uint8Array;
  w: number;
  h: number;
}

function edges({ ch, w, h }: Planes): Edges {
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // The colour channel with the strongest gradient decides.
      let best = 0;
      let bgx = 0;
      let bgy = 0;
      for (const g of ch) {
        const gx = g[i - w + 1]! + 2 * g[i + 1]! + g[i + w + 1]! - g[i - w - 1]! - 2 * g[i - 1]! - g[i + w - 1]!;
        const gy = g[i + w - 1]! + 2 * g[i + w]! + g[i + w + 1]! - g[i - w - 1]! - 2 * g[i - w]! - g[i - w + 1]!;
        const m = gx * gx + gy * gy;
        if (m > best) {
          best = m;
          bgx = gx;
          bgy = gy;
        }
      }
      mag[i] = Math.sqrt(best);
      dir[i] = Math.abs(bgx) > 2 * Math.abs(bgy) ? 1 : Math.abs(bgy) > 2 * Math.abs(bgx) ? 2 : 0;
    }
  // Keep the strongest ~30% of gradients, thinned to their ridge (non-maximum suppression across
  // the edge), so a card's outline counts even against busy artwork, and texture doesn't pile up.
  const sorted = Float32Array.from(mag).sort();
  const thresh = Math.max(12, sorted[Math.floor(sorted.length * 0.7)]!);
  const kind = new Uint8Array(w * h);
  // Ignore a 3 px frame: photo edges and blur borders are not card edges.
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x++) {
      const i = y * w + x;
      const m = mag[i]!;
      if (m < thresh || !dir[i]) continue;
      const ridge = dir[i] === 1 ? m >= mag[i - 1]! && m >= mag[i + 1]! : m >= mag[i - w]! && m >= mag[i + w]!;
      if (ridge) kind[i] = dir[i]!;
    }
  return { kind, w, h };
}

function hough(e: Edges, family: 1 | 2): Line[] {
  const { kind, w, h } = e;
  const step = (0.5 * Math.PI) / 180;
  const tilt = (MAX_TILT * Math.PI) / 180;
  const base = family === 1 ? 0 : Math.PI / 2;
  const thetas: number[] = [];
  for (let t = -tilt; t <= tilt + 1e-9; t += step) thetas.push(base + t);
  const diag = Math.ceil(Math.hypot(w, h));
  const acc = new Uint32Array(thetas.length * (2 * diag + 1));
  const cos = thetas.map(Math.cos);
  const sin = thetas.map(Math.sin);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (kind[y * w + x] !== family) continue;
      for (let t = 0; t < thetas.length; t++) {
        const rho = Math.round(x * cos[t]! + y * sin[t]!);
        acc[t * (2 * diag + 1) + rho + diag]!++;
      }
    }
  // Peaks with non-maximum suppression.
  const lines: Line[] = [];
  const rows = 2 * diag + 1;
  const minVotes = (family === 1 ? h : w) * 0.12;
  for (let t = 0; t < thetas.length; t++)
    for (let r = 0; r < rows; r++) {
      const v = acc[t * rows + r]!;
      if (v < minVotes) continue;
      let peak = true;
      for (let dt = -3; dt <= 3 && peak; dt++)
        for (let dr = -5; dr <= 5; dr++) {
          const tt = t + dt;
          const rr = r + dr;
          if ((dt || dr) && tt >= 0 && tt < thetas.length && rr >= 0 && rr < rows && acc[tt * rows + rr]! > v) {
            peak = false;
            break;
          }
        }
      if (peak) lines.push({ theta: thetas[t]!, rho: r - diag, votes: v });
    }
  return lines.sort((a, b) => b.votes - a.votes).slice(0, 10);
}

function intersect(a: Line, b: Line): Point | null {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-6) return null;
  const x = (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det;
  const y = (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det;
  return [x, y];
}

/** Fraction of the segment p→q that lies on edge pixels of the right orientation. */
function coverage(e: Edges, p: Point, q: Point, family: 1 | 2): number {
  const n = Math.max(8, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1])));
  let hit = 0;
  for (let i = 0; i <= n; i++) {
    const x = Math.round(p[0] + ((q[0] - p[0]) * i) / n);
    const y = Math.round(p[1] + ((q[1] - p[1]) * i) / n);
    let found = false;
    for (let d = -2; d <= 2 && !found; d++) {
      const xx = family === 1 ? x + d : x;
      const yy = family === 2 ? y + d : y;
      if (xx >= 0 && yy >= 0 && xx < e.w && yy < e.h && e.kind[yy * e.w + xx] === family) found = true;
    }
    if (found) hit++;
  }
  return hit / (n + 1);
}

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Median colour of a thin strip just inside one side of the quad. A card's border is the same
 * colour on all four sides; a table edge or a sleeve below the card is not.
 */
function innerStrip(p: Planes, q: Quad, side: 0 | 1 | 2 | 3): [number, number, number] {
  const { tl, tr, br, bl } = q;
  // Points at fraction (u, v) of the quad, by bilinear interpolation of the corners.
  const at = (u: number, v: number): Point => [
    (1 - v) * ((1 - u) * tl[0] + u * tr[0]) + v * ((1 - u) * bl[0] + u * br[0]),
    (1 - v) * ((1 - u) * tl[1] + u * tr[1]) + v * ((1 - u) * bl[1] + u * br[1]),
  ];
  const samples: Array<[number, number, number]> = [];
  for (let t = 0.15; t <= 0.85; t += 0.05) {
    for (const depth of [0.01, 0.016]) {
      const [x, y] = side === 0 ? at(t, depth) : side === 1 ? at(1 - depth, t) : side === 2 ? at(t, 1 - depth) : at(depth, t);
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= p.w || yi >= p.h) continue;
      const i = yi * p.w + xi;
      samples.push([p.ch[0][i]!, p.ch[1][i]!, p.ch[2][i]!]);
    }
  }
  if (!samples.length) return [0, 0, 0];
  const med = (k: 0 | 1 | 2): number => samples.map((c) => c[k]).sort((a, b) => a - b)[samples.length >> 1]!;
  return [med(0), med(1), med(2)];
}

/** 0 when all four inner strips match, up to ~1 when one side is clearly something else. */
function borderMismatch(p: Planes, q: Quad): number {
  const cols = ([0, 1, 2, 3] as const).map((s) => innerStrip(p, q, s));
  const centre: [number, number, number] = [0, 1, 2].map((k) => cols.map((c) => c[k]!).sort((a, b) => a - b)[1]! / 2 + cols.map((c) => c[k]!).sort((a, b) => a - b)[2]! / 2) as [number, number, number];
  // Lighting varies across a hand-held card: small differences don't count.
  const worst = Math.max(...cols.map((c) => Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2])));
  return Math.max(0, worst - 45) / 150;
}

/** The card's corners in source pixels, or null when no convincing card outline is found. */
export function locateCard(src: CanvasImageSource, sw: number, sh: number, aspect = CARD_ASPECT): Quad | null {
  const planes = toPlanes(src, sw, sh);
  const { w, h, scale } = planes;
  const e = edges(planes);
  const vert = hough(e, 1);
  const horiz = hough(e, 2);
  let best: { quad: Quad; score: number } | null = null;
  // Sort by position so pairs are (left, right) and (top, bottom).
  const xAt = (l: Line): number => l.rho / Math.cos(l.theta); // x where the line crosses y = 0, roughly
  const yAt = (l: Line): number => l.rho / Math.sin(l.theta);
  for (let i = 0; i < vert.length; i++)
    for (let j = 0; j < vert.length; j++) {
      const L = vert[i]!;
      const R = vert[j]!;
      if (xAt(R) - xAt(L) < w * 0.25) continue;
      for (let k = 0; k < horiz.length; k++)
        for (let m = 0; m < horiz.length; m++) {
          const T = horiz[k]!;
          const B = horiz[m]!;
          if (yAt(B) - yAt(T) < h * 0.3) continue;
          const tl = intersect(L, T);
          const tr = intersect(R, T);
          const br = intersect(R, B);
          const bl = intersect(L, B);
          if (!tl || !tr || !br || !bl) continue;
          const width = (dist(tl, tr) + dist(bl, br)) / 2;
          const height = (dist(tl, bl) + dist(tr, br)) / 2;
          const a = width / height;
          if (Math.abs(a - aspect) > 0.09) continue;
          const area = (width * height) / (w * h);
          if (area < 0.12) continue;
          // Skip the rounded corners: measure the middle 80% of each side.
          const lerp = (p: Point, q: Point, t: number): Point => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
          const side = (p: Point, q: Point, fam: 1 | 2): number => coverage(e, lerp(p, q, 0.1), lerp(p, q, 0.9), fam);
          const covs = [side(tl, tr, 2), side(bl, br, 2), side(tl, bl, 1), side(tr, br, 1)];
          // A finger can hide part of one side, but every side must be traced somewhere.
          if (Math.min(...covs) < 0.3) continue;
          // The card's outline is the outermost card-shaped rectangle. Inner frames (art box,
          // text box, a full art's border) are often traced more crisply, so size dominates.
          const quad = { tl, tr, br, bl };
          const score = covs.reduce((s, c) => s + c, 0) / 4 + 3 * area - 2 * Math.abs(a - aspect) - 1.5 * borderMismatch(planes, quad);
          if (!best || score > best.score) best = { quad, score };
        }
    }
  if (!best || best.score < 0.8) return null;
  const up = (p: Point): Point => [p[0] / scale, p[1] / scale];
  return { tl: up(best.quad.tl), tr: up(best.quad.tr), br: up(best.quad.br), bl: up(best.quad.bl) };
}

/**
 * Grow the quad about its centre. Detection sometimes settles on a crisp inner frame a few percent
 * inside the real edge; a margin keeps the card's edge text (collector number, name) in view.
 */
export function expandQuad(q: Quad, mx: number, my: number): Quad {
  const cx = (q.tl[0] + q.tr[0] + q.br[0] + q.bl[0]) / 4;
  const cy = (q.tl[1] + q.tr[1] + q.br[1] + q.bl[1]) / 4;
  const grow = (p: Point): Point => [cx + (p[0] - cx) * (1 + 2 * mx), cy + (p[1] - cy) * (1 + 2 * my)];
  return { tl: grow(q.tl), tr: grow(q.tr), br: grow(q.br), bl: grow(q.bl) };
}

/** Homography mapping the unit square's corners to the quad (for inverse-mapping pixels). */
function squareToQuad(q: Quad): number[] {
  const [x0, y0] = q.tl;
  const [x1, y1] = q.tr;
  const [x2, y2] = q.br;
  const [x3, y3] = q.bl;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const hh = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}

/** Perspective-correct the quad into an upright `outW × outH` canvas. */
export function warpCard(src: CanvasImageSource, sw: number, sh: number, q: Quad, outW: number, outH: number): HTMLCanvasElement {
  // Read only the quad's bounding box from the source.
  const xs = [q.tl[0], q.tr[0], q.br[0], q.bl[0]];
  const ys = [q.tl[1], q.tr[1], q.br[1], q.bl[1]];
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - 1);
  const by = Math.max(0, Math.floor(Math.min(...ys)) - 1);
  const bw = Math.min(sw, Math.ceil(Math.max(...xs)) + 2) - bx;
  const bh = Math.min(sh, Math.ceil(Math.max(...ys)) + 2) - by;
  const tmp = document.createElement('canvas');
  tmp.width = bw;
  tmp.height = bh;
  const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
  tctx.drawImage(src, bx, by, bw, bh, 0, 0, bw, bh);
  const s = tctx.getImageData(0, 0, bw, bh).data;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(outW, outH);
  const o = img.data;
  const [a, b, c, d, e, f, g, h] = squareToQuad(q) as [number, number, number, number, number, number, number, number];
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW;
      const den = g * u + h * v + 1;
      const sx = (a * u + b * v + c) / den - bx - 0.5;
      const sy = (d * u + e * v + f) / den - by - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const oi = (y * outW + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= bw - 1 || y0 >= bh - 1) {
        o[oi + 3] = 255;
        continue;
      }
      const i00 = (y0 * bw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + bw * 4;
      const i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        o[oi + ch] = (s[i00 + ch]! * (1 - fx) + s[i10 + ch]! * fx) * (1 - fy) + (s[i01 + ch]! * (1 - fx) + s[i11 + ch]! * fx) * fy;
      }
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

