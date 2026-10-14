import type { CardPrinting, CardSet } from '../types';
import { candidateSets, localIdForms, localIdIn, pokemonSet, totalDigits } from './pokemonSetIndex';
import { sameCollectorNumber } from '../util/text';
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

type DexTcgplayer = ({ updated?: string | null; unit?: string | null } & Record<string, unknown>) | null;

/** One printing of the card (finish, stamp, special foil) with its own marketplace ids and prices. */
interface DexVariantDetailed {
  type?: string;
  stamp?: string[];
  foil?: string;
  thirdParty?: { tcgplayer?: number; cardmarket?: number };
  pricing?: { tcgplayer?: DexTcgplayer; cardmarket?: DexCardmarket | null } | null;
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
  variants_detailed?: DexVariantDetailed[];
  /** Not in the official SDK types, but present on full card records. */
  pricing?: {
    tcgplayer?: DexTcgplayer;
    cardmarket?: DexCardmarket | null;
  } | null;
}

/** Cardmarket's price guide for the card, in EUR. The `-holo` fields are the reverse holo. */
export interface DexCardmarket {
  updated?: string;
  unit?: string;
  avg?: number;
  low?: number;
  trend?: number;
  avg30?: number;
  'avg-holo'?: number;
  'low-holo'?: number;
  'trend-holo'?: number;
  'avg30-holo'?: number;
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

/** Plain finishes only: stamped (prerelease, staff…) and special-foil printings sell for different prices. */
function plainVariants(card: DexCard): DexVariantDetailed[] {
  return (card.variants_detailed ?? []).filter((v) => !v.stamp?.length && !v.foil);
}

/**
 * TCGplayer market price per finish. The card-level prices cover one TCGplayer product; finishes
 * sold as separate products carry their own under `variants_detailed`, so those fill the gaps.
 */
export function dexPrices(card: DexCard): { prices: Record<string, number>; productId?: number; updated?: string } {
  const prices: Record<string, number> = {};
  let productId: number | undefined;
  let updated: string | undefined;
  const sources = [card.pricing?.tcgplayer, ...plainVariants(card).map((v) => v.pricing?.tcgplayer)];
  for (const tp of sources) {
    if (!tp) continue;
    updated ??= tp.updated ?? undefined;
    for (const [key, value] of Object.entries(tp)) {
      if (key === 'updated' || key === 'unit' || !value || typeof value !== 'object') continue;
      const p = value as DexTcgplayerPrinting;
      const v = [p.marketPrice, p.midPrice, p.lowPrice].find((x): x is number => typeof x === 'number' && x > 0);
      const label = PRICE_LABELS[key] ?? key;
      if (v === undefined || label in prices) continue;
      prices[label] = v;
      productId ??= p.productId ?? undefined;
    }
  }
  // No prices (a gallery TCGdex doesn't price), but the product is known: still link to it.
  productId ??= plainVariants(card).find((v) => v.thirdParty?.tcgplayer)?.thirdParty?.tcgplayer;
  return { prices, productId, updated };
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

export function setIdOf(cardId: string): string {
  const i = cardId.lastIndexOf('-');
  return i > 0 ? cardId.slice(0, i) : cardId;
}

/** Set name, printed code and release date for a card id, from the generated set table. */
function setFacts(setId: string): { name?: string; code?: string; releaseDate?: string; official?: number } {
  const s = pokemonSet(setId);
  return s ? { name: s.name, code: s.code ? s.code.split(':')[0] : undefined, releaseDate: s.releaseDate, official: s.official || undefined } : {};
}

export function fromDex(c: DexCard): CardPrinting {
  const { prices, productId } = dexPrices(c);
  const priced = Object.keys(prices);
  const details: Record<string, string> = {};
  if (c.hp) details.HP = String(c.hp);
  if (c.types?.length) details.Type = c.types.join(' / ');
  details.Category = [c.category, c.stage].filter(Boolean).join(' · ');
  if (c.illustrator) details.Illustrator = c.illustrator;
  const facts = setFacts(c.set.id);
  const official = c.set.cardCount?.official || facts.official;
  return {
    game: 'pokemon',
    key: c.id,
    name: c.name,
    setName: c.set.name,
    setCode: facts.code ?? c.set.id,
    number: official ? `${c.localId}/${official}` : c.localId,
    rarity: c.rarity,
    image: c.image ? `${c.image}/low.webp` : undefined,
    imageLarge: c.image ? `${c.image}/high.webp` : undefined,
    prices: priced.length ? prices : undefined,
    priceSource: priced.length ? 'TCGplayer market (via TCGdex)' : undefined,
    // When we fetched them: drives the daily refresh. TCGdex's own `updated` can be days old.
    pricesUpdatedAt: priced.length ? new Date().toISOString() : undefined,
    variants: dexVariants(c, priced),
    releaseDate: facts.releaseDate,
    url: productId ? `https://www.tcgplayer.com/product/${productId}` : `https://www.tcgdex.net/database/${setIdOf(c.id)}/${c.localId}`,
    details,
    source: 'tcgdex',
  };
}

/** Enough to rank by name/number and compare pictures; `completeDex` fetches the rest. */
export function partialFromBrief(b: DexBrief): CardPrinting {
  const setId = setIdOf(b.id);
  const facts = setFacts(setId);
  return {
    game: 'pokemon',
    key: b.id,
    name: b.name,
    setName: facts.name ?? setId,
    setCode: facts.code ?? setId,
    number: facts.official ? `${b.localId}/${facts.official}` : b.localId,
    image: b.image ? `${b.image}/low.webp` : undefined,
    imageLarge: b.image ? `${b.image}/high.webp` : undefined,
    variants: [],
    releaseDate: facts.releaseDate,
    details: {},
    source: 'tcgdex',
    partial: true,
  };
}

/** A full card plus its Cardmarket prices (EUR), which `fromDex` leaves out. */
export async function dexCardWithMarket(id: string): Promise<{ card: CardPrinting; cardmarket?: DexCardmarket } | null> {
  const c = await getJsonOrNull<DexCard>(`${API}/cards/${encodeURIComponent(id)}`);
  return c ? { card: fromDex(c), cardmarket: c.pricing?.cardmarket ?? plainVariants(c).find((v) => v.pricing?.cardmarket)?.pricing?.cardmarket ?? undefined } : null;
}

// TCG Pocket (the mobile game) shares the catalog; its sets are never physical cards.
const isPocketSet = (id: string): boolean => /^(A\d|B\d|P-A)/i.test(id);

async function liveSets(): Promise<DexSetBrief[]> {
  return getJson<DexSetBrief[]>(`${API}/sets`);
}

/** One printed number in one set, or null. Known sets need one request; new ones try spellings. */
async function inSet(setId: string, number: string): Promise<DexCard | null> {
  const known = pokemonSet(setId);
  const forms = known ? [localIdIn(known, number)] : localIdForms(number);
  for (const n of forms) {
    const c = await getJsonOrNull<DexCard>(`${API}/sets/${encodeURIComponent(setId)}/${encodeURIComponent(n)}`).catch(() => null);
    if (c) return c;
  }
  return null;
}

/**
 * A printed collector number: "063" + "198" (+ "SVI"), "TG05" + "TG30", "SV001" + "SV122".
 * The set code, when read, names the set; otherwise every set of that size is tried, newest
 * first, including sets released after the generated table.
 */
export async function dexByNumber(number: string, total: string | undefined, setCode?: string, setName?: string): Promise<CardPrinting[]> {
  const ids = [...candidateSets({ number, total, setCode, setName }), ...(setCode ? candidateSets({ number, total, setName }) : [])].map((s) => s.id);
  const size = totalDigits(total);
  if (size) {
    const live = await liveSets().catch(() => [] as DexSetBrief[]);
    for (const s of [...live].reverse()) {
      if (!pokemonSet(s.id) && !isPocketSet(s.id) && String(s.cardCount?.official) === size) ids.push(s.id);
    }
  }
  const tries = [...new Set(ids)].slice(0, 8);
  const found = await Promise.all(tries.map((id) => inSet(id, number)));
  const seen = new Set<string>();
  return found.filter((c): c is DexCard => !!c && !seen.has(c.id) && !!seen.add(c.id)).map(fromDex);
}

/** A Black Star promo: "SWSH050" → swshp/SWSH050, "085" with SVP read beside it → svp/085. */
export async function dexPromo(setId: string, number: string): Promise<CardPrinting[]> {
  const c = await inSet(setId, number);
  return c ? [fromDex(c)] : [];
}

/**
 * Every card whose name contains `name`, as partial results. Set names, sizes and dates come
 * from the generated table; the live set list fills in sets newer than it.
 */
export async function dexByName(name: string, number?: string): Promise<CardPrinting[]> {
  const [list, sets] = await Promise.all([getJson<DexBrief[]>(`${API}/cards?${qs({ name })}`), liveSets().catch(() => [] as DexSetBrief[])]);
  const setById = new Map(sets.map((s) => [s.id, s]));
  const physical = list.filter((b) => !isPocketSet(setIdOf(b.id)));
  const withNumber = number ? physical.filter((b) => sameCollectorNumber(b.localId, number)) : [];
  return (withNumber.length ? withNumber : physical).map((b) => {
    const card = partialFromBrief(b);
    const set = setById.get(setIdOf(b.id));
    if (set && !pokemonSet(set.id)) {
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
    .map((s): CardSet => {
      const known = pokemonSet(s.id);
      return {
        game: 'pokemon',
        id: s.id,
        name: s.name,
        code: known?.code || s.id.toUpperCase(),
        total: s.cardCount.total,
        releaseDate: known?.releaseDate,
        series: known?.series,
        logo: s.logo ? `${s.logo}.webp` : undefined,
      };
    })
    // Newest first; sets newer than the generated table have no date and lead the list.
    .sort((a, b) => (b.releaseDate ?? '9999').localeCompare(a.releaseDate ?? '9999'));
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
