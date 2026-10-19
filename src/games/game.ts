import type { Region } from '../scan/parse';
import type { Candidate, CardPrinting, CardSet, GameId, ScanHints } from '../types';
import { levenshtein, normalize, stripLeadingZeros } from '../util/text';

export interface Game {
  id: GameId;
  name: string;
  /** Strips of the card to OCR. */
  regions: Region[];
  /** Turn raw OCR text (by region key) into structured hints. */
  parse(raw: Record<string, string>): ScanHints;
  /** Look the hints up in the catalog and return ranked candidate printings. */
  identify(hints: ScanHints): Promise<Candidate[]>;
  /** 0–1: how well one printing's printed text matches what the scan read. */
  score(card: CardPrinting, hints: ScanHints): number;
  /** The scan read this printing's full identifier (number and set size / set code) exactly. */
  exactId(card: CardPrinting, hints: ScanHints): boolean;
  /** Fill in a `partial` search result (set, rarity, finishes, prices). */
  complete(card: CardPrinting): Promise<CardPrinting>;
  /** Re-fetch a saved card for current prices. `null` when the catalog no longer has it. */
  refresh(card: CardPrinting): Promise<CardPrinting | null>;
  /** Free-text search for manual adds: a name, a collector number or a set code. */
  search(query: string): Promise<CardPrinting[]>;
  /** Every set in the catalog, newest first. */
  sets(): Promise<CardSet[]>;
  /** Every printing in one set (may be `partial`). */
  setCards(set: CardSet): Promise<CardPrinting[]>;
}

/**
 * The marks of a special printing of the same Pokémon ("Charizard ex", "Pikachu V", "Mewtwo-GX",
 * "Umbreon ☆", "Garchomp C LV.X"). OCR usually drops them: they are small, stylised and often
 * foil. Used to compare names with and without them.
 */
export const NAME_SUFFIX = /\s+(ex|gx|v|vmax|vstar|v-union|lv\.x|break|prime|legend|star|☆|◇)$|-(ex|gx)$/i;

/** "Charizard ex" → "charizard": the Pokémon's name without a special-printing mark. */
export function baseName(name: string): string {
  return normalize(name.replace(NAME_SUFFIX, ''));
}

/** Photo likeness at or above which a catalog picture counts as confirming the match. */
const PHOTO_CONFIRMS = 0.5;
/** Name similarity that counts as reading the name: with the photo agreeing, and on text alone. */
const NAME_READ = 0.75;
const NAME_SURE = 0.9;

/** "63/198" and "68/198", "91/102" and "1/102", or the same line: collector lines one OCR slip apart. */
function nearLine(a: CardPrinting, b: CardPrinting): boolean {
  const line = (c: CardPrinting) => c.number.split('/').map(stripLeadingZeros).join('/');
  return levenshtein(line(a), line(b)) <= 1;
}

/**
 * Scanned results are trusted enough to add without asking when this returns true: a clear top
 * score and, for games that report `signals`, two independent signals that agree. Either the
 * name and the collector number (on text alone only when the set agrees too and no neighbour
 * is in the running: a card whose line is one digit away, which is where a misread digit
 * lands, or an outright reprint, and whose name reads as well as the top one's; then the photo
 * must side with the top one), or the number and set confirmed by the photo (the name was
 * unreadable), or the name confirmed by the photo (the number was unreadable). A candidate
 * whose catalog picture could not be compared never wins over one the photo confirmed.
 */
export function isConfident(candidates: Candidate[]): boolean {
  const [top, ...rest] = candidates;
  if (!top || top.score < 0.8) return false;
  const second = rest[0];
  if (second && top.score - second.score < 0.08) return false;
  if (top.visual === undefined && rest.some((c) => c.visual !== undefined && c.visual >= PHOTO_CONFIRMS && top.score - c.score < 0.15)) return false;
  const s = top.signals;
  if (!s) return true;
  const photo = top.visual ?? 0;
  const name = s.name ?? 0;
  const sameName = rest.filter((c) => baseName(c.card.name) === baseName(top.card.name));
  // The photo prefers another printing of the same name: the text probably misled.
  if (sameName.some((c) => c.visual !== undefined && c.visual > photo + 0.1)) return false;
  // The photo only confirms the top one when every printing that reads the same on text (same
  // line, name read as well) was compared too: a same-art reprint whose picture failed to load
  // would otherwise lose to its twin on the photo alone.
  const uncomparedTwin = rest.some((c) => c.visual === undefined && c.signals?.number && c.signals?.set && (c.signals.name ?? 0) >= name - 0.05);
  if (name >= NAME_READ && s.number && photo >= PHOTO_CONFIRMS) return !uncomparedTwin;
  if (name >= NAME_SURE && s.number && s.set) return !rest.some((c) => (c.signals?.name ?? 0) >= name - 0.05 && nearLine(c.card, top.card));
  if (s.number && s.set) return photo >= 0.6;
  return name >= NAME_READ && photo >= PHOTO_CONFIRMS;
}

/**
 * Weighted average over the signals the scan actually produced, so a card read with only a
 * number isn't penalised for the missing name and vice versa.
 */
export function weightedScore(parts: Array<[weight: number, value: number | undefined]>): number {
  let sum = 0;
  let weights = 0;
  for (const [w, v] of parts) {
    if (v === undefined) continue;
    sum += w * v;
    weights += w;
  }
  return weights ? sum / weights : 0;
}

export function rank(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = seen.get(c.card.key);
    // The same printing can arrive as a full record and as a partial one: keep the fuller record.
    const better = !prev || (prev.card.partial && !c.card.partial) || (!!prev.card.partial === !!c.card.partial && prev.score < c.score);
    if (better) seen.set(c.card.key, prev ? { ...c, score: Math.max(c.score, prev.score) } : c);
  }
  return [...seen.values()].sort(
    (a, b) => b.score - a.score || (b.card.releaseDate ?? '').localeCompare(a.card.releaseDate ?? ''),
  );
}
