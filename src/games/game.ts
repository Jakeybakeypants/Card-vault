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
  /** Free-text search for manual adds: a name, a collector number or a set code. */
  search(query: string): Promise<CardPrinting[]>;
  /** Every set in the catalog, newest first. */
  sets(): Promise<CardSet[]>;
  /** Every printing in one set. */
  setCards(set: CardSet): Promise<CardPrinting[]>;
  /**
   * Today's catalog data for cards already in the collection, keyed by `CardPrinting.key`.
   * Cards the catalog can't find again are left out.
   */
  refresh(cards: CardPrinting[]): Promise<Map<string, CardPrinting>>;
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
    if (!prev || prev.score < c.score) seen.set(c.card.key, c);
  }
  return [...seen.values()].sort(
    (a, b) => b.score - a.score || (b.card.releaseDate ?? '').localeCompare(a.card.releaseDate ?? ''),
  );
}
