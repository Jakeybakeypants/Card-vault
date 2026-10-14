import { stripLeadingZeros } from '../util/text';
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
  if (!size) return subset ? SETS.filter(subset) : [];
  const sameSize = SETS.filter((s) => String(s.official) === size);
  if (subset) return sameSize.filter(subset);
  // Plain numbers: main sets before galleries and promos that happen to share the size.
  return [...sameSize.filter((s) => !s.code.includes(':')), ...sameSize.filter((s) => s.code.includes(':'))];
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
