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
      const ink = lum[y * w + x]! < mean * (1 - k);
      const o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = ink ? 0 : 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

export async function ocrRegion(card: HTMLCanvasElement, r: Region, invert = false): Promise<string> {
  const worker = await ocrWorker();
  await worker.setParameters({
    tessedit_pageseg_mode: r.key === 'name' ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT,
    user_defined_dpi: '300',
  });
  const { data } = await worker.recognize(prepareRegion(card, r, invert));
  return data.text.trim();
}

export async function ocrRegions(card: HTMLCanvasElement, regions: Region[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // One worker, so these run in sequence anyway.
  for (const r of regions) out[r.key] = await ocrRegion(card, r);
  return out;
}
