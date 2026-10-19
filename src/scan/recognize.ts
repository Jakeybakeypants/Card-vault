import { GAMES } from '../games';
import { rank } from '../games/game';
import type { Candidate, CardPrinting, GameId, ScanHints } from '../types';
import { readCardWithClaude } from './ai';
import { ocrRegion, ocrRegions, rereadWord, type OcrResult } from './ocr';
import { hasGlare, PhotoMatcher, reverseProbability, shimmer } from './vision';

export interface Recognition {
  game: GameId;
  hints: ScanHints;
  candidates: Candidate[];
  /** Reverse-holo shimmer measured on the photo, kept so a confirmed finish can calibrate it. */
  shimmer?: number;
}

export function hasId(h: ScanHints): boolean {
  return !!(h.number || h.setCode || h.passcode);
}

/** Characters a collector number / set code can contain, for the close second look. */
const ID_WORD: Record<GameId, { looksLike: RegExp; whitelist: string; region: string[] }> = {
  pokemon: { looksLike: /\d.*\/|\/.*\d/, whitelist: '0123456789/TGRCSVH', region: ['bottom'] },
  yugioh: { looksLike: /[A-Z0-9]{2,4}\s?-/, whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-', region: ['middle', 'bottom'] },
  mtg: { looksLike: /^\d{3,4}$|\d\/\d/, whitelist: '0123456789/', region: ['bottom'] },
  lorcana: { looksLike: /\d.*\/|\/.*\d/, whitelist: '0123456789/', region: ['bottom'] },
};

/** On-device OCR of one photo: the identifier strips, re-read inverted if nothing was found. */
export async function readWithOcr(game: GameId, card: HTMLCanvasElement): Promise<ScanHints> {
  const g = GAMES[game];
  let results = await ocrRegions(card, g.regions);
  const texts = (rs: Record<string, OcrResult>): Record<string, string> => Object.fromEntries(Object.entries(rs).map(([k, v]) => [k, v.text]));
  let hints = g.parse(texts(results));
  // No number/code found: the print may be light-on-dark (full arts, ex cards, Pendulum
  // boxes). Re-read the identifier strips inverted and keep whatever that adds.
  if (!hasId(hints)) {
    const inverted = { ...results };
    for (const r of g.regions.filter((r) => r.key !== 'name')) inverted[r.key] = await ocrRegion(card, r, true);
    const retry = g.parse(texts(inverted));
    if (hasId(retry)) {
      hints = { ...retry, name: hints.name ?? retry.name, nameText: hints.nameText, nameCandidates: hints.nameCandidates };
      results = inverted;
    }
  }
  // No name either: on full arts, special illustration rares and gold cards the name is light
  // text over the artwork. Re-read the name strip inverted.
  const nameRegion = g.regions.find((r) => r.key === 'name');
  if (nameRegion && !hints.name && !hints.nameCandidates?.length) {
    const invertedName = await ocrRegion(card, nameRegion, true);
    const retry = g.parse({ ...texts(results), name: invertedName.text });
    if (retry.name || retry.nameCandidates?.length) {
      hints = { ...hints, name: retry.name, nameText: retry.nameText, nameCandidates: retry.nameCandidates };
      hints.raw = { ...hints.raw, 'name (inverted)': invertedName.text };
    }
  }
  // Second look at the word that holds the collector number / set code.
  const spec = ID_WORD[game];
  for (const key of spec.region) {
    const res = results[key];
    const word = res?.words.find((w) => spec.looksLike.test(w.text));
    if (!res || !word) continue;
    const reread = await rereadWord(res.image, word, spec.whitelist);
    const closer = g.parse({ ...texts(results), [key]: reread });
    if ((game === 'pokemon' || game === 'mtg' || game === 'lorcana') && closer.number) {
      hints.number = closer.number;
      hints.total = closer.total;
    } else if (game === 'yugioh' && closer.setCode) {
      hints.setCode = closer.setCode;
    }
    hints.raw = { ...hints.raw, [`${key} (second look)`]: reread };
    break;
  }
  hints.glare = hasGlare(card, g.regions);
  return hints;
}

/**
 * Combine several reads of the same card (a burst of frames). Each field takes the value seen
 * most often, so one frame's glare-garbled digit is outvoted by two clean ones.
 */
export function mergeHints(reads: ScanHints[]): ScanHints {
  const vote = <K extends keyof ScanHints>(key: K): ScanHints[K] => {
    const counts = new Map<string, { n: number; v: ScanHints[K] }>();
    for (const r of reads) {
      const v = r[key];
      if (v === undefined || v === '') continue;
      const k = JSON.stringify(v);
      const prev = counts.get(k);
      counts.set(k, { n: (prev?.n ?? 0) + 1, v });
    }
    let best: { n: number; v: ScanHints[K] } | undefined;
    for (const c of counts.values()) if (!best || c.n >= best.n) best = c;
    return best?.v as ScanHints[K];
  };
  // Number and total travel together: vote on the pair.
  const pairs = reads.filter((r) => r.number).map((r) => `${r.number}/${r.total ?? ''}`);
  let number: string | undefined;
  let total: string | undefined;
  if (pairs.length) {
    const tally = new Map<string, number>();
    for (const p of pairs) tally.set(p, (tally.get(p) ?? 0) + 1);
    const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1] || pairs.lastIndexOf(b[0]) - pairs.lastIndexOf(a[0]));
    [number, total] = best![0].split('/');
  }
  const last = reads[reads.length - 1];
  return {
    game: last?.game,
    name: vote('name'),
    // Every frame's name strip, so partial matching sees all the text that was read.
    nameText: reads.map((r) => r.nameText ?? '').filter(Boolean).join('\n') || undefined,
    nameCandidates: [...new Set(reads.flatMap((r) => r.nameCandidates ?? []))].slice(0, 4),
    number,
    total: total || undefined,
    setCode: vote('setCode'),
    passcode: vote('passcode'),
    variant: vote('variant'),
    language: vote('language'),
    glare: last?.glare,
    raw: last?.raw,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Likeness assumed for a catalog picture that could not be compared: a little below doubtful. */
const NO_PICTURE = 0.35;

/**
 * Text agreement first; the photo comparison breaks ties between printings and catches misreads.
 * A picture that could not be compared (missing, failed to load) counts as a neutral, slightly
 * doubtful likeness, so an imageless candidate never outranks one the photo confirmed and
 * never gets the exact-match boost. When the full number was read exactly and the picture also
 * matches, that settles it even if the name was unreadable (foil behind the name, glare on the
 * title).
 */
function combined(text: number, visual: number | undefined, exact = false): number {
  const blend = 0.7 * text + 0.3 * (visual ?? NO_PICTURE);
  return exact && visual !== undefined && visual >= 0.75 ? Math.max(blend, 0.8 + 0.15 * visual) : blend;
}

/**
 * Look the hints up, compare the photo against each candidate's catalog picture, fill in the
 * best few, and rank. Returns at most 10 candidates.
 */
export async function resolve(game: GameId, hints: ScanHints, card: HTMLCanvasElement): Promise<Candidate[]> {
  const g = GAMES[game];
  const found = await g.identify(hints);
  if (!found.length) return [];
  const matcher = new PhotoMatcher(card, game);
  const pool = found.slice(0, 60);
  const visuals = await mapLimit(pool, 8, (c) => matcher.compare(c.card.image));
  const prelim = pool
    .map((c, i): Candidate => ({ ...c, visual: visuals[i], score: combined(c.score, visuals[i], g.exactId(c.card, hints)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  const full = await Promise.all(
    prelim.map(async (c) => {
      const cardFull: CardPrinting = c.card.partial ? await g.complete(c.card).catch(() => c.card) : c.card;
      return { ...c, card: cardFull, score: combined(g.score(cardFull, hints), c.visual, g.exactId(cardFull, hints)) };
    }),
  );
  return rank(full);
}

/**
 * Guess the finish for the top match: certain when the card only exists in one; otherwise from
 * the reverse-holo shimmer, with a confidence the UI uses to decide whether to ask.
 */
export function guessFinish(card: CardPrinting, hints: ScanHints, shimmerValue: number | undefined): { variant: string; confidence: number } {
  const options = card.variants;
  if (hints.variant) {
    const hit = options.find((v) => v.toLowerCase().startsWith(hints.variant!.toLowerCase()));
    if (hit) return { variant: hit, confidence: hints.variantConfidence ?? 0.9 };
  }
  const base = options.find((v) => v !== 'Reverse Holofoil') ?? options[0] ?? 'Normal';
  if (options.length <= 1) return { variant: options[0] ?? base, confidence: 1 };
  const hasReverse = options.includes('Reverse Holofoil');
  if (!hasReverse || shimmerValue === undefined) return { variant: base, confidence: 0.5 };
  const p = reverseProbability(shimmerValue);
  return p >= 0.5 ? { variant: 'Reverse Holofoil', confidence: p } : { variant: base, confidence: 1 - p };
}

/** Claude reads the card (and works out which game it is), then the same lookup. */
export async function recognizeWithClaude(card: HTMLCanvasElement, apiKey: string): Promise<Recognition> {
  const hints = await readCardWithClaude(card, apiKey);
  return lookUp(hints.game!, hints, card);
}

/** Catalog lookup + photo comparison for hints read off `card`. */
export async function lookUp(game: GameId, hints: ScanHints, card: HTMLCanvasElement): Promise<Recognition> {
  if (!hasId(hints) && !hints.name) return { game, hints, candidates: [] };
  const candidates = await resolve(game, hints, card);
  return { game, hints, candidates, shimmer: shimmer(card, game) };
}
