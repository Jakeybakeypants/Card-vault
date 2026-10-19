import { sameCollectorNumber, stripLeadingZeros } from '../util/text';
import { POKEMON_SETS } from './pokemonSets';

/**
 * Which TCGdex sets a printed collector number can belong to. TCGdex's live set list has no
 * set codes or release dates, so this works from the generated table (pokemonSets.ts) and the
 * caller adds any brand-new sets the table doesn't know yet.
 */

export interface PokemonSetInfo {
  id: string;
  name: string;
  /** Printed set size: the number after the slash. */
  official: number;
  /** Printed set code (`SVI`, `PAL`, `BRS:TG`), or '' for older sets that print none. */
  code: string;
  releaseDate: string;
  series: string;
  /** Zero-padding of TCGdex's card ids in this set: 3 for "001", 2 for "TG01", 0 for "1". */
  pad: number;
}

const SETS: PokemonSetInfo[] = POKEMON_SETS.map(([id, name, official, code, releaseDate, series, pad]) => ({ id, name, official, code, releaseDate, series, pad }));
const BY_ID = new Map(SETS.map((s) => [s.id, s]));

export function pokemonSet(id: string): PokemonSetInfo | undefined {
  return BY_ID.get(id);
}

export function allPokemonSets(): readonly PokemonSetInfo[] {
  return SETS;
}

/** Black Star promo prefixes as printed (`SWSH050`, `SVP EN 085`) → TCGdex set. */
export const PROMO_SETS: Record<string, string> = {
  SVP: 'svp',
  MEP: 'mep',
  SWSH: 'swshp',
  SM: 'smp',
  XY: 'xyp',
  BW: 'bwp',
  HGSS: 'hgssp',
  DP: 'dpp',
};

/**
 * A promo code read beside a printed set size ("SVP EN 005/198") is almost certainly a misread
 * set code: SVI, SVE and SVP (MEG and MEP) are one letter apart, and promos print no size. The
 * number itself naming a promo set ("SWSH050") is never in doubt.
 */
export function promoCodeDoubtful(hints: { number?: string; setCode?: string; total?: string }): boolean {
  return !PROMO_SETS[numberPrefix(hints.number)] && !!promoSet(hints) && !!totalDigits(hints.total);
}

/**
 * Celebrations Classic Collection (cel25cc, 2021): 25 historic cards reprinted with their
 * original collector line ("4/102" on the Charizard) and no CC number anywhere on the card.
 * TCGdex files them as CC001–CC025, so a scan can only reach them through this table:
 * TCGdex id → [number, set size] as printed. The card files in tcgdex/cards-database carry no
 * original number, hence a static table: numbers from the cards (as pokemontcg.io lists them
 * for cel25c), set sizes cross-checked against the original sets in the TCGdex catalog.
 * CC008 (Birthday Pikachu) reprints a Wizards Black Star promo, which prints "24" and no size.
 */
export const CLASSIC_COLLECTION: Record<string, [number: string, total: string]> = {
  CC001: ['2', '102'], // Blastoise, Base Set
  CC002: ['4', '102'], // Charizard, Base Set
  CC003: ['15', '102'], // Venusaur, Base Set
  CC004: ['73', '102'], // Imposter Professor Oak, Base Set
  CC005: ['8', '82'], // Dark Gyarados, Team Rocket
  CC006: ['15', '82'], // Here Comes Team Rocket!, Team Rocket
  CC007: ['15', '132'], // Rocket's Zapdos, Gym Challenge
  CC008: ['24', ''], // _____'s Pikachu, Wizards Black Star Promo 24
  CC009: ['20', '111'], // Cleffa, Neo Genesis
  CC010: ['66', '64'], // Shining Magikarp, Neo Revelation
  CC011: ['9', '95'], // Team Magma's Groudon, Team Magma vs Team Aqua
  CC012: ['86', '109'], // Rocket's Admin., Team Rocket Returns
  CC013: ['88', '92'], // Mew ex, Legend Maker
  CC014: ['93', '101'], // Gardevoir ex δ, Dragon Frontiers
  CC015: ['17', '17'], // Umbreon ☆, POP Series 5
  CC016: ['15', '106'], // Claydol, Great Encounters
  CC017: ['109', '111'], // Luxray GL LV.X, Rising Rivals
  CC018: ['145', '147'], // Garchomp C LV.X, Supreme Victors
  CC019: ['107', '123'], // Donphan (Prime), HeartGold & SoulSilver
  CC020: ['113', '114'], // Reshiram, Black & White
  CC021: ['114', '114'], // Zekrom, Black & White
  CC022: ['54', '99'], // Mewtwo EX, Next Destinies
  CC023: ['97', '146'], // Xerneas EX, XY
  CC024: ['76', '108'], // M Rayquaza EX, Roaring Skies
  CC025: ['60', '145'], // Tapu Lele GX, Guardians Rising
};
export const CLASSIC_COLLECTION_SET = 'cel25cc';

/** The collector line printed on a Classic Collection reprint, or undefined for any other card. */
export function classicPrintedNumber(cardKey: string): { number: string; total: string } | undefined {
  if (!cardKey.startsWith(`${CLASSIC_COLLECTION_SET}-`)) return undefined;
  const row = CLASSIC_COLLECTION[cardKey.slice(CLASSIC_COLLECTION_SET.length + 1).toUpperCase()];
  return row ? { number: row[0], total: row[1] } : undefined;
}

/** Classic Collection ids whose printed line is this number and size: "4" + "102" → ["CC002"]. */
export function classicReprints(number: string | undefined, total: string | undefined): string[] {
  const size = totalDigits(total);
  if (!number || !size) return [];
  return Object.entries(CLASSIC_COLLECTION)
    .filter(([, [n, t]]) => t === size && sameCollectorNumber(n, number))
    .map(([id]) => id);
}

/** Letters printed in front of a subset number: TG05/TG30, GG01/GG70, SV001/SV122, RC5/RC25. */
export function numberPrefix(n: string | undefined): string {
  return /^([A-Z]+)\d/i.exec(n ?? '')?.[1]?.toUpperCase() ?? '';
}

/** "TG30" → "30", "198" → "198", "030" → "30". */
export function totalDigits(total: string | undefined): string {
  const digits = (total ?? '').replace(/^[A-Z]+/i, '');
  return /^\d+$/.test(digits) ? stripLeadingZeros(digits) : '';
}

// Subsets that TCGdex files as sets of their own, recognised by id; RC cards live inside their
// main set (Legendary Treasures, Generations).
const SUBSET_SETS: Record<string, (s: PokemonSetInfo) => boolean> = {
  TG: (s) => s.id.endsWith('tg'),
  GG: (s) => s.id.endsWith('gg'),
  SV: (s) => s.id.endsWith('sv') || s.id === 'sma',
  RC: (s) => s.id === 'bw11' || s.id === 'g1' || s.id === 'rc',
  CC: (s) => s.id.endsWith('cc'),
};
const RC_TOTALS: Record<string, string[]> = { '25': ['bw11', 'rc'], '32': ['g1'] };

function codeBase(code: string): string {
  return code.split(':')[0]!.toUpperCase();
}

/**
 * Candidate sets for a printed number, most likely first:
 * 1. the printed set code (`SVI`, `BRS` + a TG number → `BRS:TG`), when it names a known set;
 * 2. otherwise every set of the printed size, newest first, restricted to the subset family when
 *    the number has a prefix (TG/GG/SV/RC).
 */
export function candidateSets(hints: { number?: string; total?: string; setCode?: string; setName?: string }): PokemonSetInfo[] {
  const sets = candidateSetsUnordered(hints);
  // A set name told by AI scan ("Brilliant Stars" → the Brilliant Stars Trainer Gallery) goes first.
  return hints.setName ? [...sets.filter((s) => namesSet(s, hints.setName!)), ...sets.filter((s) => !namesSet(s, hints.setName!))] : sets;
}

/** "Brilliant Stars" names "Brilliant Stars" and its "Brilliant Stars Trainer Gallery". */
export function namesSet(set: { name: string }, setName: string): boolean {
  const a = set.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const b = setName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !!b && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `));
}

function candidateSetsUnordered(hints: { number?: string; total?: string; setCode?: string }): PokemonSetInfo[] {
  const prefix = numberPrefix(hints.number) || numberPrefix(hints.total);
  const size = totalDigits(hints.total);
  const subset = SUBSET_SETS[prefix];

  const byCode = setsForCode(hints.setCode, hints.number);
  if (byCode.length) return byCode;

  if (prefix === 'RC' && size && RC_TOTALS[size]) return RC_TOTALS[size].map((id) => BY_ID.get(id)!).filter(Boolean);
  const family = subset ? SETS.filter(subset) : SETS;
  if (!size) return subset ? family : [];
  const ofSize = (n: string) => family.filter((s) => String(s.official) === n);
  let sameSize = ofSize(size);
  // No set of the family prints that size: one digit was misread. Try the repairs, most likely first.
  if (!sameSize.length) sameSize = repairedSizes(size, new Set(family.map((s) => String(s.official)))).flatMap(ofSize);
  if (subset) return sameSize;
  // Plain numbers: main sets before galleries and promos that happen to share the size.
  return [...sameSize.filter((s) => !s.code.includes(':')), ...sameSize.filter((s) => s.code.includes(':'))];
}

/**
 * Printed sizes one OCR slip away from a misread one: a stray digit read behind or in front
 * ("1982" → "198", "0198" → "198"), then one digit wrong, last digit first ("190" → "191"…
 * "198" before "100"…). Only sizes some set actually prints, in that order.
 */
export function repairedSizes(size: string, printed: Set<string>): string[] {
  const out: string[] = [];
  const add = (s: string): void => {
    const n = stripLeadingZeros(s);
    if (n && n !== size && printed.has(n) && !out.includes(n)) out.push(n);
  };
  if (size.length > 2) {
    add(size.slice(0, -1));
    add(size.slice(1));
  }
  for (let i = size.length - 1; i >= 0; i--) for (const d of '0123456789') if (d !== size[i]) add(size.slice(0, i) + d + size.slice(i + 1));
  return out;
}

/** The sets a printed set code names (`SVI` → sv01; `BRS` + a TG number → the Trainer Gallery). */
export function setsForCode(setCode: string | undefined, number?: string): PokemonSetInfo[] {
  const code = setCode?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return [];
  const prefix = numberPrefix(number);
  const subset = SUBSET_SETS[prefix];
  const byCode = SETS.filter((s) => s.code && codeBase(s.code) === code);
  // A main set and its gallery share a code (BRS, BRS:TG): the number's prefix picks one.
  const narrowed = byCode.filter((s) => (subset ? subset(s) || s.code.endsWith(`:${prefix}`) : !s.code.includes(':')));
  return narrowed.length ? narrowed : byCode;
}

/** The promo set a number belongs to: `SWSH050` → swshp, or the `SVP` set code read beside it. */
export function promoSet(hints: { number?: string; setCode?: string }): string | undefined {
  const prefix = numberPrefix(hints.number);
  if (prefix && PROMO_SETS[prefix]) return PROMO_SETS[prefix];
  const code = hints.setCode?.toUpperCase();
  return code ? PROMO_SETS[code] : undefined;
}

/** The card id TCGdex uses for a printed number in a known set: "25" → "025" in sv01. */
export function localIdIn(set: PokemonSetInfo, n: string): string {
  const m = /^([A-Z]*)0*(\d+)([a-z]?)$/i.exec(n.trim());
  if (!m) return n;
  // Promo prefixes are part of the id in swshp/smp ("SWSH050"), not in svp/mep ("085").
  const pre = set.id === 'svp' || set.id === 'mep' ? '' : m[1]!.toUpperCase();
  return `${pre}${m[2]!.padStart(set.pad, '0')}${m[3]}`;
}

/**
 * The spellings a number may have in TCGdex: as read, without leading zeros, and zero-padded to
 * 2 and 3 digits ("4", "04", "004"; "TG5", "TG05"; "SWSH50", "SWSH050").
 */
export function localIdForms(n: string): string[] {
  const m = /^([A-Z]*)0*(\d+)([a-z]?)$/i.exec(n.trim());
  if (!m) return [n];
  const [, pre, digits, suf] = m as unknown as [string, string, string, string];
  return [...new Set([n, `${pre}${digits}${suf}`, `${pre}${digits.padStart(2, '0')}${suf}`, `${pre}${digits.padStart(3, '0')}${suf}`])];
}

/** Same number regardless of padding or a subset prefix on one side only ("TG30" vs "30"). */
export function sameTotal(a: string | undefined, b: string | undefined): boolean {
  const x = totalDigits(a);
  return !!x && x === totalDigits(b);
}
