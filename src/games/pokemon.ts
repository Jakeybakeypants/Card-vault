import { parsePokemon, REGIONS } from '../scan/parse';
import type { Candidate, CardPrinting, CardSet, ScanHints } from '../types';
import { levenshtein, normalize, partialSimilarity, sameCollectorNumber, stripLeadingZeros } from '../util/text';
import { settings } from '../util/settings';
import { NAME_SUFFIX, rank, weightedScore, type Game } from './game';
import { getJson, getJsonOrNull, qs } from './http';
import { classicPrintedNumber, namesSet, numberPrefix, pokemonSet, promoCodeDoubtful, promoSet, sameTotal, setsForCode, totalDigits } from './pokemonSetIndex';
import { dexByName, dexByNumber, dexCardWithMarket, dexPromo, dexSetCards, dexSets, setIdOf, type DexCardmarket } from './tcgdex';
import { eurToUsd } from './fx';

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
export const POKEMON_VARIANTS = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', '1st Edition Holofoil', 'Unlimited', 'Unlimited Holofoil'];

function fromPtcg(c: PtcgCard): CardPrinting {
  const prices: Record<string, number> = {};
  for (const [k, p] of Object.entries(c.tcgplayer?.prices ?? {})) {
    const v = p?.market ?? p?.mid;
    if (v != null && v > 0) prices[VARIANT_LABELS[k] ?? k] = v;
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
    variants: ptcgVariants(priced, c.rarity),
    releaseDate: c.set.releaseDate?.replace(/\//g, '-'),
    url: c.tcgplayer?.url,
    details,
    source: 'pokemontcg.io',
  };
}

const holoRarity = (rarity?: string): boolean => /holo|rare|ex|gx|v\b|vmax|vstar/i.test(rarity ?? '');

function defaultVariants(rarity?: string): string[] {
  return holoRarity(rarity) ? ['Holofoil', 'Reverse Holofoil', 'Normal'] : ['Normal', 'Reverse Holofoil', 'Holofoil'];
}

/**
 * Finishes for a pokemontcg.io card, ordered like `dexVariants`: the plain finish first (holofoil
 * when that is what TCGplayer sells, or the rarity says so), then reverse holo, then 1st Edition.
 * TCGplayer's price keys alone would list whatever happens to be priced, in its order: a card
 * priced only as reverse holo still exists as Normal, and a WotC-era card priced as "1st Edition
 * Holofoil" / "Unlimited Holofoil" must default to Unlimited, not the stamped printing.
 */
export function ptcgVariants(priced: string[], rarity?: string): string[] {
  const wotc = priced.some((p) => p.startsWith('Unlimited') || p.startsWith('1st Edition'));
  const pool = new Set(wotc ? priced : [...priced, ...defaultVariants(rarity)]);
  const N = pool.has('Unlimited') ? 'Unlimited' : 'Normal';
  const H = pool.has('Unlimited Holofoil') ? 'Unlimited Holofoil' : 'Holofoil';
  // Never both "Normal" and "Unlimited": they are the same physical card.
  if (N !== 'Normal') pool.delete('Normal');
  if (H !== 'Holofoil') pool.delete('Holofoil');
  const holoFirst = priced.includes(H) || (!priced.includes(N) && holoRarity(rarity));
  const order = holoFirst ? [H, N, 'Reverse Holofoil', '1st Edition Holofoil', '1st Edition'] : [N, H, 'Reverse Holofoil', '1st Edition', '1st Edition Holofoil'];
  return [...order.filter((v) => pool.has(v)), ...[...pool].filter((v) => !order.includes(v))];
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

/** The collector line as printed on the card: Classic Collection reprints print their original one. */
function printedNumber(card: CardPrinting): [num: string | undefined, total: string | undefined] {
  const classic = classicPrintedNumber(card.key);
  if (classic) return [classic.number, classic.total || undefined];
  const [num, total] = card.number.split('/');
  return [num, total];
}

/**
 * Does the printed set code (or promo prefix) read off the card name this card's set? 1 / 0, or
 * undefined when nothing usable was read: a code no known set has (misread, or a set newer than
 * the table) only counts when it agrees, and a promo code read beside a set size is a misread
 * set code (promos print no size), so it counts for nothing.
 */
function setAgreement(card: CardPrinting, hints: ScanHints): number | undefined {
  const promo = promoSet(hints);
  if (promo) return promoCodeDoubtful(hints) ? undefined : setIdOf(card.key) === promo ? 1 : 0;
  // AI scan names the expansion from its symbol; OCR never sets this.
  if (!hints.setCode) return hints.setName ? (namesSet(card, hints.setName) ? 1 : 0) : undefined;
  const same = normalize(card.setCode) === normalize(hints.setCode);
  const named = setsForCode(hints.setCode, hints.number);
  if (!named.length) return same ? 1 : undefined;
  return same || named.some((s) => s.id === setIdOf(card.key)) ? 1 : 0;
}

/**
 * Set size agreement: 1 / 0, or 0.5 for a size one digit away from the printed one (a misread
 * that happens to name another set holding the same Pokémon at that number must not bury the
 * right card). Promos print no size, so a size read off the card counts against them.
 */
function totalAgreement(card: CardPrinting, hints: ScanHints): number | undefined {
  if (!hints.total) return undefined;
  const [, total] = printedNumber(card);
  if (total !== undefined) {
    if (sameTotal(total, hints.total)) return 1;
    const printed = totalDigits(total);
    return printed && levenshtein(printed, totalDigits(hints.total)) === 1 ? 0.5 : 0;
  }
  // Unknown size (a brand-new set's partial result): leave it out rather than count it wrong.
  return pokemonSet(setIdOf(card.key)) ? 0 : undefined;
}

/**
 * 0–1 name agreement. The mark of a special printing ("ex", "V", "GX"…) is small, stylised foil
 * that OCR usually cannot see, so the name without it, read as a whole word, costs only a
 * little: the plain and the ex printing then end up close, and the photo (the ex art is
 * different) decides between them. Whole words only, or "Mew ex" would read "Mewtwo" as its own.
 */
function nameTerm(cardName: string, text: string, read = text): number {
  const full = partialSimilarity(cardName, text);
  const base = cardName.replace(NAME_SUFFIX, '');
  if (full === 1 || base === cardName) return full;
  const plain = (s: string): string => normalize(s.replace(/['’]/g, ''));
  const b = plain(base);
  // The base name must cover what was read, not be one word of a longer name: "Team Rockets
  // Mewtwo" is not "Mewtwo ex".
  const covers = ` ${plain(text)} `.includes(` ${b} `) && b.length >= 0.6 * plain(read).length;
  return covers ? Math.max(full, 0.97) : full;
}

function numberAgrees(card: CardPrinting, hints: ScanHints): boolean | undefined {
  if (!hints.number) return undefined;
  const [num] = printedNumber(card);
  return !!num && sameCollectorNumber(num, hints.number);
}

/**
 * How well the printing's name matches what was read: the better of the isolated name and the
 * whole name strip (minus the pre-evolution's name, see parsePokemon). The strip keeps a name
 * the isolation got wrong; the isolated name keeps one the strip garbles around it.
 */
function nameMatch(card: CardPrinting, hints: ScanHints): number | undefined {
  const texts = [hints.name, hints.nameText].filter((t): t is string => !!t);
  if (!texts.length) return undefined;
  return Math.max(...texts.map((t) => nameTerm(card.name, t, hints.name ?? t)));
}

function score(card: CardPrinting, hints: ScanHints): number {
  const number = numberAgrees(card, hints);
  return weightedScore([
    [0.5, nameMatch(card, hints)],
    [0.35, number === undefined ? undefined : number ? 1 : 0],
    [0.1, totalAgreement(card, hints)],
    // A set code is printed on Scarlet & Violet cards onwards.
    [0.15, setAgreement(card, hints)],
  ]);
}

/** Which of the scan's signals this printing agrees with, for `isConfident`. */
function signals(card: CardPrinting, hints: ScanHints): Candidate['signals'] {
  const [, total] = printedNumber(card);
  // A promo prefix carried by the number itself (SM78, SWSH120) names the set as well.
  const setRead = !!(hints.total || hints.setCode || hints.setName || promoSet(hints));
  return {
    name: nameMatch(card, hints),
    number: numberAgrees(card, hints),
    set: setRead ? (!!hints.total && sameTotal(total, hints.total)) || setAgreement(card, hints) === 1 : undefined,
  };
}

async function lookupDex(hints: ScanHints): Promise<CardPrinting[]> {
  const jobs: Array<Promise<CardPrinting[]>> = [];
  const promo = promoSet(hints);
  // A promo code read beside a set size ("SVP EN 005/198") is a misread set code: look the
  // number up in the sets of that size as well, without the code.
  const doubtful = promoCodeDoubtful(hints);
  if (hints.number && promo) jobs.push(dexPromo(promo, hints.number));
  if (hints.number && (!promo || doubtful) && (totalDigits(hints.total) || numberPrefix(hints.number) || hints.setCode)) {
    jobs.push(dexByNumber(hints.number, hints.total, doubtful ? undefined : hints.setCode, hints.setName));
  }
  // Search on each plausible name word (three letters is a name: Mew, Muk). OCR often adds a
  // stray letter ("Pikachuz"), and TCGdex matches substrings, so long words are searched by
  // their first six letters.
  const words = [...new Set([hints.name ? longestWord(hints.name) : '', ...(hints.nameCandidates ?? [])].filter((w) => w.length >= 3))];
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

// ---------------------------------------------------------------------------------------------
// Prices TCGdex doesn't have. It takes TCGplayer prices per TCGplayer group (set), and the
// galleries and vaults (Trainer Gallery, Galarian Gallery, Shiny Vault, Classic Collection…) are
// separate groups it doesn't fetch, so those cards come back unpriced.

/** TCGdex set ids that pokemontcg.io spells differently. */
const PTCG_SET_IDS: Record<string, string[]> = { cel25cc: ['cel25c'], '30th': ['me55'], '30th-c': ['me55c'], 'sv10.5b': ['zsv10pt5'], 'sv10.5w': ['rsv10pt5'] };

/**
 * The pokemontcg.io ids a TCGdex set id can correspond to: `sv01` → `sv1`, `sv03.5` → `sv3pt5`,
 * `sm3.5` → `sm35`, `swsh12.5gg` → `swsh12pt5gg`; most older ids are spelled the same.
 */
export function ptcgSetIds(dexSetId: string): string[] {
  const special = PTCG_SET_IDS[dexSetId];
  if (special) return special;
  const m = /^(sv|me)0*(\d.*)$/.exec(dexSetId);
  const base = m ? `${m[1]}${m[2]}` : dexSetId;
  return [...new Set([base, base.replace('.', 'pt'), base.replace('.', '')])];
}

/**
 * The same printing on pokemontcg.io: same number and name, in the same set (by id, or by exact
 * name). A card from a set pokemontcg.io doesn't have gets no twin rather than another set's price.
 */
async function ptcgTwin(card: CardPrinting): Promise<CardPrinting | null> {
  const [num] = card.number.split('/');
  const name = card.name.replace(/["\\]/g, '');
  const setId = setIdOf(card.key);
  const ids = card.source === 'tcgdex' ? ptcgSetIds(setId) : [setId];
  const found = await ptcgQuery(`${numberClause(num!)} name:"${name}"`, 20);
  const pick = found.find((c) => ids.includes(c.set.id)) ?? found.find((c) => normalize(c.set.name) === normalize(card.setName));
  return pick ? fromPtcg(pick) : null;
}

const cents = (v: number): number => Math.round(v * 100) / 100;

/** Cardmarket's trend price (EUR) as USD, for the base finish and the reverse holo. */
async function cardmarketPrices(card: CardPrinting, cm: DexCardmarket | undefined): Promise<Pick<CardPrinting, 'prices' | 'priceSource' | 'pricesUpdatedAt'> | null> {
  if (!cm) return null;
  const base = cm.trend ?? cm.avg30 ?? cm.avg;
  const reverse = cm['trend-holo'] ?? cm['avg30-holo'] ?? cm['avg-holo'];
  if (!base && !reverse) return null;
  const rate = await eurToUsd();
  if (!rate) return null;
  const prices: Record<string, number> = {};
  const baseFinish = card.variants.find((v) => v !== 'Reverse Holofoil') ?? 'Normal';
  if (base) prices[baseFinish] = cents(base * rate);
  if (reverse && card.variants.includes('Reverse Holofoil')) prices['Reverse Holofoil'] = cents(reverse * rate);
  if (!Object.keys(prices).length) return null;
  return {
    prices,
    priceSource: `Cardmarket trend ≈ €${(base ?? reverse)!.toFixed(2)} (converted at $${rate.toFixed(2)}/€)`,
    pricesUpdatedAt: new Date().toISOString(),
  };
}

/** Finish chips named after what is priced: "Normal" reads "Unlimited" when that is the listing. */
function relabelFinishes(variants: string[], prices: Record<string, number>): string[] {
  const map: Record<string, string> = {};
  if ('Unlimited' in prices && !('Normal' in prices)) map.Normal = 'Unlimited';
  if ('Unlimited Holofoil' in prices && !('Holofoil' in prices)) map.Holofoil = 'Unlimited Holofoil';
  return [...new Set(variants.map((v) => map[v] ?? v))];
}

/** TCGplayer via TCGdex, else TCGplayer via pokemontcg.io, else Cardmarket converted to USD. */
async function withFallbackPrices(card: CardPrinting, cardmarket?: DexCardmarket): Promise<CardPrinting> {
  if (card.prices) return card;
  const twin = await ptcgTwin(card).catch(() => null);
  if (twin?.prices) {
    return {
      ...card,
      prices: twin.prices,
      priceSource: twin.priceSource,
      pricesUpdatedAt: twin.pricesUpdatedAt,
      variants: relabelFinishes(card.variants, twin.prices),
      url: card.url?.includes('tcgplayer') ? card.url : (twin.url ?? card.url),
    };
  }
  const cm = await cardmarketPrices(card, cardmarket).catch(() => null);
  return cm ? { ...card, ...cm } : card;
}

function longestWord(name: string): string {
  return name
    .replace(/["\\:()*]/g, ' ')
    .split(/\s+/)
    .sort((a, b) => b.length - a.length)[0] ?? name;
}

/**
 * The number was read and agrees, and so does the set size or the printed set code / promo
 * prefix. Strict: a size that only matches after a one-digit repair is not an exact read.
 */
function exactId(card: CardPrinting, hints: ScanHints): boolean {
  const [, total] = printedNumber(card);
  if (!numberAgrees(card, hints)) return false;
  return (!!hints.total && sameTotal(total, hints.total)) || setAgreement(card, hints) === 1;
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
    return rank(cards.map((card): Candidate => ({ card, score: score(card, hints), signals: signals(card, hints) })));
  },

  async complete(card) {
    if (!card.partial && card.prices) return card;
    const hit = card.source === 'tcgdex' ? await dexCardWithMarket(card.key).catch(() => null) : null;
    if (hit) return withFallbackPrices(hit.card, hit.cardmarket);
    return card.partial ? card : withFallbackPrices(card);
  },

  async refresh(card) {
    if (card.source === 'tcgdex') {
      const hit = await dexCardWithMarket(card.key);
      return hit ? withFallbackPrices(hit.card, hit.cardmarket) : null;
    }
    // Saved from pokemontcg.io: take current prices from the same card in TCGdex (same name,
    // number and set size), keeping the saved identity so the collection row doesn't move.
    const [num, total] = card.number.split('/');
    if (num && total) {
      // Two sets of one size can share a number and a name (Cosmog 100/236 in Unified Minds and
      // Cosmic Eclipse): the twin has to be the same set.
      const twin = (await dexByNumber(num, total).catch(() => [])).find(
        (c) => partialSimilarity(c.name, card.name) > 0.9 && (ptcgSetIds(setIdOf(c.key)).includes(setIdOf(card.key)) || normalize(c.setName) === normalize(card.setName)),
      );
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
