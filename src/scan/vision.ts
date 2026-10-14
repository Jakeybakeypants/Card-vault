import type { GameId } from '../types';
import { CARD_MARGIN } from './camera';
import type { Region } from './parse';

/**
 * Pixel-level checks on the captured card: glare over the text, reverse-holo shimmer, and how
 * alike the photo is to a catalog picture. All work on small downscaled copies, so they cost a
 * few milliseconds.
 */

function sample(src: CanvasImageSource, sw: number, sh: number, sx: number, sy: number, w: number, h: number): ImageData {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** The card itself within the canvas: detected cards carry a margin of background around them. */
function cardBox(card: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
  if (card.dataset.margin !== 'yes') return { x: 0, y: 0, w: card.width, h: card.height };
  const fx = CARD_MARGIN.x / (1 + 2 * CARD_MARGIN.x);
  const fy = CARD_MARGIN.y / (1 + 2 * CARD_MARGIN.y);
  return { x: card.width * fx, y: card.height * fy, w: card.width * (1 - 2 * fx), h: card.height * (1 - 2 * fy) };
}

function regionData(card: HTMLCanvasElement, r: Region, w: number): ImageData {
  const b = cardBox(card);
  const sw = r.w * b.w;
  const sh = r.h * b.h;
  return sample(card, sw, sh, b.x + r.x * b.w, b.y + r.y * b.h, w, Math.max(1, Math.round((w * sh) / sw)));
}

// ---------------------------------------------------------------------------------------------
// Glare

/**
 * Fraction of the region that is blown out: near-white and colourless, the way a light
 * reflection looks on foil or sleeves. Card stock that is genuinely white is rarely above 250.
 */
export function glareFraction(card: HTMLCanvasElement, r: Region): number {
  const d = regionData(card, r, 240).data;
  let blown = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i]!, d[i + 1]!, d[i + 2]!);
    const mn = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
    if (mn > 238 && mx - mn < 18) blown++;
  }
  return blown / (d.length / 4);
}

export function hasGlare(card: HTMLCanvasElement, regions: Region[]): boolean {
  return regions.some((r) => r.key !== 'name' && glareFraction(card, r) > 0.06);
}

// ---------------------------------------------------------------------------------------------
// Reverse-holo shimmer

/**
 * The plain panel below the artwork (attacks on Pokémon, the effect box on Yu-Gi-Oh!). On a
 * normal card it is flat colour plus dark text; on a reverse holo it is covered in foil that
 * breaks up into a speckle of colours.
 */
const BODY: Record<GameId, Region> = {
  pokemon: { key: 'body', x: 0.08, y: 0.58, w: 0.84, h: 0.24 },
  yugioh: { key: 'body', x: 0.1, y: 0.79, w: 0.8, h: 0.1 },
  mtg: { key: 'body', x: 0.1, y: 0.64, w: 0.8, h: 0.22 },
  lorcana: { key: 'body', x: 0.1, y: 0.7, w: 0.8, h: 0.16 },
};

/**
 * 0–1 shimmer: how much neighbouring non-text pixels differ in colour. Flat print scores near 0;
 * foil speckle scores high. Text is skipped (dark pixels) and so is glare (blown pixels).
 */
export function shimmer(card: HTMLCanvasElement, game: GameId): number {
  const img = regionData(card, BODY[game], 160);
  const { data: d, width: w, height: h } = img;
  const chroma = (i: number): [number, number] => {
    // Opponent colour axes: red–green and yellow–blue, independent of brightness.
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    return [r - g, (r + g) / 2 - b];
  };
  const usable = (i: number): boolean => {
    const mx = Math.max(d[i]!, d[i + 1]!, d[i + 2]!);
    const mn = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
    return mx > 90 && !(mn > 238 && mx - mn < 18);
  };
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const right = i + 4;
      const down = i + w * 4;
      if (!usable(i) || !usable(right) || !usable(down)) continue;
      const [a0, b0] = chroma(i);
      const [a1, b1] = chroma(right);
      const [a2, b2] = chroma(down);
      sum += Math.hypot(a1 - a0, b1 - b0) + Math.hypot(a2 - a0, b2 - b0);
      n += 2;
    }
  }
  if (n < 200) return 0;
  // ~6 is sensor noise on flat print; foil speckle runs 20+.
  return Math.max(0, Math.min(1, (sum / n - 6) / 18));
}

// The cut-off between "normal" and "reverse holo" shimmer, learned from the finishes the user
// confirms, since phones and lighting differ. Starts at a conservative guess.
const CAL_KEY = 'card-vault:foil-calibration';
interface Calibration {
  plain: number[];
  foil: number[];
}

function loadCalibration(): Calibration {
  try {
    const c = JSON.parse(localStorage.getItem(CAL_KEY) ?? '') as Calibration;
    if (Array.isArray(c.plain) && Array.isArray(c.foil)) return c;
  } catch {
    // fall through
  }
  return { plain: [], foil: [] };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Remember the shimmer a confirmed finish had, keeping the last 25 of each. */
export function learnFinish(value: number, isReverse: boolean): void {
  const c = loadCalibration();
  (isReverse ? c.foil : c.plain).push(value);
  c.plain = c.plain.slice(-25);
  c.foil = c.foil.slice(-25);
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify(c));
  } catch {
    // Not persisted; fine.
  }
}

/**
 * Probability the card is a reverse holo, from its shimmer. Before the user has confirmed a few
 * cards each way, only very clear readings are trusted.
 */
export function reverseProbability(value: number): number {
  const c = loadCalibration();
  // Starting point measured on test cards through a simulated phone camera: plain print ~0.02,
  // reverse-holo speckle ~0.35. Real cards and lighting vary, hence the calibration below.
  let cut = 0.18;
  let spread = 0.12;
  if (c.plain.length >= 3 && c.foil.length >= 3) {
    const lo = median(c.plain);
    const hi = median(c.foil);
    if (hi > lo) {
      cut = (lo + hi) / 2;
      spread = Math.max(0.05, (hi - lo) / 3);
    }
  }
  return 1 / (1 + Math.exp(-(value - cut) / (spread / 2.2)));
}

// ---------------------------------------------------------------------------------------------
// Picture comparison

const THUMB_W = 24;
const THUMB_H = 34;

/** The parts of the card that differ between printings: mostly the artwork. */
const ART: Record<GameId, Region> = {
  pokemon: { key: 'art', x: 0.08, y: 0.1, w: 0.84, h: 0.42 },
  yugioh: { key: 'art', x: 0.12, y: 0.18, w: 0.76, h: 0.52 },
  mtg: { key: 'art', x: 0.08, y: 0.11, w: 0.84, h: 0.45 },
  lorcana: { key: 'art', x: 0.05, y: 0.04, w: 0.9, h: 0.44 },
};

interface Fingerprint {
  whole: Float32Array;
  art: Float32Array;
}

function features(img: ImageData): Float32Array {
  // Luma plus the two opponent-colour channels, each mean/variance normalised later.
  const d = img.data;
  const out = new Float32Array((d.length / 4) * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    out[j] = 0.299 * r + 0.587 * g + 0.114 * b;
    out[j + 1] = (r - g) * 0.5;
    out[j + 2] = ((r + g) / 2 - b) * 0.5;
  }
  return out;
}

// Fixed sizes so a photo and a catalog scan always give vectors of the same length, even when
// their aspect ratios differ slightly (Yu-Gi-Oh! cards are a touch narrower).
const ART_H = 18;

function fingerprint(src: CanvasImageSource, box: { x: number; y: number; w: number; h: number }, game: GameId): Fingerprint {
  const a = ART[game];
  const { x, y, w, h } = box;
  return {
    whole: features(sample(src, w, h, x, y, THUMB_W, THUMB_H)),
    art: features(sample(src, a.w * w, a.h * h, x + a.x * w, y + a.y * h, THUMB_W, ART_H)),
  };
}

/** Normalised cross-correlation per channel, averaged: 1 = same picture, ~0 = unrelated. */
function ncc(x: Float32Array, y: Float32Array): number {
  let total = 0;
  for (let ch = 0; ch < 3; ch++) {
    let mx = 0;
    let my = 0;
    let n = 0;
    for (let i = ch; i < x.length; i += 3) {
      mx += x[i]!;
      my += y[i]!;
      n++;
    }
    mx /= n;
    my /= n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = ch; i < x.length; i += 3) {
      const a = x[i]! - mx;
      const b = y[i]! - my;
      sxy += a * b;
      sxx += a * a;
      syy += b * b;
    }
    // Luma carries the shapes; colour carries the palette. Weight luma most.
    const r = sxx > 1 && syy > 1 ? sxy / Math.sqrt(sxx * syy) : 0;
    total += r * (ch === 0 ? 0.6 : 0.2);
  }
  return total;
}

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      const timer = setTimeout(() => resolve(null), 8000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

export class PhotoMatcher {
  private readonly photo: Fingerprint;

  constructor(
    card: HTMLCanvasElement,
    private readonly game: GameId,
  ) {
    this.photo = fingerprint(card, cardBox(card), game);
  }

  /**
   * 0–1 likeness to a catalog image, or undefined when it can't be compared (image missing, or
   * served without CORS so its pixels can't be read).
   */
  async compare(url: string | undefined): Promise<number | undefined> {
    if (!url) return undefined;
    const img = await loadImage(url);
    if (!img || !img.naturalWidth) return undefined;
    try {
      const fp = fingerprint(img, { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }, this.game);
      // Mostly the artwork: printings from the same era share a frame layout, so the whole card
      // looks alike across different printings.
      const v = 0.8 * ncc(this.photo.art, fp.art) + 0.2 * ncc(this.photo.whole, fp.whole);
      return Math.max(0, Math.min(1, v));
    } catch {
      return undefined; // tainted canvas
    }
  }
}
