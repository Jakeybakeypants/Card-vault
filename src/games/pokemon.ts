import { parsePokemon, REGIONS } from '../scan/parse';
import type { Candidate, CardPrinting, CardSet, ScanHints } from '../types';
import { normalize, partialSimilarity, sameCollectorNumber, stripLeadingZeros } from '../util/text';
import { settings } from '../util/settings';
import { rank, weightedScore, type Game } from './game';
import { getJson, getJsonOrNull, qs } from './http';

// ---------------------------------------------------------------------------------------------
// pokemontcg.io v2 (primary): rich data including TCGplayer market prices. Works without a key;
// a free key from https://dev.pokemontcg.io raises the rate limit.
// ---------------------------------------------------------------------------------------------

interface PtcgPrice {
  market: number | null;
  mid: number | null;
}
interface PtcgCard {
  id: string;
  name: string;
  supertype: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  number: string;
  artist?: string;
  rarity?: string;
  set: { id: string; name: string; series: string; printedTotal: number; total: number; ptcgoCode?: string; releaseDate: string };
  images: { small: string; large: string };
  tcgplayer?: { url: string; prices?: Record<string, PtcgPrice | undefined> };
}

const PTCG = 'https://api.pokemontcg.io/v2/cards';
const PTCG_SETS = 'https://api.pokemontcg.io/v2/sets';
const SELECT = 'id,name,supertype,subtypes,hp,types,number,artist,rarity,set,images,tcgplayer';

/** TCGplayer price keys → the variant labels shown in the app. */
const VARIANT_LABELS: Record<string, string> = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holofoil',
  '1stEditionHolofoil': '1st Edition Holofoil',
  '1stEditionNormal': '1st Edition',
  unlimitedHolofoil: 'Unlimited Holofoil',
  unlimited: 'Unlimited',
  '1stEdition': '1st Edition',
};
export const POKEMON_VARIANTS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', '1st Edition Holofoil', 'Unlimited Holofoil'];

function fromPtcg(c: PtcgCard): CardPrinting {
  const prices: Record<string, number> = {};
  for (const [k, p] of Object.entries(c.tcgplayer?.prices ?? {})) {
    const v = p?.market ?? p?.mid;
    if (v != null) prices[VARIANT_LABELS[k] ?? k] = v;
  }
  const priced = Object.keys(prices);
  const details: Record<string, string> = {};
  if (c.hp) details.HP = c.hp;
  if (c.types?.length) details.Type = c.types.join(' / ');
  details.Category = [c.supertype, ...(c.subtypes ?? [])].join(' · ');
  if (c.artist) details.Illustrator = c.artist;
  details.Series = c.set.series;
  return {
    game: 'pokemon',
    key: c.id,
    name: c.name,
    setName: c.set.name,
    setCode: c.set.ptcgoCode ?? c.set.id,
    number: `${c.number}/${c.set.printedTotal}`,
    rarity: c.rarity,
    image: c.images.small,
    imageLarge: c.images.large,
    prices: priced.length ? prices : undefined,
    variants: priced.length ? priced : defaultVariants(c.rarity),
    releaseDate: c.set.releaseDate?.replace(/\//g, '-'),
    url: c.tcgplayer?.url,
    details,
    source: 'pokemontcg.io',
  };
}

function defaultVariants(rarity?: string): string[] {
  return /holo|rare|ex|gx|v\b|vmax|vstar/i.test(rarity ?? '') ? ['Holofoil', 'Reverse Holofoil', 'Normal'] : ['Normal', 'Reverse Holofoil', 'Holofoil'];
}

function ptcgHeaders(): Record<string, string> | undefined {
  const key = settings().pokemonTcgApiKey;
  return key ? { 'X-Api-Key': key } : undefined;
}

async function ptcgQuery(q: string, pageSize = 60): Promise<PtcgCard[]> {
  const url = `${PTCG}?${qs({ q, pageSize, orderBy: '-set.releaseDate', select: SELECT })}`;
  const res = await getJson<{ data: PtcgCard[] }>(url, { headers: ptcgHeaders(), timeoutMs: 20000 });
  return res.data;
}

interface PtcgSet {
  id: string;
  name: string;
  series: string;
  total: number;
  ptcgoCode?: string;
  releaseDate: string;
  images: { symbol: string; logo: string };
}

async function ptcgSets(): Promise<CardSet[]> {
  const res = await getJson<{ data: PtcgSet[] }>(`${PTCG_SETS}?${qs({ orderBy: '-releaseDate', pageSize: 250 })}`, { headers: ptcgHeaders(), timeoutMs: 20000 });
  return res.data.map((s) => ({
    game: 'pokemon',
    id: s.id,
    name: s.name,
    code: s.ptcgoCode ?? s.id.toUpperCase(),
    total: s.total,
    releaseDate: s.releaseDate.replace(/\//g, '-'),
    series: s.series,
    logo: s.images.logo,
  }));
}

/** All cards in a set, a page (max 250) at a time. */
async function ptcgSetCards(setId: string): Promise<CardPrinting[]> {
  const out: PtcgCard[] = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${PTCG}?${qs({ q: `set.id:${setId}`, pageSize: 250, page, select: SELECT })}`;
    const res = await getJson<{ data: PtcgCard[]; totalCount: number }>(url, { headers: ptcgHeaders(), timeoutMs: 30000 });
    out.push(...res.data);
    if (!res.data.length || out.length >= res.totalCount) break;
  }
  return out.map(fromPtcg);
}

/** "025" → `(number:25 OR number:025)`, so either padding style in the catalog matches. */
function numberClause(n: string): string {
  const bare = stripLeadingZeros(n);
  const forms = new Set([n, bare]);
  return forms.size > 1 ? `(${[...forms].map((f) => `number:${f}`).join(' OR ')})` : `number:${bare}`;
}

/**
 * Query on the longest word of the name with a trailing wildcard. OCR'd names often carry a
 * stray fragment ("Pikachu Hc"), and the longest word is the one most likely to be right;
 * candidates are then ranked against the full text.
 */
function nameClause(name: string): string {
  const words = name
    .replace(/["\\:()*]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const longest = [...words].sort((a, b) => b.length - a.length)[0] ?? name;
  return words.length > 1 && longest.length < 4 ? `name:"${words.join(' ')}"` : `name:${longest}*`;
}

// ---------------------------------------------------------------------------------------------
// TCGdex (fallback): free and keyless, used when pokemontcg.io is down or rate limited.
// ---------------------------------------------------------------------------------------------

const TCGDEX = 'https://api.tcgdex.net/v2/en';

interface DexCardBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}
interface DexCard extends DexCardBrief {
  rarity?: string;
  category?: string;
  hp?: number;
  types?: string[];
  illustrator?: string;
  variants?: { normal?: boolean; reverse?: boolean; holo?: boolean; firstEdition?: boolean };
  set: { id: string; name: string; cardCount: { official: number; total: number } };
}
interface DexSetBrief {
  id: string;
  name: string;
  logo?: string;
  cardCount: { official: number; total: number };
}

async function dexSets(): Promise<CardSet[]> {
  const list = await getJson<DexSetBrief[]>(`${TCGDEX}/sets`);
  // TCGdex lists oldest first and has no release dates in the listing.
  return list.reverse().map((s) => ({
    game: 'pokemon',
    id: `dex:${s.id}`,
    name: s.name,
    code: s.id.toUpperCase(),
    total: s.cardCount.total,
    logo: s.logo ? `${s.logo}.webp` : undefined,
  }));
}

async function dexSetCards(setId: string): Promise<CardPrinting[]> {
  const set = await getJson<DexSetBrief & { cards: DexCardBrief[] }>(`${TCGDEX}/sets/${encodeURIComponent(setId)}`);
  return set.cards.map((c) => ({
    game: 'pokemon',
    key: c.id,
    name: c.name,
    setName: set.name,
    setCode: set.id,
    number: `${c.localId}/${set.cardCount.official}`,
    image: c.image ? `${c.image}/low.webp` : undefined,
    imageLarge: c.image ? `${c.image}/high.webp` : undefined,
    variants: defaultVariants(),
    details: {},
    source: 'tcgdex',
  }));
}

function fromDex(c: DexCard): CardPrinting {
  const v = c.variants ?? {};
  const variants = [v.holo && 'Holofoil', v.normal && 'Normal', v.reverse && 'Reverse Holofoil', v.firstEdition && '1st Edition'].filter(
    (x): x is string => !!x,
  );
  const details: Record<string, string> = {};
  if (c.hp) details.HP = String(c.hp);
  if (c.types?.length) details.Type = c.types.join(' / ');
  if (c.category) details.Category = c.category;
  if (c.illustrator) details.Illustrator = c.illustrator;
  return {
    game: 'pokemon',
    key: c.id,
    name: c.name,
    setName: c.set.name,
    setCode: c.set.id,
    number: `${c.localId}/${c.set.cardCount.official}`,
    rarity: c.rarity,
    image: c.image ? `${c.image}/low.webp` : undefined,
    imageLarge: c.image ? `${c.image}/high.webp` : undefined,
    variants: variants.length ? variants : defaultVariants(c.rarity),
    details,
    source: 'tcgdex',
  };
}

async function dexByName(name: string, number?: string): Promise<CardPrinting[]> {
  const list = await getJson<DexCardBrief[]>(`${TCGDEX}/cards?${qs({ name })}`);
  const filtered = number ? list.filter((c) => sameCollectorNumber(c.localId, number)) : list;
  const top = filtered
    .map((c) => ({ c, s: partialSimilarity(c.name, name) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 16);
  const cards = await Promise.all(top.map(({ c }) => getJsonOrNull<DexCard>(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`)));
  return cards.filter((c): c is DexCard => !!c).map(fromDex);
}

async function dexByNumber(number: string, total: string): Promise<CardPrinting[]> {
  const sets = await getJson<DexSetBrief[]>(`${TCGDEX}/sets`);
  const matching = sets.filter((s) => String(s.cardCount.official) === stripLeadingZeros(total)).slice(0, 8);
  const tries = matching.flatMap((s) => [...new Set([number, stripLeadingZeros(number)])].map((n) => `${TCGDEX}/sets/${s.id}/${encodeURIComponent(n)}`));
  const cards = await Promise.all(tries.map((u) => getJsonOrNull<DexCard>(u).catch(() => null)));
  return cards.filter((c): c is DexCard => !!c).map(fromDex);
}

// ---------------------------------------------------------------------------------------------

function score(card: CardPrinting, hints: ScanHints): number {
  const [num, total] = card.number.split('/');
  const nameText = hints.nameText || hints.name;
  return weightedScore([
    [0.5, nameText ? partialSimilarity(card.name, nameText) : undefined],
    [0.35, hints.number ? (sameCollectorNumber(num ?? '', hints.number) ? 1 : 0) : undefined],
    [0.1, hints.total ? (sameCollectorNumber(total ?? '', hints.total) ? 1 : 0) : undefined],
    [0.05, hints.setCode ? (normalize(card.setCode) === normalize(hints.setCode) ? 1 : 0) : undefined],
  ]);
}

async function lookup(hints: ScanHints): Promise<CardPrinting[]> {
  const queries: string[] = [];
  if (hints.number) {
    const totalIsPlain = hints.total && /^\d+$/.test(hints.total);
    if (totalIsPlain) queries.push(`${numberClause(hints.number)} set.printedTotal:${stripLeadingZeros(hints.total!)}`);
    if (hints.setCode) queries.push(`${numberClause(hints.number)} set.ptcgoCode:${hints.setCode}`);
    if (hints.name) queries.push(`${numberClause(hints.number)} ${nameClause(hints.name)}`);
    if (!totalIsPlain && !hints.name) queries.push(numberClause(hints.number));
  }
  if (hints.name) queries.push(nameClause(hints.name));
  if (!queries.length) return [];

  const results = await Promise.all(
    queries.map((q) =>
      ptcgQuery(q).catch((e: unknown) => {
        console.warn('pokemontcg.io query failed', q, e);
        return [] as PtcgCard[];
      }),
    ),
  );
  const cards = results.flat().map(fromPtcg);
  if (cards.length) return cards;

  // Fallback, or nothing found: TCGdex.
  const out: CardPrinting[] = [];
  if (hints.number && hints.total && /^\d+$/.test(hints.total)) out.push(...(await dexByNumber(hints.number, hints.total).catch(() => [])));
  if (hints.name) out.push(...(await dexByName(hints.name, out.length ? undefined : hints.number).catch(() => [])));
  return out;
}

export const pokemon: Game = {
  id: 'pokemon',
  name: 'Pokémon',
  regions: REGIONS.pokemon,
  parse: parsePokemon,

  async identify(hints) {
    const cards = await lookup(hints);
    return rank(cards.map((card): Candidate => ({ card, score: score(card, hints) })));
  },

  async search(query) {
    const q = query.trim();
    if (!q) return [];
    // "25/198", "pikachu 25/198", "TG05/TG30"
    const m = /^(.*?)\s*([A-Z]{0,2}\d{1,3}[a-z]?)\s*\/\s*([A-Z]{0,2}\d{1,3})$/i.exec(q);
    const hints: ScanHints = m
      ? { number: m[2]!.toUpperCase(), total: m[3]!.toUpperCase(), name: m[1] || undefined, nameText: m[1] || undefined }
      : { name: q, nameText: q };
    return (await this.identify(hints)).map((c) => c.card);
  },

  async sets() {
    try {
      return await ptcgSets();
    } catch (e) {
      console.warn('pokemontcg.io sets failed, using TCGdex', e);
      return dexSets();
    }
  },

  setCards(set) {
    return set.id.startsWith('dex:') ? dexSetCards(set.id.slice(4)) : ptcgSetCards(set.id);
  },
};
