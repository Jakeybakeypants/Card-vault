import type { GameId, ScanHints } from '../types';
import { levenshtein } from '../util/text';
import { allPokemonSets, setsForCode, totalDigits } from '../games/pokemonSetIndex';

/**
 * A strip of the card image to OCR, in fractions of its width/height. Bands are generous: the
 * image may carry a small margin around the card, or be a slightly off-centre photo.
 */
export interface Region {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pokémon, Magic and Lorcana cards are 63×88 mm, Yu-Gi-Oh! 59×86 mm. Close enough to share a frame. */
export const CARD_ASPECT = 63 / 88;

/**
 * Where Trainer and Energy names sit: under the TRAINER / ENERGY banner, at 10–24% of the card
 * height (Bill, Max Revive, Energy Retrieval), below the strip that holds a Pokémon's name.
 */
export const POKEMON_NAME_LOWER: Region = { key: 'name', x: 0.02, y: 0.1, w: 0.96, h: 0.14 };

export const REGIONS: Record<GameId, Region[]> = {
  pokemon: [
    // Stage + name + HP. Name sits top-left, HP top-right.
    { key: 'name', x: 0.02, y: 0.0, w: 0.96, h: 0.13 },
    // Regulation mark, set code, collector number, illustrator. Modern cards print the number
    // bottom-left, older ones bottom-right, so take the full width.
    { key: 'bottom', x: 0.0, y: 0.83, w: 1.0, h: 0.17 },
  ],
  yugioh: [
    // Name banner, stopping short of the attribute icon.
    { key: 'name', x: 0.03, y: 0.01, w: 0.82, h: 0.12 },
    // Just under the artwork: set code on the right, "1st Edition" on the left.
    { key: 'middle', x: 0.0, y: 0.67, w: 1.0, h: 0.13 },
    // Passcode bottom-left, and the set code on Pendulum cards.
    { key: 'bottom', x: 0.0, y: 0.85, w: 1.0, h: 0.15 },
  ],
  mtg: [
    // Name top-left, stopping before the mana cost.
    { key: 'name', x: 0.02, y: 0.0, w: 0.76, h: 0.11 },
    // Collector number, rarity, set code and language, bottom-left: "0123 R / M21 • EN".
    { key: 'bottom', x: 0.0, y: 0.86, w: 1.0, h: 0.14 },
  ],
  lorcana: [
    // Name and version sit in the banner across the middle of the card.
    { key: 'name', x: 0.02, y: 0.48, w: 0.96, h: 0.2 },
    // "12/204 • EN • 1": collector number / set size, language, set number.
    { key: 'bottom', x: 0.0, y: 0.88, w: 1.0, h: 0.12 },
  ],
};

// OCR commonly confuses these with digits inside numeric runs.
const DIGIT_FIXES: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };
const DIGITISH = '[0-9OoDQIli|SsBZzG]';
const DIGITISH_RUN = new RegExp(`^${DIGITISH}+$`);

function toDigits(s: string): string {
  return s.replace(/[^0-9]/g, (c) => DIGIT_FIXES[c] ?? c);
}

// Subset prefixes printed in front of collector numbers: Trainer Gallery, Galarian Gallery,
// Radiant Collection, Shiny Vault, Shiny (Hidden Fates), Classic Collection, and Holo (Crystal
// Guardians era: H1–H12, never more than two digits).
const POKEMON_SUBSET_PREFIXES = ['TG', 'GG', 'RC', 'SV', 'SH', 'CC', 'H'];
// How OCR garbles the letters of those prefixes ("5v122", "T630", "1607/1630", "6669/6670").
const PREFIX_FIXES: Record<string, string> = { '5': 'S', '6': 'G', '1': 'T', '7': 'T' };

/** The subset prefix a run of letters/digits stands for, or undefined when it is none. */
function subsetPrefix(raw: string, digits: string): string | undefined {
  if (!raw) return undefined;
  const p = raw
    .toUpperCase()
    .split('')
    .map((c) => PREFIX_FIXES[c] ?? c)
    .join('');
  if (!POKEMON_SUBSET_PREFIXES.includes(p)) return undefined;
  if (p === 'H' && digits.length > 2) return undefined;
  return p;
}

interface NumberParts {
  prefix: string;
  digits: string;
  suffix: string;
  /** How likely this reading is; the pair that is also a printed number/size wins. */
  rank: number;
}

/**
 * The readings of a token that stands where a collector number or set size is printed ("063",
 * "TG0S", "5v122", "V085", "G063", "H5", "28a", "1l", "4166"), best first: subset prefix, digits
 * and variant suffix. Letters in front that are not a subset prefix (a glued regulation mark D–I,
 * the V of "V rule") are dropped, and never run through the digit fixes ("G063" is 63, not
 * 6063). Only a/b are printed suffixes (28a): any other trailing letter is a misread digit.
 * `maxDigits` is 3 for a number and 4 for a size (a stray digit from the rarity symbol is sorted
 * out by repairSize). `want` is the other side's subset prefix, which the size should share.
 */
function numberSplits(token: string, maxDigits: number, want?: string): NumberParts[] {
  const isTotal = maxDigits > 3;
  let suffix = '';
  let body = token;
  if (!isTotal && /[ab]$/.test(body) && body.length > 1) {
    suffix = body.slice(-1);
    body = body.slice(0, -1);
  }
  // A glyph after the size read as a letter: "GG70R", "102R".
  body = body.replace(/[^0-9OoDQIli|SsBZzG]+$/, '');
  const out: NumberParts[] = [];
  for (let k = 0; k <= Math.min(3, body.length - 1); k++) {
    const pre = body.slice(0, k);
    const rest = body.slice(k);
    if (!DIGITISH_RUN.test(rest)) continue;
    if (rest.length > maxDigits) {
      // "4166" for 166: the strip read a glyph next to the number as a digit.
      if (!pre && !isTotal && /^\d+$/.test(rest)) out.push({ prefix: '', digits: rest.slice(-3), suffix, rank: 1 }, { prefix: '', digits: rest.slice(0, 3), suffix, rank: 0 });
      continue;
    }
    if (isTotal && rest.length < 2) continue;
    const digits = toDigits(rest);
    const subset = subsetPrefix(pre, digits);
    if (!pre) out.push({ prefix: '', digits, suffix, rank: want ? 3 : 5 });
    else if (subset && /^[A-Za-z]+$/.test(pre)) out.push({ prefix: subset, digits, suffix, rank: want && want !== subset ? 2 : 6 });
    else if (subset && want === subset) out.push({ prefix: subset, digits, suffix, rank: 4 });
    // "5v122", "T630": a prefix with a letter left in it. "1607": digits only, so only when the
    // token cannot be a plain number (one "16" in "165/132" is not a Trainer Gallery number).
    else if (subset && (/[A-Za-z]/.test(pre) || body.length > maxDigits)) out.push({ prefix: subset, digits, suffix, rank: 2 });
    else if (!isTotal && /^[A-Z]{1,2}$/.test(pre)) out.push({ prefix: '', digits, suffix, rank: 1 });
  }
  return out.sort((a, b) => b.rank - a.rank);
}

const PRINTED_SIZES = new Set(allPokemonSets().map((s) => s.official));
// Sizes this small are trainer kits and McDonald's sets; a smaller "size" is junk.
const MIN_SIZE = 10;

/**
 * A size read with a stray digit from the rarity symbol next to it ("42/1140", "1/834"): cut it
 * back to the printed size it contains. Returns undefined when no printed size fits.
 */
function repairSize(digits: string, number: number): string | undefined {
  const fits = (t: string): boolean => PRINTED_SIZES.has(Number(t)) && Number(t) >= MIN_SIZE && number <= 3 * Number(t);
  if (digits.length < 3 || (digits.length === 3 && fits(digits))) return digits;
  if (digits.length === 4) {
    const head = digits.slice(0, 3);
    const tail = digits.slice(1);
    // Both fit ("1102"): a leading 1 is the separator read as a digit, unless the rest starts
    // with a 0 ("1020"), which no size does.
    if (fits(head) && fits(tail)) return digits.startsWith('1') && !tail.startsWith('0') ? tail : head;
    return fits(head) ? head : fits(tail) ? tail : undefined;
  }
  // "834": a 3-digit size no set has, but its first two digits are a set of a plausible size.
  const head = digits.slice(0, 2);
  if (number < 100 && Number(head) >= 30 && fits(head)) return head;
  return digits;
}

interface NumberRead {
  index: number;
  number: string;
  total?: string;
  plausible: boolean;
  slash: boolean;
}

/**
 * The number and size pair a "NN/SSS" match in the bottom strip stands for, if any: the readings
 * that make a printed number first, among those the one that is not a secret rare (a stray
 * digit on the number is far more often in front of it than behind), then the best-ranked. When
 * no reading makes a printed size (a set newer than the table), the plain digits as read stand,
 * but not a reading that needed letters turned into a prefix or dropped.
 */
function readNumberPair(m: RegExpMatchArray): NumberRead | undefined {
  const base = { index: m.index!, slash: m[0].includes('/') };
  const combos: Array<NumberRead & { rank: number; fallback: boolean }> = [];
  for (const n of numberSplits(m[1]!, 3)) {
    for (const t of numberSplits(m[2]!, 4, n.prefix || undefined)) {
      // A subset number has the same prefix on both sides: TG05/TG30, SV107/SV122. One side's
      // prefix is enough ("81/5v94").
      const prefix = n.prefix || t.prefix;
      if (prefix && t.digits.length > 3) continue;
      const size = prefix ? t.digits : repairSize(t.digits, Number(n.digits));
      if (size === undefined) continue;
      const read = { ...base, number: prefix + n.digits + n.suffix, total: prefix + size, plausible: false };
      read.plausible = plausibleNumber(read);
      // A digit run too long for a number ("4166", "1157"): the stray digit is more often in
      // front (a glyph before the number) than behind, unless dropping it makes a secret rare.
      const secret = Number(n.digits) > Number(size);
      const nRank = n.rank <= 1 ? (secret ? 0 : 2) + n.rank : n.rank + 2;
      // Sizes under 30 are all in the table, so an unknown one that small is junk.
      combos.push({ ...read, rank: nRank * 10 + t.rank, fallback: n.rank >= 5 && t.rank >= 3 && t.rank !== 4 && Number(size) >= 30 });
    }
  }
  combos.sort((a, b) => Number(b.plausible) - Number(a.plausible) || b.rank - a.rank);
  const pick = combos.find((c) => c.plausible || c.fallback);
  if (pick) return { index: pick.index, slash: pick.slash, number: pick.number, total: pick.total, plausible: pick.plausible };
  // A plain number beside a size read as junk digits ("69/13", "218/001"): the number stands on
  // its own, below any pair, so a close second look has to agree with it rather than replace it.
  if (/^\d{1,3}[ab]?$/.test(m[1]!) && /^\d+$/.test(m[2]!) && Number(m[1]!.replace(/[ab]$/, '')) > 0) return { ...base, number: m[1]!, plausible: false };
  return undefined;
}

const POKEMON_LANGUAGES = new Set(['EN', 'DE', 'FR', 'IT', 'ES', 'PT', 'JP', 'KR']);

const POKEMON_PROMO_PREFIXES = ['SWSH', 'HGSS', 'SVP', 'MEP', 'SM', 'XY', 'BW', 'DP', 'SV'];

// Set codes are printed from Scarlet & Violet on; earlier sets' codes are never on the card.
const PRINTED_CODES_FROM = '2023-01-01';
// OCR slips in a set code, as alternatives per character.
const CODE_FIXES: Record<string, string[]> = { l: ['I', 'L'], '1': ['I', 'L'], I: ['I', 'L'], '0': ['O'], O: ['O', '0'], '5': ['S'], S: ['S', '5'], '8': ['B'], B: ['B', '8'], '2': ['Z'], '6': ['G'] };

/**
 * The printed set code a run of characters before the number stands for ("SVI", "GSVI" with the
 * regulation mark glued on, "SVl", "PAl", "SV1", "0BF", "svi"), validated against the set table:
 * only a code that names a set is returned. Repairs beyond uppercasing are trusted only when the
 * language that follows the code on the card was read too, so junk on older cards does not turn
 * into a code.
 */
export function fixSetCode(raw: string, number?: string, hasLanguage = true): string | undefined {
  const names = (code: string): boolean => setsForCode(code, number).some((s) => s.releaseDate >= PRINTED_CODES_FROM);
  const upper = raw.toUpperCase();
  if (names(upper)) return upper;
  if (!hasLanguage) return undefined;
  const bodies = upper.length >= 4 && /^[D-I]/.test(upper) ? [raw.slice(1), raw] : [raw];
  for (const body of bodies) {
    // Every combination of the per-character alternatives, fewest changes first.
    let forms: Array<{ code: string; changes: number }> = [{ code: '', changes: 0 }];
    for (const c of body) {
      const alts = CODE_FIXES[c] ?? [c.toUpperCase()];
      forms = forms.flatMap((f) => alts.map((a) => ({ code: f.code + a, changes: f.changes + (a === c.toUpperCase() ? 0 : 1) })));
    }
    const hit = forms.sort((a, b) => a.changes - b.changes).find((f) => names(f.code));
    if (hit) return hit.code;
  }
  return undefined;
}

/** Number and size that could be printed on a card: subset prefix + digits, size a printed one. */
export function plausibleNumber(h: { number?: string; total?: string }): boolean {
  const m = /^([A-Z]*)(\d{1,3})[ab]?$/.exec(h.number ?? '');
  if (!m) return false;
  const [, prefix, digits] = m as unknown as [string, string, string];
  if (prefix && !POKEMON_SUBSET_PREFIXES.includes(prefix) && !POKEMON_PROMO_PREFIXES.includes(prefix)) return false;
  const n = Number(digits);
  if (!(n > 0)) return false;
  if (!h.total) return true;
  const size = Number(totalDigits(h.total));
  return PRINTED_SIZES.has(size) && size >= MIN_SIZE && n <= 3 * size;
}

/**
 * The number and size to keep after the close second look at the number word. The second look
 * sees the glyphs next to the number too (regulation mark, "V rule", rarity symbol) and returns
 * them glued on ("187/202" → "V187/202", "1/83" → "1/834"), and its crop can cut the size off.
 * It is only taken when it is at least as plausible as the strip read, and when both are, only
 * when it agrees with the strip's digits or extends them ("14" → "114", "5a" → "54"); the strip
 * read's subset prefix stands, since the second look often drops it. `closerText` is the text
 * of the second look, to tell a size it read cleanly from one it cut a stray digit off.
 */
export function mergeSecondLook(first: { number?: string; total?: string }, closer: { number?: string; total?: string }, closerText = ''): { number?: string; total?: string } {
  const pick = (h: { number?: string; total?: string }) => ({ number: h.number, total: h.total });
  if (!closer.number) return pick(first);
  if (!first.number) return pick(closer);
  const a = plausibleNumber(first);
  const b = plausibleNumber(closer);
  if (a !== b) return pick(b ? closer : first);
  if (!a) return pick(closer);
  const prefix = (n: string): string => /^[A-Z]*/.exec(n)![0];
  // The whitelist of the second look drops a subset prefix's letters as often as it keeps them.
  if (prefix(first.number) && !prefix(closer.number)) return pick(first);
  const digits = (n: string): string => n.replace(/^[A-Z]+/, '').replace(/[ab]$/, '').replace(/^0+/, '');
  const x = digits(first.number);
  const y = digits(closer.number);
  const extends_ = (y.length > x.length && y.endsWith(x)) || (/[ab]$/.test(first.number) && y.length > x.length && y.startsWith(x));
  if (x !== y && !extends_) return pick(first);
  // The close read is the better one at the size's digits when it makes a printed pair, unless
  // its size had to be cut down from a run of four digits.
  const number = x === y && prefix(first.number) ? first.number : closer.number;
  const cut = /[/|\\]\s*[A-Za-z]*\d{4}/.test(closerText);
  const closerTotal = closer.total && !cut && plausibleNumber({ number, total: closer.total }) ? closer.total : undefined;
  const total = closerTotal ?? (first.total && plausibleNumber({ number, total: first.total }) ? first.total : (closer.total ?? first.total));
  return { number, total };
}

// Words that surround a Pokémon name on the top line and are never part of it.
const POKEMON_NAME_NOISE = new Set([
  'basic', 'stage', 'stage1', 'stage2', 'stagel', 'hp', 'evolves', 'from', 'put', 'this', 'card', 'on', 'the',
  'restored', 'break', 'level', 'up', 'lv', 'trainer', 'item', 'supporter', 'stadium', 'tool',
  'special', 'pokemon', 'tera', 'ace', 'spec', 'delta', 'species', 'evolves', 'illus', 'weakness',
  'resistance', 'retreat',
]);

// Labels on the name strip that say what kind of card this is (never printed on a Pokémon).
const TRAINER_LABEL = /\b(?:TRAINER|ITEM|SUPPORTER|STADIUM|TOOL|Supporter|Item|Stadium)\b/;
const ENERGY_LABEL = /\bENERGY\b|\b(?:Basic|Special)\s+Energy\b/;

/** The card type a label on the name strip gives away. */
export function pokemonCategory(nameStrip: string): ScanHints['category'] {
  if (TRAINER_LABEL.test(nameStrip)) return 'trainer';
  if (ENERGY_LABEL.test(nameStrip)) return 'energy';
  return undefined;
}

export function parsePokemon(raw: Record<string, string>): ScanHints {
  const hints: ScanHints = { game: 'pokemon', raw };
  const bottom = raw.bottom ?? '';
  const top = raw.name ?? '';

  // Collector number "025/198", "TG05/TG30", "GG12/GG70", "RC5/RC32", "4/102". The separator is
  // sometimes read as | or \. Letters get glued on (regulation mark, "V rule"), prefixes get
  // garbled ("5v122", "1607/1630") and the rarity symbol can add a digit ("42/1140"), so the
  // tokens are taken generously and sorted out by numberSplits.
  const reads: NumberRead[] = [];
  const pair = /(?<![0-9A-Za-z])([A-Za-z0-9]{1,6})\s*[/|\\]\s*([A-Za-z0-9]{2,6})(?![0-9A-Za-z])/g;
  // Matches may overlap ("svis| 166/198"): scan on from just after each match's start.
  for (let m = pair.exec(bottom); m; pair.lastIndex = m.index + 1, m = pair.exec(bottom)) {
    const read = readNumberPair(m);
    if (read) reads.push(read);
  }
  // A printed number/size pair beats junk around a separator; "/" beats a "|" that may be a glyph.
  const num = reads.sort((a, b) => Number(b.plausible) - Number(a.plausible) || Number(b.slash) - Number(a.slash) || a.index - b.index)[0];
  if (num) {
    hints.number = num.number;
    if (num.total) hints.total = num.total;
    // Set code printed just before the number on Scarlet & Violet cards: "G PAL EN 123/193".
    const before = bottom.slice(0, num.index).trimEnd() + ' ';
    // OCR often drops the space between code and language: "SVIEN".
    const forms = [/(?<![A-Za-z0-9])([A-Za-z0-9]{2,5})\s+(?:([A-Z]{2})\s+)?$/, /(?<![A-Za-z0-9])([A-Za-z0-9]{2,5}?)(EN|DE|FR|IT|ES|PT)\s+$/];
    for (const form of forms) {
      const code = form.exec(before);
      if (!code || /^\d+$/.test(code[1]!)) continue;
      const language = code[2] && POKEMON_LANGUAGES.has(code[2]) ? code[2] : undefined;
      // "svi EN 063/198" with the set code unreadable: the language is all that's left.
      if (!code[2] && POKEMON_LANGUAGES.has(code[1]!.toUpperCase())) {
        hints.language = code[1]!.toUpperCase();
        break;
      }
      const fixed = fixSetCode(code[1]!, hints.number, !!language);
      if (!fixed && !language) continue;
      if (fixed) hints.setCode = fixed;
      if (language) hints.language = language;
      break;
    }
  } else {
    // Black Star promos: "SWSH050", "SM210", "XY 67", and "SVP EN 085" / "MEP EN 001" with the
    // language between the code and the number.
    const promo = new RegExp(`\\b(${POKEMON_PROMO_PREFIXES.join('|')})\\s?(?:(EN|DE|FR|IT|ES|PT)\\s*)?-?\\s?(${DIGITISH}{2,3})\\b`).exec(bottom);
    if (promo) {
      const digits = toDigits(promo[3]!);
      if (promo[2]) hints.language = promo[2];
      if (promo[1] === 'SV' && !promo[2]) {
        // "SV107" with the size unreadable is a Shiny Vault number, not an SVP promo (those
        // print "SVP EN 107").
        hints.number = `SV${digits}`;
      } else if (promo[1] === 'SVP' || promo[1] === 'SV' || promo[1] === 'MEP') {
        hints.number = digits;
        hints.setCode = promo[1] === 'MEP' ? 'MEP' : 'SVP';
      } else {
        hints.number = promo[1] + digits;
      }
    }
  }

  // The strip is matched against candidate names as a whole: the pre-evolution named on it
  // ("Evolves from Kadabra") must not read as a match for that card.
  hints.nameText = withoutEvolutionText(top);
  hints.nameCandidates = nameCandidates(top, POKEMON_NAME_NOISE);
  hints.name = guessName(top, POKEMON_NAME_NOISE) ?? hints.nameCandidates[0];
  const category = pokemonCategory(top);
  if (category) hints.category = category;
  return hints;
}

// The text on the name strip that names another card: "Evolves from Kadabra", "Put Alakazam on
// the Stage 1 card" (the words after the name are the pre-evolution's stage).
const EVOLVES_FROM = /\b[Ee]vol?ve[sd]?\s+fr[oa]m\s+\S+/g;
const PUT_ON = /\bPut\s+\S+\s+on\b.*$/;

/** The name strip without the lines' evolution notes, which name another card. */
export function withoutEvolutionText(strip: string): string {
  return strip
    .split('\n')
    .map((line) => line.replace(EVOLVES_FROM, ' ').replace(PUT_ON, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
// Small print "HP" and its digits as OCR renders them: "60HP", "HP 60", "w90", "wl30", "Jw140",
// "JOHP", "SO HP", "n150", "+140". Names never carry digits, so a short run of letters glued to
// digits is always this.
const HP_TOKENS = /\b(?:HP|hp)\s*\d+|\d+\s*(?:HP|hp)\b|(?<=\s|^)(?:[A-Za-z»]{0,3}[0-9][0-9OoIl]{0,2}[Q0O@&%]*|[A-Za-z]{0,2}[0-9OoIl]{0,3}HP[A-Za-z]?)(?=\s|$)/g;
const HP_LINE = /\bHP\b|(?:^|\s)\S{0,4}\d{2,3}(?!\d)/i;

/**
 * Capitalised words that look like a Pokémon name ("Metagross", "Pikachuz" with a stray letter),
 * most plausible first: words on the line that also carries the HP come first, longer before
 * shorter. Three-letter names (Mew, Muk) count on the HP line. The word after "Evolves from"
 * names the pre-evolution, so it is left out. Up to three.
 */
export function nameCandidates(text: string, noise: Set<string>): string[] {
  const scored: Array<{ w: string; s: number }> = [];
  for (const line of text.split('\n')) {
    const hpLine = HP_LINE.test(line);
    const stripped = line.replace(EVOLVES_FROM, ' ');
    for (const m of stripped.matchAll(hpLine ? /[A-Z][a-z]{2,}[a-z'.-]*/g : /[A-Z][a-z]{3,}[a-z'.-]*/g)) {
      const w = m[0].replace(/[.'-]+$/, '');
      if (noise.has(w.toLowerCase())) continue;
      scored.push({ w, s: (hpLine ? 10 : 0) + w.length });
    }
  }
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.s - a.s)
    .map((x) => x.w)
    .filter((w) => !seen.has(w.toLowerCase()) && !!seen.add(w.toLowerCase()))
    .slice(0, 3);
}

// Region letters in Yu-Gi-Oh! set codes → card language.
const YGO_REGION_LANGUAGE: Record<string, string> = {
  EN: 'EN', E: 'EN', AE: 'EN', FR: 'FR', F: 'FR', DE: 'DE', G: 'DE', IT: 'IT', I: 'IT',
  SP: 'ES', S: 'ES', PT: 'PT', P: 'PT', JP: 'JP', J: 'JP', KR: 'KR', K: 'KR', SC: 'ZH', TC: 'ZH',
};

// The attribute icon at the end of the name banner, as OCR reads it.
const YGO_ATTRIBUTE_ICON = /\s+(?:DARK|LIGHT|EARTH|WATER|FIRE|WIND|DIVINE|SPELL|TRAP)\W*$/;

export function parseYugioh(raw: Record<string, string>): ScanHints {
  const hints: ScanHints = { game: 'yugioh', raw };
  const middle = raw.middle ?? '';
  const bottom = raw.bottom ?? '';
  const top = raw.name ?? '';
  const body = `${middle}\n${bottom}`;

  // Set code: "LOB-EN005", "SDY-006", "RA01-EN016", "MP23-EN001". Prefix must contain a letter.
  const code = new RegExp(`\\b([A-Z0-9]{2,4})\\s?[-–—]\\s?([A-Z]{1,2})?\\s?(${DIGITISH}{3})(?![0-9])`).exec(body);
  if (code && /[A-Z]/.test(code[1]!)) {
    const prefix = code[1]!;
    const region = code[2] ?? '';
    hints.setCode = `${prefix}-${region}${toDigits(code[3]!)}`;
    if (region) hints.language = YGO_REGION_LANGUAGE[region] ?? region;
  }

  // 8-digit passcode, bottom-left.
  const pass = new RegExp(`(?<![0-9A-Za-z])(${DIGITISH}{8})(?![0-9A-Za-z])`).exec(bottom);
  if (pass) {
    const digits = toDigits(pass[1]!);
    if (/^\d{8}$/.test(digits)) hints.passcode = digits;
  }

  if (/[1lI]st\s*Ed/i.test(body)) hints.variant = '1st Edition';
  else if (/limited\s*ed/i.test(body)) hints.variant = 'Limited Edition';

  hints.nameText = top;
  hints.name = guessName(
    top
      .split('\n')
      .map((l) => l.replace(YGO_ATTRIBUTE_ICON, ''))
      .join('\n'),
    new Set(),
  );
  return hints;
}

const LANG = '(EN|DE|FR|IT|ES|SP|PT|JA|JP|KO|KR|RU|ZH|ZHS|ZHT|CS|CT|PH)';
const LANG_FIXES: Record<string, string> = { JA: 'JP', KO: 'KR', SP: 'ES', ZHS: 'ZH', ZHT: 'ZH', CS: 'ZH', CT: 'ZH' };

export function parseMtg(raw: Record<string, string>): ScanHints {
  const hints: ScanHints = { game: 'mtg', raw };
  const bottom = raw.bottom ?? '';

  // 2015–2019 frames: "123/269 R". Modern frames: "0123 R" on one line, "M21 • EN" under it.
  const withTotal = new RegExp(`(?<![0-9A-Za-z])(${DIGITISH}{1,4})\\s*/\\s*(${DIGITISH}{2,4})(?![0-9])`).exec(bottom);
  const bare = new RegExp(`(?<![0-9A-Za-z])(${DIGITISH}{3,4})\\s+[CURMSLTP]\\b`).exec(bottom);
  const n = withTotal ?? bare;
  if (n) {
    const digits = toDigits(n[1]!);
    if (/^\d+$/.test(digits)) hints.number = String(Number(digits));
    if (withTotal) hints.total = toDigits(withTotal[2]!);
  }
  const set = new RegExp(`\\b([A-Z0-9]{3,5})\\s*[•·*.+\\-]?\\s*${LANG}\\b`).exec(bottom);
  if (set && /[A-Z]/.test(set[1]!)) {
    hints.setCode = set[1];
    hints.language = LANG_FIXES[set[2]!] ?? set[2];
  }

  hints.nameText = raw.name ?? '';
  hints.name = guessName(hints.nameText, new Set());
  return hints;
}

export function parseLorcana(raw: Record<string, string>): ScanHints {
  const hints: ScanHints = { game: 'lorcana', raw };
  const bottom = raw.bottom ?? '';
  const m = new RegExp(`(?<![0-9])(${DIGITISH}{1,3}[a-z]?)\\s*/\\s*(${DIGITISH}{1,3})(?:\\s*[•·*.\\-]?\\s*${LANG}(?:\\s*[•·*.\\-]?\\s*([A-Z0-9]{1,3}))?)?`).exec(bottom);
  if (m) {
    hints.number = String(Number(toDigits(m[1]!.replace(/[a-z]$/, '')))) + (/[a-z]$/.test(m[1]!) ? m[1]!.slice(-1) : '');
    hints.total = toDigits(m[2]!);
    if (m[3]) hints.language = LANG_FIXES[m[3]] ?? m[3];
    if (m[4]) hints.setCode = /^[0-9OoIl]+$/.test(m[4]) ? toDigits(m[4]) : m[4];
  }

  // The banner has the character name in capitals over the version ("MICKEY MOUSE" /
  // "Brave Little Tailor"). Keep both lines; matching uses the whole text.
  const lines = (raw.name ?? '')
    .split('\n')
    .map((l) => l.replace(/[^A-Za-z0-9'.,!&\- ]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => (l.match(/[A-Za-z]/g) ?? []).length >= 3);
  hints.nameText = lines.join(' ');
  hints.name = lines[0] && lines[0].length >= 3 ? lines.slice(0, 2).join(' - ') : undefined;
  return hints;
}

export function parseScan(game: GameId, raw: Record<string, string>): ScanHints {
  const parsers: Record<GameId, (raw: Record<string, string>) => ScanHints> = { pokemon: parsePokemon, yugioh: parseYugioh, mtg: parseMtg, lorcana: parseLorcana };
  return parsers[game](raw);
}

/**
 * Keep the alphabetic words of the top line that aren't stage/HP/attribute noise. The line that
 * carries the HP is the name line; under a TRAINER / Supporter / Item label the next line is;
 * failing both, the line with the most name-like (Capitalised) text left on it.
 */
function guessName(text: string, noise: Set<string>): string | undefined {
  const isNoise = (w: string): boolean => {
    const lw = w.toLowerCase();
    if (noise.has(lw)) return true;
    // OCR slips on the noise words themselves: "easic" for BASIC, "Stace" for STAGE.
    return lw.length >= 4 && [...noise].some((n) => n.length >= 4 && levenshtein(lw, n) <= 1);
  };
  const clean = (line: string): string[] => {
    const words = line
      .replace(EVOLVES_FROM, ' ')
      .replace(PUT_ON, ' ')
      .replace(HP_TOKENS, ' ')
      .split(/\s+/)
      // A stage box read as lowercase junk joined to the name by its closing bracket:
      // "sasc)Roselia", "sec/Emolga", "=c)Ho-Oh".
      .flatMap((w) => w.split(/(?<=[a-z0-9])[)/|\\\]}]+(?=[A-Z])/))
      // Icon noise glued to the word: "2°<)”Kadabra", "Blastoise@Y", "l/Caruledee".
      .map((w) => w.replace(/^[^A-Za-z]+/, '').replace(/^([A-Za-z][A-Za-z'’.&!:-]*).*$/, '$1').replace(/[^A-Za-z0-9!]+$/, ''))
      // "AlcremieV", "LaprasVimax": the V / VMAX / VSTAR glued to the name.
      .flatMap((w) => (/^[A-Z][a-z]{3,}V[A-Za-z]{0,4}$/.test(w) ? [w.replace(/V[A-Za-z]*$/, ''), w.slice(w.replace(/V[A-Za-z]*$/, '').length)] : [w]))
      .filter((w) => /[A-Za-z]/.test(w) && !isNoise(w))
      // "LV.12" after the name on Diamond & Pearl cards (LV.X is part of the name).
      .filter((w) => !/^LV\.?\d+$/i.test(w))
      // "ENERGY" is the banner on Energy cards; "Energy" is part of their names.
      .filter((w) => w !== 'ENERGY')
      // Fragments of one or two letters are icon noise, except the suffixes that belong to names.
      .filter((w) => w.length > 2 || /^(ex|EX|GX|V|of|no|Mr|Jr)\.?$/.test(w));
    // Junk read off the icons before the name: "2amcg Pikachu", "scel Kakuna".
    while (words.length > 1 && !/^[A-Z]/.test(words[0]!) && words[0]!.length <= 6 && /^[A-Z]/.test(words[1]!)) words.shift();
    if (words.length === 1 && words[0]!.toLowerCase() === 'energy') return [];
    return words;
  };
  // Capitalised words are what names are made of; lowercase runs and capital-letter runs are
  // mostly misread icons and stage boxes.
  const score = (words: string[]): number => words.reduce((t, w) => t + w.length * (/^[A-Z][a-z]+/.test(w) ? 2 : /^[a-z]+$/.test(w) ? 0.75 : 0.5), 0);
  const lines = text.split('\n').map((l) => ({ raw: l, hp: HP_LINE.test(l), label: TRAINER_LABEL.test(l) || ENERGY_LABEL.test(l), words: clean(l) }));
  const named = lines.filter((l) => l.words.join(' ').length >= 3);
  const best = (ls: typeof lines): (typeof lines)[number] | undefined => [...ls].sort((a, b) => score(b.words) - score(a.words) || b.raw.length - a.raw.length)[0];
  const labelled = lines.findIndex((l) => l.label);
  // The HP line only counts when a Capitalised word is left on it ("a eas 21200" has none).
  const pick = best(named.filter((l) => l.hp && score(l.words) >= 6)) ?? (labelled >= 0 ? named.find((l) => lines.indexOf(l) > labelled) : undefined) ?? best(named);
  return pick ? pick.words.join(' ') : undefined;
}
