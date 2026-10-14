import { parseLorcana, REGIONS } from '../scan/parse';
import type { Candidate, CardPrinting, CardSet, ScanHints } from '../types';
import { normalize, partialSimilarity, sameCollectorNumber } from '../util/text';
import { rank, weightedScore, type Game } from './game';
import { getJson, pool } from './http';

// Lorcast: free and keyless. https://lorcast.com/docs/api
// The whole Lorcana catalog is a few thousand cards, so it's fetched set by set and searched
// on the device; that keeps scanning independent of the API's search syntax.
const API = 'https://api.lorcast.com/v0';

interface LcSet {
  id: string;
  name: string;
  code: string;
  released_at?: string | null;
}
interface LcCard {
  id: string;
  name: string;
  version?: string | null;
  collector_number: string;
  rarity?: string;
  lang?: string;
  released_at?: string;
  ink?: string | null;
  cost?: number;
  type?: string[];
  classifications?: string[] | null;
  strength?: number | null;
  willpower?: number | null;
  lore?: number | null;
  illustrators?: string[];
  image_uris?: { digital?: { small?: string; normal?: string; large?: string } };
  set: { id: string; code: string; name: string };
  prices?: { usd?: string | null; usd_foil?: string | null };
}

export const LORCANA_VARIANTS = ['Normal', 'Foil'];

function num(s?: string | null): number | undefined {
  const v = s ? Number.parseFloat(s) : NaN;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function fromLorcast(c: LcCard): CardPrinting {
  const prices: Record<string, number> = {};
  const normal = num(c.prices?.usd);
  const foil = num(c.prices?.usd_foil);
  if (normal !== undefined) prices.Normal = normal;
  if (foil !== undefined) prices.Foil = foil;
  const foilOnly = /enchanted|epic|iconic/i.test(c.rarity ?? '') || (foil !== undefined && normal === undefined);

  const details: Record<string, string> = {};
  if (c.type?.length) details.Type = [...c.type, ...(c.classifications ?? [])].join(' · ');
  if (c.ink) details.Ink = c.ink;
  if (c.cost !== undefined) details.Cost = String(c.cost);
  if (c.strength != null || c.willpower != null) details['STR / WIL'] = `${c.strength ?? '–'} / ${c.willpower ?? '–'}`;
  if (c.lore != null) details.Lore = String(c.lore);
  if (c.illustrators?.length) details.Illustrator = c.illustrators.join(', ');

  const img = c.image_uris?.digital;
  return {
    game: 'lorcana',
    key: `${c.set.code}-${c.collector_number}`,
    name: c.version ? `${c.name} - ${c.version}` : c.name,
    setName: c.set.name,
    setCode: c.set.code,
    number: c.collector_number,
    rarity: c.rarity?.replace(/_/g, ' '),
    image: img?.normal ?? img?.small,
    imageLarge: img?.large ?? img?.normal,
    prices: Object.keys(prices).length ? prices : undefined,
    priceSource: Object.keys(prices).length ? 'TCGplayer (via Lorcast)' : undefined,
    pricesUpdatedAt: Object.keys(prices).length ? new Date().toISOString() : undefined,
    variants: foilOnly ? ['Foil'] : LORCANA_VARIANTS,
    releaseDate: c.released_at,
    details,
    source: 'lorcast',
  };
}

async function listSets(): Promise<LcSet[]> {
  const res = await getJson<{ results: LcSet[] }>(`${API}/sets`);
  return res.results;
}

function cardsIn(code: string): Promise<LcCard[]> {
  return getJson<LcCard[]>(`${API}/sets/${encodeURIComponent(code)}/cards`, { timeoutMs: 30000 });
}

let catalog: Promise<CardPrinting[]> | null = null;
function allCards(): Promise<CardPrinting[]> {
  catalog ??= listSets()
    .then((sets) => pool(sets, 3, (s) => cardsIn(s.code).catch(() => [] as LcCard[])))
    .then((lists) => lists.flat().map(fromLorcast));
  catalog.catch(() => (catalog = null));
  return catalog;
}

function score(card: CardPrinting, hints: ScanHints): number {
  const nameText = hints.nameText || hints.name;
  return weightedScore([
    [0.5, nameText ? partialSimilarity(card.name.split(' - ')[0]!, nameText) * 0.7 + partialSimilarity(card.name, nameText) * 0.3 : undefined],
    [0.35, hints.number ? (sameCollectorNumber(card.number, hints.number) ? 1 : 0) : undefined],
    [0.15, hints.setCode ? (normalize(card.setCode) === normalize(hints.setCode) ? 1 : 0) : undefined],
  ]);
}

function match(cards: CardPrinting[], hints: ScanHints): Candidate[] {
  const sameNumber = hints.number ? cards.filter((c) => sameCollectorNumber(c.number, hints.number!)) : cards;
  const scored = (sameNumber.length ? sameNumber : cards).map((card): Candidate => ({ card, score: score(card, hints) }));
  return rank(scored.filter((c) => c.score >= 0.45)).slice(0, 60);
}

export const lorcana: Game = {
  id: 'lorcana',
  name: 'Lorcana',
  regions: REGIONS.lorcana,
  parse: parseLorcana,

  score,
  exactId: (card, hints) => !!hints.number && !!hints.setCode && sameCollectorNumber(card.number, hints.number) && normalize(card.setCode) === normalize(hints.setCode),

  async complete(card) {
    return card;
  },

  async identify(hints) {
    if (!hints.number && !hints.name) return [];
    return match(await allCards(), hints);
  },

  async search(input) {
    const q = input.trim();
    if (!q) return [];
    // "12/204", "12 set 1", "mickey 12"
    const m = /^(.*?)\s*#?(\d{1,3}[a-z]?)(?:\s*\/\s*\d{1,3})?(?:\s+(?:set\s*)?(\w{1,4}))?$/i.exec(q);
    const hints: ScanHints = m ? { number: m[2], name: m[1] || undefined, nameText: m[1] || undefined, setCode: m[3] } : { name: q, nameText: q };
    return match(await allCards(), hints).map((c) => c.card);
  },

  async sets() {
    const [sets, cards] = await Promise.all([listSets(), allCards()]);
    const counts = new Map<string, number>();
    for (const c of cards) counts.set(c.setCode, (counts.get(c.setCode) ?? 0) + 1);
    return sets
      .map(
        (s): CardSet => ({
          game: 'lorcana',
          id: s.code,
          name: s.name,
          code: s.code,
          total: counts.get(s.code) ?? 0,
          releaseDate: s.released_at ?? undefined,
        }),
      )
      .filter((s) => s.total > 0)
      .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  },

  async setCards(set) {
    return (await cardsIn(set.id)).map(fromLorcast);
  },

  async refresh(card) {
    // The catalog is fetched once per session (the daily refresh runs at launch), so this is
    // one download for the whole collection.
    return (await allCards()).find((c) => c.key === card.key) ?? null;
  },
};
