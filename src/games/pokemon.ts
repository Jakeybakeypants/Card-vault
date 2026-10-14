import { parsePokemon, REGIONS } from '../scan/parse';
import type { Candidate, CardPrinting, CardSet, ScanHints } from '../types';
import { normalize, partialSimilarity, sameCollectorNumber, stripLeadingZeros } from '../util/text';
import { settings } from '../util/settings';
import { rank, weightedScore, type Game } from './game';
import { getJson, getJsonOrNull, qs } from './http';
import { dexByName, dexByNumber, dexCard, dexSetCards, dexSets } from './tcgdex';

// ---------------------------------------------------------------------------------------------
// Catalogs. TCGdex (tcgdex.ts) is primary: free, maintained, and priced per printing.
// pokemontcg.io v2 is the fallback when TCGdex is unreachable or finds nothing. Its free price
// data is limited and it is being wound down in favour of the paid Scrydex service.
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
    priceSource: priced.length ? 'TCGplayer market (via pokemontcg.io)' : undefined,
    pricesUpdatedAt: priced.length ? new Date().toISOString() : undefined,
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

/** Set list from pokemontcg.io, for the binder when TCGdex is down. Ids are prefixed `ptcg:`. */
async function ptcgSets(): Promise<CardSet[]> {
  const res = await getJson<{ data: PtcgSet[] }>(`https://api.pokemontcg.io/v2/sets?${qs({ orderBy: '-releaseDate', pageSize: 250 })}`, { headers: ptcgHeaders(), timeoutMs: 20000 });
  return res.data.map((s) => ({
    game: 'pokemon',
    id: `ptcg:${s.id}`,
    name: s.name,
    code: s.ptcgoCode ?? s.id.toUpperCase(),
    total: s.total,
    releaseDate: s.releaseDate.replace(/\//g, '-'),
    series: s.series,
    logo: s.images.logo,
  }));
}

/** All cards in a pokemontcg.io set, a page (max 250) at a time. */
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

function score(card: CardPrinting, hints: ScanHints): number {
  const [num, total] = card.number.split('/');
  const nameText = hints.nameText || hints.name;
  const setMatch = hints.setCode && normalize(card.setCode) === normalize(hints.setCode);
  return weightedScore([
    [0.5, nameText ? partialSimilarity(card.name, nameText) : undefined],
    [0.35, hints.number ? (sameCollectorNumber(num ?? '', hints.number) ? 1 : 0) : undefined],
    // Partial results don't know their set size yet: leave the total out rather than count it wrong.
    [0.1, hints.total && total !== undefined ? (sameCollectorNumber(total, hints.total) ? 1 : 0) : undefined],
    [0.05, setMatch ? 1 : undefined],
  ]);
}

async function lookupDex(hints: ScanHints): Promise<CardPrinting[]> {
  const jobs: Array<Promise<CardPrinting[]>> = [];
  if (hints.number && hints.total && /^\d+$/.test(hints.total)) jobs.push(dexByNumber(hints.number, hints.total));
  // Search on each plausible name word. OCR often adds a stray letter ("Pikachuz"), and TCGdex
  // matches substrings, so long words are searched by their first six letters.
  const words = [...new Set([hints.name ? longestWord(hints.name) : '', ...(hints.nameCandidates ?? [])].filter((w) => w.length >= 4))];
  for (const w of words.slice(0, 3)) jobs.push(dexByName(w.length > 6 ? w.slice(0, 6) : w, hints.number));
  const settled = await Promise.allSettled(jobs);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  const cards = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!cards.length && failed) throw failed.reason;
  return cards;
}

async function lookupPtcg(hints: ScanHints): Promise<CardPrinting[]> {
  const queries: string[] = [];
  if (hints.number) {
    const totalIsPlain = hints.total && /^\d+$/.test(hints.total);
    if (totalIsPlain) queries.push(`${numberClause(hints.number)} set.printedTotal:${stripLeadingZeros(hints.total!)}`);
    if (hints.setCode) queries.push(`${numberClause(hints.number)} set.ptcgoCode:${hints.setCode}`);
    if (hints.name) queries.push(`${numberClause(hints.number)} ${nameClause(hints.name)}`);
    if (!totalIsPlain && !hints.name) queries.push(numberClause(hints.number));
  }
  if (hints.name) queries.push(nameClause(hints.name));
  const results = await Promise.all(
    queries.map((q) =>
      ptcgQuery(q).catch((e: unknown) => {
        console.warn('pokemontcg.io query failed', q, e);
        return [] as PtcgCard[];
      }),
    ),
  );
  return results.flat().map(fromPtcg);
}

async function lookup(hints: ScanHints): Promise<CardPrinting[]> {
  try {
    const cards = await lookupDex(hints);
    if (cards.length) return cards;
  } catch (e) {
    console.warn('TCGdex failed, trying pokemontcg.io', e);
  }
  return lookupPtcg(hints);
}

function longestWord(name: string): string {
  return name
    .replace(/["\\:()*]/g, ' ')
    .split(/\s+/)
    .sort((a, b) => b.length - a.length)[0] ?? name;
}

function exactId(card: CardPrinting, hints: ScanHints): boolean {
  const [num, total] = card.number.split('/');
  return !!hints.number && !!hints.total && !!num && !!total && sameCollectorNumber(num, hints.number) && sameCollectorNumber(total, hints.total);
}

export const pokemon: Game = {
  id: 'pokemon',
  name: 'Pokémon',
  regions: REGIONS.pokemon,
  parse: parsePokemon,

  score,
  exactId,

  async identify(hints) {
    const cards = await lookup(hints);
    return rank(cards.map((card): Candidate => ({ card, score: score(card, hints) })));
  },

  async complete(card) {
    if (!card.partial) return card;
    return (await dexCard(card.key)) ?? card;
  },

  async refresh(card) {
    if (card.source === 'tcgdex') return dexCard(card.key);
    // Saved from pokemontcg.io: take current prices from the same card in TCGdex (same name,
    // number and set size), keeping the saved identity so the collection row doesn't move.
    const [num, total] = card.number.split('/');
    if (num && total) {
      const twin = (await dexByNumber(num, total).catch(() => [])).find((c) => partialSimilarity(c.name, card.name) > 0.9);
      if (twin?.prices) return { ...card, prices: twin.prices, priceSource: twin.priceSource, pricesUpdatedAt: twin.pricesUpdatedAt, variants: twin.variants };
    }
    const res = await getJsonOrNull<{ data: PtcgCard }>(`${PTCG}/${encodeURIComponent(card.key)}`).catch(() => null);
    return res ? fromPtcg(res.data) : null;
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
      return await dexSets();
    } catch (e) {
      console.warn('TCGdex sets failed, using pokemontcg.io', e);
      return ptcgSets();
    }
  },

  setCards(set) {
    return set.id.startsWith('ptcg:') ? ptcgSetCards(set.id.slice(5)) : dexSetCards(set.id);
  },
};
