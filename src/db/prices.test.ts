import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardPrinting, CollectionEntry } from '../types';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

const refresh = vi.fn();
vi.mock('../games', () => ({ GAMES: { pokemon: { refresh: (c: CardPrinting) => refresh(c) } } }));
vi.mock('./store', async (orig) => ({ ...(await orig<typeof import('./store')>()), listEntries: vi.fn(), putEntries: vi.fn(async () => {}) }));

import { mergePrices, refreshPrices, sourceRank } from './prices';
import { listEntries, putEntries, unitPrice } from './store';

const DAY = 86400e3;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
const DEX = 'TCGplayer market (via TCGdex, prices of 2026-10-12)';
const card = (over: Partial<CardPrinting> = {}): CardPrinting => ({
  game: 'pokemon', key: 'swsh3-136', name: 'Furret', setName: 'Darkness Ablaze', setCode: 'DAA', number: '136/189',
  prices: { Normal: 0.12, 'Reverse Holofoil': 0.33 }, priceSource: DEX, pricesUpdatedAt: ago(2),
  variants: ['Normal', 'Reverse Holofoil'], details: {}, source: 'tcgdex', ...over,
});
const entry = (variant: string, c = card()): CollectionEntry => ({ id: `pokemon|${c.key}|${variant}|NM|EN`, card: c, quantity: 1, variant, condition: 'NM', language: 'EN', addedAt: '', updatedAt: '' });
const saved = (): CollectionEntry[] => vi.mocked(putEntries).mock.calls[0]![0];

beforeEach(() => {
  refresh.mockReset();
  vi.mocked(putEntries).mockClear();
});

describe('mergePrices', () => {
  it('ranks TCGplayer via the primary catalog above pokemontcg.io above Cardmarket', () => {
    expect(sourceRank(DEX)).toBeGreaterThan(sourceRank('TCGplayer market (via pokemontcg.io)'));
    expect(sourceRank('TCGplayer market (via pokemontcg.io)')).toBeGreaterThan(sourceRank('Cardmarket trend ≈ €77.00 (converted at $1.10/€)'));
    expect(sourceRank('TCGplayer (via Scryfall)')).toBe(sourceRank(DEX));
  });

  it('keeps the saved prices when the refresh has none', () => {
    const merged = mergePrices(card(), card({ prices: undefined, priceSource: undefined, pricesUpdatedAt: undefined, url: 'https://new' }));
    expect(merged.prices).toEqual({ Normal: 0.12, 'Reverse Holofoil': 0.33 });
    expect(merged.priceSource).toBe(DEX);
  });

  it('a finish that dropped out of the listing keeps its own last price, never a neighbour’s', () => {
    const merged = mergePrices(card(), card({ prices: { Normal: 0.15 }, pricesUpdatedAt: ago(0) }));
    expect(merged.prices).toEqual({ Normal: 0.15, 'Reverse Holofoil': 0.33 });
    expect(unitPrice(merged, 'Reverse Holofoil')).toBe(0.33);
  });

  it('a WotC-era relabel replaces the old label rather than keeping both', () => {
    const old = card({ prices: { Normal: 0.2, '1st Edition': 1 }, variants: ['Normal', '1st Edition'] });
    const merged = mergePrices(old, card({ prices: { Unlimited: 0.3, '1st Edition': 1.5 }, variants: ['Unlimited', '1st Edition'] }));
    expect(merged.prices).toEqual({ Unlimited: 0.3, '1st Edition': 1.5 });
    expect(unitPrice(merged, 'Normal')).toBe(0.3);
  });

  it('never replaces a recent TCGplayer price with a fallback-source price', () => {
    const cm = card({ prices: { Normal: 0.5, 'Reverse Holofoil': 0.9 }, priceSource: 'Cardmarket trend ≈ €0.45 (converted at $1.10/€)', pricesUpdatedAt: ago(0) });
    const saved = card();
    const merged = mergePrices(saved, cm);
    expect(merged.prices).toEqual({ Normal: 0.12, 'Reverse Holofoil': 0.33 });
    expect(merged.priceSource).toBe(DEX);
    // The saved date is kept too, so the refresh tries again tomorrow.
    expect(merged.pricesUpdatedAt).toBe(saved.pricesUpdatedAt);
  });

  it('accepts the fallback once the TCGplayer price is two weeks old, and a better source at once', () => {
    const cm = card({ prices: { Normal: 0.5 }, priceSource: 'Cardmarket trend ≈ €0.45 (converted at $1.10/€)', pricesUpdatedAt: ago(0) });
    expect(mergePrices(card({ pricesUpdatedAt: ago(20) }), cm).prices).toEqual({ Normal: 0.5 });
    const back = mergePrices(card({ prices: { Normal: 0.5, 'Reverse Holofoil': 0.9 }, priceSource: 'Cardmarket trend ≈ €0.45 (converted at $1.10/€)' }), card({ prices: { Normal: 0.15 }, pricesUpdatedAt: ago(0) }));
    expect(back.prices).toEqual({ Normal: 0.15 });
    expect(back.priceSource).toBe(DEX);
  });
});

describe('refreshPrices', () => {
  it('merges per finish: the reverse holo row keeps 0.33, never the Normal 0.15', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('Reverse Holofoil'), entry('Normal')]);
    refresh.mockResolvedValue(card({ prices: { Normal: 0.15 }, pricesUpdatedAt: ago(0) }));
    expect(await refreshPrices()).toBe(1);
    const r = saved().find((e) => e.variant === 'Reverse Holofoil')!;
    expect(unitPrice(r.card, 'Reverse Holofoil')).toBe(0.33);
    expect(unitPrice(saved().find((e) => e.variant === 'Normal')!.card, 'Normal')).toBe(0.15);
    expect(r.card.priceSource).toBe(DEX);
  });

  it('keeps a fresh TCGplayer price over a fallback-source price', async () => {
    const holo = entry('Holofoil', card({ key: 'sv03.5-199', prices: { Holofoil: 120 }, variants: ['Holofoil'] }));
    vi.mocked(listEntries).mockResolvedValue([holo]);
    refresh.mockResolvedValue(card({ key: 'sv03.5-199', prices: { Holofoil: 84.7 }, variants: ['Holofoil'], priceSource: 'Cardmarket trend ≈ €77.00 (converted at $1.10/€)', pricesUpdatedAt: ago(0) }));
    await refreshPrices();
    expect(saved()[0]!.card.prices).toEqual({ Holofoil: 120 });
    expect(saved()[0]!.card.priceSource).toBe(DEX);
  });

  it('keeps the old price when the refresh returns none', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('Normal')]);
    refresh.mockResolvedValue(card({ prices: undefined, priceSource: undefined, pricesUpdatedAt: undefined }));
    await refreshPrices();
    expect(saved()[0]!.card.prices).toEqual({ Normal: 0.12, 'Reverse Holofoil': 0.33 });
  });

  it('only refreshes stale cards', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('Normal', card({ pricesUpdatedAt: ago(0) }))]);
    expect(await refreshPrices()).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });
});
