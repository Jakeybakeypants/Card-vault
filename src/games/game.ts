import type { Region } from '../scan/parse';
import type { Candidate, CardPrinting, CardSet, GameId, ScanHints } from '../types';

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

/** Scanned results are trusted enough to add without asking when this returns true. */
export function isConfident(candidates: Candidate[]): boolean {
  const [top, second] = candidates;
  if (!top || top.score < 0.8) return false;
  return !second || top.score - second.score >= 0.08;
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
