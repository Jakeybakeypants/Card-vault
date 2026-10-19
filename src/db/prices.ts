import { GAMES } from '../games';
import type { CardPrinting, CollectionEntry } from '../types';
import { listEntries, putEntries, sameFinish } from './store';

const DAY = 24 * 60 * 60 * 1000;
/** A saved TCGplayer price younger than this beats a fallback-source price fetched today. */
const KEEP_MARKET_PRICE_MS = 14 * DAY;
let running: Promise<number> | null = null;

function ageMs(card: CardPrinting): number {
  const t = card.pricesUpdatedAt ? Date.parse(card.pricesUpdatedAt) : NaN;
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

function stale(e: CollectionEntry, maxAgeMs: number): boolean {
  return ageMs(e.card) > maxAgeMs;
}

/**
 * How good a price source is: the marketplace the app quotes (TCGplayer market, via the primary
 * catalog) ranks above the same marketplace via a fallback catalog, which ranks above another
 * marketplace's price converted from EUR (Cardmarket).
 */
export function sourceRank(source: string | undefined): number {
  if (!source) return 0;
  if (/cardmarket/i.test(source)) return 1;
  if (/pokemontcg\.io/i.test(source)) return 2;
  return 3;
}

/**
 * The saved card with today's prices merged in, finish by finish:
 * - no fresh price at all (between sales, source down): keep what we had;
 * - a fallback source while the saved TCGplayer price is recent: keep the saved prices too,
 *   so a day without TCGplayer data doesn't swap every finish to a converted Cardmarket figure;
 * - the same source: a finish the fresh list lacks keeps its last price (never a neighbour's);
 * - a better source than before: its prices replace the old ones wholesale.
 */
export function mergePrices(saved: CardPrinting, fresh: CardPrinting): CardPrinting {
  const keepSaved = { ...fresh, prices: saved.prices, priceSource: saved.priceSource, pricesUpdatedAt: saved.pricesUpdatedAt, url: saved.url ?? fresh.url };
  if (!fresh.prices) return keepSaved;
  if (!saved.prices) return fresh;
  const was = sourceRank(saved.priceSource);
  const now = sourceRank(fresh.priceSource);
  if (now < was) return ageMs(saved) <= KEEP_MARKET_PRICE_MS ? keepSaved : fresh;
  if (now > was) return fresh;
  const current = Object.keys(fresh.prices);
  const kept = Object.fromEntries(Object.entries(saved.prices).filter(([finish]) => !current.some((f) => sameFinish(finish, f))));
  return { ...fresh, prices: { ...kept, ...fresh.prices } };
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
          // Keep the saved identity; take the new facts and merge the prices per finish.
          const priced = mergePrices(card, fresh);
          const checked = { ...priced, key: card.key, partial: undefined, pricesUpdatedAt: priced.pricesUpdatedAt ?? new Date().toISOString() };
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
