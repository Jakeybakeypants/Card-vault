import type { GameId } from '../types';
import type { Recognition } from './recognize';

/**
 * A short memory of this session's scans, for diagnosing misreads: the card as the camera saw
 * it, what OCR read off it, what that matched, and what happened next (added, picked another,
 * searched instead). It never leaves the phone unless the user shares a report.
 */

export interface ScanLogEntry {
  at: string;
  game: GameId;
  mode: 'ocr' | 'ai';
  frames: number;
  hints: Recognition['hints'];
  candidates: Array<{ key: string; name: string; number: string; setName: string; score: number; visual?: number }>;
  shimmer?: number;
  outcome: string;
  /** The straightened card, as a JPEG data URL. */
  image: string;
}

const MAX = 20;
const entries: ScanLogEntry[] = [];
const listeners = new Set<() => void>();
let awaitingSearch: ScanLogEntry | null = null;

function changed(): void {
  for (const fn of listeners) fn();
}

export function onScanLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function scanLog(): readonly ScanLogEntry[] {
  return entries;
}

function jpeg(card: HTMLCanvasElement): string {
  // ~800 px tall keeps the small print legible at well under 100 KB.
  const scale = Math.min(1, 800 / card.height);
  const c = document.createElement('canvas');
  c.width = Math.round(card.width * scale);
  c.height = Math.round(card.height * scale);
  c.getContext('2d')!.drawImage(card, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

export function logScan(card: HTMLCanvasElement | undefined, rec: Recognition, opts: { mode: 'ocr' | 'ai'; frames: number }): ScanLogEntry {
  const entry: ScanLogEntry = {
    at: new Date().toISOString(),
    game: rec.game,
    mode: opts.mode,
    frames: opts.frames,
    hints: rec.hints,
    candidates: rec.candidates.slice(0, 10).map((c) => ({
      key: c.card.key,
      name: c.card.name,
      number: c.card.number,
      setName: c.card.setName,
      score: Math.round(c.score * 1000) / 1000,
      visual: c.visual === undefined ? undefined : Math.round(c.visual * 1000) / 1000,
    })),
    shimmer: rec.shimmer,
    outcome: rec.candidates.length ? 'shown matches' : 'no match',
    image: card ? jpeg(card) : '',
  };
  entries.unshift(entry);
  entries.length = Math.min(entries.length, MAX);
  changed();
  return entry;
}

export function setOutcome(entry: ScanLogEntry, outcome: string): void {
  entry.outcome = outcome;
  changed();
}

/** The scan led to a manual search; the next card added from search is what it should have been. */
export function awaitSearch(entry: ScanLogEntry): void {
  setOutcome(entry, 'searched manually');
  awaitingSearch = entry;
}

export function noteSearchedCard(card: { key: string; name: string; number: string }): void {
  if (!awaitingSearch) return;
  setOutcome(awaitingSearch, `searched manually, added ${card.key} (${card.name} ${card.number})`);
  awaitingSearch = null;
}

/** All logged scans as one JSON file, newest first. */
export function scanReport(): File {
  const body = JSON.stringify({ app: 'Card Vault', kind: 'scan report', created: new Date().toISOString(), userAgent: navigator.userAgent, scans: entries }, null, 1);
  return new File([body], `card-vault-scans-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, { type: 'application/json' });
}

/** Share sheet on phones (save to Files, AirDrop, Messages…), a download elsewhere. */
export async function shareScanReport(): Promise<void> {
  const file = scanReport();
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Card Vault scan report' });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
