import type { CardPrinting, CardSet } from '../types';
import { sameCollectorNumber, stripLeadingZeros } from '../util/text';
import { getJson, getJsonOrNull, qs } from './http';

// TCGdex (https://tcgdex.dev): free, keyless, open-source Pokémon catalog. Each full card record
// carries the printings it exists in (normal / holo / reverse / 1st Edition) and TCGplayer market
// prices per printing, refreshed daily.
const API = 'https://api.tcgdex.net/v2/en';

export interface DexBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

interface DexTcgplayerPrinting {
  productId?: number | null;
  marketPrice?: number | null;
  midPrice?: number | null;
  lowPrice?: number | null;
}

export interface DexCard extends DexBrief {
  rarity?: string;
  category?: string;
  hp?: number;
  types?: string[];
  illustrator?: string;
  stage?: string;
  variants?: { normal?: boolean; holo?: boolean; reverse?: boolean; firstEdition?: boolean };
  set: { id: string; name: string; cardCount?: { official?: number; total?: number } };
  /** Not in the official SDK types, but present on full card records. */
  pricing?: {
    tcgplayer?: ({ updated?: string | null; unit?: string | null } & Record<string, unknown>) | null;
  } | null;
}

interface DexSetBrief {
  id: string;
  name: string;
  logo?: string;
  cardCount: { official: number; total: number };
}

/** TCGplayer's printing keys in TCGdex → the variant labels the app uses. */
const PRICE_LABELS: Record<string, string> = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  'reverse-holofoil': 'Reverse Holofoil',
  reverse: 'Reverse Holofoil',
  '1st-edition': '1st Edition',
  '1st-edition-holofoil': '1st Edition Holofoil',
  unlimited: 'Unlimited',
  'unlimited-holofoil': 'Unlimited Holofoil',
};

export function dexPrices(card: DexCard): { prices: Record<string, number>; productId?: number; updated?: string } {
  const tp = card.pricing?.tcgplayer;
  const prices: Record<string, number> = {};
  let productId: number | undefined;
  if (!tp) return { prices };
  for (const [key, value] of Object.entries(tp)) {
    if (key === 'updated' || key === 'unit' || !value || typeof value !== 'object') continue;
    const p = value as DexTcgplayerPrinting;
    const v = [p.marketPrice, p.midPrice, p.lowPrice].find((x): x is number => typeof x === 'number' && x > 0);
    if (v === undefined) continue;
    prices[PRICE_LABELS[key] ?? key] = v;
    productId ??= p.productId ?? undefined;
  }
  return { prices, productId, updated: tp.updated ?? undefined };
}

/**
 * The finishes this card was printed in, most likely first. The catalog's flags say which exist;
 * TCGplayer's listings win where they disagree (some cards are flagged `normal` but only ever sold
 * as holofoil).
 */
export function dexVariants(card: DexCard, priced: string[]): string[] {
  const f = card.variants ?? {};
  const out: string[] = [];
  const base = priced.includes('Holofoil') || (f.holo && !f.normal) ? 'Holofoil' : f.normal || priced.includes('Normal') ? 'Normal' : f.holo ? 'Holofoil' : undefined;
  if (base) out.push(base);
  if (f.holo && base !== 'Holofoil') out.push('Holofoil');
  if (f.normal && base !== 'Normal') out.push('Normal');
  if (f.reverse || priced.includes('Reverse Holofoil')) out.push('Reverse Holofoil');
  if (f.firstEdition) out.push(out[0] === 'Holofoil' ? '1st Edition Holofoil' : '1st Edition');
  for (const p of priced) if (!out.includes(p)) out.push(p);
  return out.length ? out : ['Normal', 'Holofoil', 'Reverse Holofoil'];
}

function setIdOf(cardId: string): string {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(0, i) : cardId;
}

export function fromDex(c: DexCard): CardPrinting {
  const { prices, productId } = dexPrices(c);
  const priced = Object.keys(prices);
  const details: Record<string, string> = {};
  if (c.hp) details.HP = String(c.hp);
  if (c.types?.length) details.Type = c.types.join(' / ');
  details.Category = [c.category, c.stage].filter(Boolean).join(' · ');
  if (c.illustrator) details.Illustrator = c.illustrator;
  const official = c.set.cardCount?.official;
  return {
    game: 'pokemon',
    key: c.id,
    name: c.name,
    setName: c.set.name,
    setCode: c.set.id,
    number: official ? `${c.localId}/${official}` : c.localId,
    rarity: c.rarity,
    image: c.image ? `${c.image}/low.webp` : undefined,
    imageLarge: c.image ? `${c.image}/high.webp` : undefined,
    prices: priced.length ? prices : undefined,
    priceSource: priced.length ? 'TCGplayer market (via TCGdex)' : undefined,
    // When we fetched them: drives the daily refresh. TCGdex's own `updated` can be days old.
    pricesUpdatedAt: priced.length ? new Date().toISOString() : undefined,
    variants: dexVariants(c, priced),
    url: productId ? `https://www.tcgplayer.com/product/${productId}` : `https://www.tcgdex.net/database/${setIdOf(c.id)}/${c.localId}`,
    details,
    source: 'tcgdex',
  };
}

/** Enough to rank by name/number and compare pictures; `completeDex` fetches the rest. */
export function partialFromBrief(b: DexBrief): CardPrinting {
  return {
    game: 'pokemon',
    key: b.id,
    name: b.name,
    setName: setIdOf(b.id),
    setCode: setIdOf(b.id),
    number: b.localId,
    image: b.image ? `${b.image}/low.webp` : undefined,
    imageLarge: b.image ? `${b.image}/high.webp` : undefined,
    variants: [],
    details: {},
    source: 'tcgdex',
    partial: true,
  };
}

export async function dexCard(id: string): Promise<CardPrinting | null> {
  const c = await getJsonOrNull<DexCard>(`${API}/cards/${encodeURIComponent(id)}`);
  return c ? fromDex(c) : null;
}

// TCG Pocket (the mobile game) shares the catalog; its sets are never physical cards.
const isPocketSet = (id: string): boolean => /^(A\d|B\d|P-A)/i.test(id);

/** "063" and "198": every set with 198 numbered cards, then that number in each. */
export async function dexByNumber(number: string, total: string): Promise<CardPrinting[]> {
  const sets = await getJson<DexSetBrief[]>(`${API}/sets`);
  const matching = sets.filter((s) => !isPocketSet(s.id) && String(s.cardCount?.official) === stripLeadingZeros(total)).slice(0, 10);
  const bare = stripLeadingZeros(number);
  // Older sets store "4", Scarlet & Violet stores "063": try the spellings that could exist.
  const forms = [...new Set([number, bare, /^\d+$/.test(bare) ? bare.padStart(3, '0') : bare])];
  const found = await Promise.all(
    matching.flatMap((s) => forms.map((n) => getJsonOrNull<DexCard>(`${API}/sets/${encodeURIComponent(s.id)}/${encodeURIComponent(n)}`).catch(() => null))),
  );
  const seen = new Set<string>();
  return found.filter((c): c is DexCard => !!c && !seen.has(c.id) && !!seen.add(c.id)).map(fromDex);
}

/**
 * Every card whose name contains `name`, as partial results: one request for the cards plus the
 * (cached) set list, which gives each result its set name and size.
 */
export async function dexByName(name: string, number?: string): Promise<CardPrinting[]> {
  const [list, sets] = await Promise.all([getJson<DexBrief[]>(`${API}/cards?${qs({ name })}`), getJson<DexSetBrief[]>(`${API}/sets`).catch(() => [])]);
  const setById = new Map(sets.map((s) => [s.id, s]));
  const physical = list.filter((b) => !isPocketSet(setIdOf(b.id)));
  const withNumber = number ? physical.filter((b) => sameCollectorNumber(b.localId, number)) : [];
  return (withNumber.length ? withNumber : physical).map((b) => {
    const card = partialFromBrief(b);
    const set = setById.get(card.setCode);
    if (set) {
      card.setName = set.name;
      if (set.cardCount?.official) card.number = `${b.localId}/${set.cardCount.official}`;
    }
    return card;
  });
}

/** Physical sets, newest first. TCGdex lists oldest first and has no dates in the listing. */
export async function dexSets(): Promise<CardSet[]> {
  const list = await getJson<DexSetBrief[]>(`${API}/sets`);
  return list
    .filter((s) => !isPocketSet(s.id) && s.cardCount?.total > 0)
    .reverse()
    .map((s) => ({ game: 'pokemon', id: s.id, name: s.name, code: s.id.toUpperCase(), total: s.cardCount.total, logo: s.logo ? `${s.logo}.webp` : undefined }));
}

/** Every card in a set, as partial results (completed when one is opened or added). */
export async function dexSetCards(setId: string): Promise<CardPrinting[]> {
  const set = await getJson<DexSetBrief & { cards: DexBrief[] }>(`${API}/sets/${encodeURIComponent(setId)}`, { timeoutMs: 30000 });
  return set.cards.map((b) => {
    const card = partialFromBrief(b);
    card.setName = set.name;
    if (set.cardCount?.official) card.number = `${b.localId}/${set.cardCount.official}`;
    return card;
  });
}
