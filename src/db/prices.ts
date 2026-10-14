import { GAMES } from '../games';
import type { CollectionEntry } from '../types';
import { listEntries, putEntries } from './store';

const DAY = 24 * 60 * 60 * 1000;
let running: Promise<number> | null = null;

function stale(e: CollectionEntry, maxAgeMs: number): boolean {
  const t = e.card.pricesUpdatedAt ? Date.parse(e.card.pricesUpdatedAt) : NaN;
  return Number.isNaN(t) || Date.now() - t > maxAgeMs;
}

/**
 * Re-fetch prices for saved cards older than `maxAgeMs` (default a day). Each distinct printing
 * is fetched once, three at a time, and all rows are saved together at the end. Returns how many
 * cards got new prices. Only one refresh runs at a time.
 */
export function refreshPrices(opts: { maxAgeMs?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<number> {
  running ??= (async () => {
    const entries = await listEntries();
    const byCard = new Map<string, CollectionEntry[]>();
    for (const e of entries) {
      if (!stale(e, opts.maxAgeMs ?? DAY)) continue;
      const k = `${e.card.game}|${e.card.key}`;
      byCard.set(k, [...(byCard.get(k) ?? []), e]);
    }
    const groups = [...byCard.values()];
    const updated: CollectionEntry[] = [];
    let done = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < groups.length) {
        const group = groups[next++]!;
        const card = group[0]!.card;
        const fresh = await GAMES[card.game].refresh(card).catch(() => null);
        if (fresh) {
          // Keep the saved identity; take the new facts and prices.
          const checked = { ...fresh, key: card.key, partial: undefined, pricesUpdatedAt: fresh.pricesUpdatedAt ?? new Date().toISOString() };
          for (const e of group) updated.push({ ...e, card: checked });
        }
        opts.onProgress?.(++done, groups.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await putEntries(updated);
    return new Set(updated.map((e) => e.card.key)).size;
  })().finally(() => (running = null));
  return running;
}
