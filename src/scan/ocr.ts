import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import type { Region } from './parse';

let workerPromise: Promise<Worker> | null = null;
let progressFn: ((p: number, status: string) => void) | null = null;

/**
 * One shared Tesseract worker. The engine (~4 MB of WASM) and English model (~2 MB) download
 * from the jsDelivr CDN on first use and are cached by the browser after that.
 */
export function ocrWorker(): Promise<Worker> {
  workerPromise ??= createWorker('eng', OEM.LSTM_ONLY, {
    logger: (m) => progressFn?.(m.progress, m.status),
  });
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

export function onOcrProgress(fn: ((p: number, status: string) => void) | null): void {
  progressFn = fn;
}

/**
 * Cut a region out of the card image, scale it so small print is ~30 px tall, and binarise it
 * with a local (Bradley) threshold: a pixel is ink if it is clearly darker than its
 * neighbourhood. Tesseract's own global threshold fails on cards, where a mid-tone panel next to
 * a light border turns the whole panel black and swallows the text. `invert` reads light-on-dark
 * print (full-art and ex cards, Pendulum boxes).
 */
export function prepareRegion(card: HTMLCanvasElement, r: Region, invert = false): HTMLCanvasElement {
  const sx = Math.round(r.x * card.width);
  const sy = Math.round(r.y * card.height);
  const sw = Math.round(r.w * card.width);
  const sh = Math.round(r.h * card.height);
  // Equivalent to reading the card at ~2400 px tall.
  const scale = 2400 / card.height;
  const out = document.createElement('canvas');
  const w = (out.width = Math.round(sw * scale));
  const hgt = (out.height = Math.round(sh * scale));
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(card, sx, sy, sw, sh, 0, 0, w, hgt);

  const img = ctx.getImageData(0, 0, w, hgt);
  const d = img.data;
  const lum = new Float32Array(w * hgt);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
    const y = (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000;
    lum[j] = invert ? 255 - y : y;
  }
  // Integral image for O(1) window means.
  const integral = new Float64Array((w + 1) * (hgt + 1));
  for (let y = 1; y <= hgt; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += lum[(y - 1) * w + (x - 1)]!;
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x]! + row;
    }
  }
  const inkMap = new Uint8Array(w * hgt);
  const rad = 24; // about one glyph height at this scale
  const k = 0.16; // how much darker than the surroundings counts as ink
  for (let y = 0; y < hgt; y++) {
    const y0 = Math.max(0, y - rad);
    const y1 = Math.min(hgt, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(w, x + rad + 1);
      const sum = integral[y1 * (w + 1) + x1]! - integral[y0 * (w + 1) + x1]! - integral[y1 * (w + 1) + x0]! + integral[y0 * (w + 1) + x0]!;
      const mean = sum / ((x1 - x0) * (y1 - y0));
      inkMap[y * w + x] = lum[y * w + x]! < mean * (1 - k) ? 1 : 0;
    }
  }
  despeckle(inkMap, w, hgt);
  for (let i = 0; i < inkMap.length; i++) {
    const o = i * 4;
    d[o] = d[o + 1] = d[o + 2] = inkMap[i] ? 0 : 255;
    d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Drop ink blobs that can't be letters: specks from foil sparkle and sensor noise, and long
 * lines or large shapes (card borders, text-box frames, artwork) that confuse Tesseract's layout
 * analysis. Glyphs at this scale are roughly 25–90 px tall.
 */
function despeckle(ink: Uint8Array, w: number, h: number): void {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || label[start]) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    const members: number[] = [];
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (top) {
      const i = stack[--top]!;
      members.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && ink[i - 1] && !label[i - 1]) (label[i - 1] = next), (stack[top++] = i - 1);
      if (x < w - 1 && ink[i + 1] && !label[i + 1]) (label[i + 1] = next), (stack[top++] = i + 1);
      if (y > 0 && ink[i - w] && !label[i - w]) (label[i - w] = next), (stack[top++] = i - w);
      if (y < h - 1 && ink[i + w] && !label[i + w]) (label[i + w] = next), (stack[top++] = i + w);
    }
    next++;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const speck = members.length < 30 || (bw < 6 && bh < 6);
    const tooTall = bh > Math.max(110, h * 0.6);
    const rule = bw > w * 0.25 && bh < 14;
    const blob = members.length > 9000;
    if (speck || tooTall || rule || blob) for (const i of members) ink[i] = 0;
  }
}

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  /** The cleaned-up image Tesseract read, for a closer second look at single words. */
  image: HTMLCanvasElement;
}

export async function ocrRegion(card: HTMLCanvasElement, r: Region, invert = false): Promise<OcrResult> {
  const worker = await ocrWorker();
  await worker.setParameters({
    tessedit_pageseg_mode: r.key === 'name' ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT,
    tessedit_char_whitelist: '',
    user_defined_dpi: '300',
  });
  const image = prepareRegion(card, r, invert);
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
  const words: OcrWord[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) words.push({ text: w.text, bbox: w.bbox });
  return { text: data.text.trim(), words, image };
}

/**
 * Re-read one word on its own: cropped with some padding, enlarged, as a single line, and limited
 * to the characters it can contain. Small print in old fonts (thin, slanted "1"s) is read far more
 * reliably this way than inside a whole strip.
 */
export async function rereadWord(image: HTMLCanvasElement, word: OcrWord, whitelist: string): Promise<string> {
  const { x0, y0, x1, y1 } = word.bbox;
  const h = y1 - y0;
  // Widen generously: the first pass often splits "11/113" or drops a leading digit.
  const sx = Math.max(0, x0 - h * 2.5);
  const sy = Math.max(0, y0 - h * 0.4);
  const sw = Math.min(image.width, x1 + h * 2.5) - sx;
  const sh = Math.min(image.height, y1 + h * 0.4) - sy;
  if (sw < 4 || sh < 4) return '';
  const scale = Math.min(4, Math.max(1, 90 / h));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const worker = await ocrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: whitelist });
  try {
    const { data } = await worker.recognize(c);
    return data.text.trim();
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: '' });
  }
}

export async function ocrRegions(card: HTMLCanvasElement, regions: Region[]): Promise<Record<string, OcrResult>> {
  const out: Record<string, OcrResult> = {};
  // One worker, so these run in sequence anyway.
  for (const r of regions) out[r.key] = await ocrRegion(card, r);
  return out;
}
