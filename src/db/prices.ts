import { GAMES } from '../games';
import type { CardPrinting, CollectionEntry, GameId } from '../types';
import { entryValue, listEntries, putEntries } from './store';

/**
 * Keeps collection prices current. Prices are saved with each card when it's added; this
 * re-fetches today's prices for everything in the collection, on demand (Refresh prices) and
 * automatically once a day when the app is opened.
 */

const LAST_KEY = 'card-vault:prices-refreshed-at';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PriceStatus {
  running: boolean;
  /** Games done / games to do, for progress. */
  done: number;
  total: number;
  lastAt?: string;
}

let status: PriceStatus = { running: false, done: 0, total: 0, lastAt: readLast() };
const listeners = new Set<(s: PriceStatus) => void>();

function readLast(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function set(patch: Partial<PriceStatus>): void {
  status = { ...status, ...patch };
  for (const fn of listeners) fn(status);
}

export function priceStatus(): PriceStatus {
  return status;
}
export function onPriceStatus(fn: (s: PriceStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface RefreshResult {
  updated: number;
  /** Cards no catalog could find again (or whose catalog failed). */
  missed: number;
  before: number;
  after: number;
  failedGames: GameId[];
}

/** Today's prices onto an entry's card; everything else about the card is kept. */
export function withFreshPrices(e: CollectionEntry, fresh: CardPrinting, at: string): CollectionEntry {
  return { ...e, card: { ...e.card, prices: fresh.prices, pricedAt: at, image: e.card.image ?? fresh.image, url: e.card.url ?? fresh.url } };
}

export async function refreshPrices(): Promise<RefreshResult | null> {
  if (status.running) return null;
  const entries = await listEntries();
  const byGame = new Map<GameId, Map<string, CardPrinting>>();
  for (const e of entries) {
    const cards = byGame.get(e.card.game) ?? new Map<string, CardPrinting>();
    cards.set(e.card.key, e.card);
    byGame.set(e.card.game, cards);
  }
  set({ running: true, done: 0, total: byGame.size });
  const at = new Date().toISOString();
  const fresh = new Map<string, CardPrinting>();
  const failedGames: GameId[] = [];
  try {
    for (const [game, cards] of byGame) {
      try {
        for (const [key, card] of await GAMES[game].refresh([...cards.values()])) fresh.set(`${game}|${key}`, card);
      } catch (e) {
        console.warn(`Price refresh failed for ${game}`, e);
        failedGames.push(game);
      }
      set({ done: status.done + 1 });
    }
    // Re-read: the collection may have been edited while the catalogs were being asked.
    const current = await listEntries();
    const before = current.reduce((n, e) => n + (entryValue(e) ?? 0), 0);
    const next = current.map((e) => {
      const f = fresh.get(`${e.card.game}|${e.card.key}`);
      // No price today (delisted, between sales): keep the last known one.
      return f?.prices ? withFreshPrices(e, f, at) : e;
    });
    const changed = next.filter((e, i) => e !== current[i]);
    await putEntries(changed);
    // Only count it as a daily refresh if something actually came back.
    if (current.length === 0 || changed.length > 0) {
      try {
        localStorage.setItem(LAST_KEY, at);
      } catch {
        // Storage blocked: it'll just refresh again next launch.
      }
      set({ lastAt: at });
    }
    return {
      updated: changed.length,
      missed: current.length - changed.length,
      before,
      after: next.reduce((n, e) => n + (entryValue(e) ?? 0), 0),
      failedGames,
    };
  } finally {
    set({ running: false });
  }
}

/** Refresh in the background if the last refresh is more than a day old. */
export async function autoRefreshPrices(): Promise<RefreshResult | null> {
  const last = status.lastAt ? Date.parse(status.lastAt) : 0;
  if (status.running || Date.now() - last < DAY_MS) return null;
  if (!navigator.onLine) return null;
  const entries = await listEntries();
  if (!entries.length) return null;
  return refreshPrices();
}
