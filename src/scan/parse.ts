import type { GameId, ScanHints } from '../types';
import { levenshtein } from '../util/text';

/**
 * A strip of the card to OCR, in fractions of the card's width/height.
 * Bands are generous so a slightly off-centre photo still catches the text.
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

export const REGIONS: Record<GameId, Region[]> = {
  pokemon: [
    // Stage + name + HP. Name sits top-left, HP top-right.
    { key: 'name', x: 0.03, y: 0.015, w: 0.94, h: 0.095 },
    // Regulation mark, set code, collector number, illustrator. Modern cards print the number
    // bottom-left, WotC-era cards bottom-right, so take the full width.
    { key: 'bottom', x: 0.0, y: 0.87, w: 1.0, h: 0.125 },
  ],
  yugioh: [
    // Name banner, stopping short of the attribute icon.
    { key: 'name', x: 0.04, y: 0.03, w: 0.8, h: 0.085 },
    // Just under the artwork: set code on the right, "1st Edition" on the left.
    { key: 'middle', x: 0.0, y: 0.69, w: 1.0, h: 0.095 },
    // Passcode bottom-left, and the set code on Pendulum cards.
    { key: 'bottom', x: 0.0, y: 0.86, w: 1.0, h: 0.135 },
  ],
  mtg: [
    // Name top-left, stopping before the mana cost.
    { key: 'name', x: 0.04, y: 0.025, w: 0.72, h: 0.075 },
    // Collector number, rarity, set code and language, bottom-left: "0123 R / M21 • EN".
    { key: 'bottom', x: 0.0, y: 0.88, w: 1.0, h: 0.12 },
  ],
  lorcana: [
    // Name and version sit in the banner across the middle of the card.
    { key: 'name', x: 0.03, y: 0.5, w: 0.94, h: 0.16 },
    // "12/204 • EN • 1": collector number / set size, language, set number.
    { key: 'bottom', x: 0.0, y: 0.9, w: 1.0, h: 0.1 },
  ],
};

// OCR commonly confuses these with digits inside numeric runs.
const DIGIT_FIXES: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };
const DIGITISH = '[0-9OoDQIli|SsBZzG]';

function toDigits(s: string): string {
  return s.replace(/[^0-9]/g, (c) => DIGIT_FIXES[c] ?? c);
}

// Subset prefixes printed in front of collector numbers: Trainer Gallery, Galarian Gallery,
// Radiant Collection, Shiny Vault, Shiny (Hidden Fates), Holo (Crystal Guardians era).
const POKEMON_SUBSET_PREFIXES = ['TG', 'GG', 'RC', 'SV', 'SH', 'H'];

/** "O25" → "025", "TG0S" → "TG05". Only known subset prefixes are kept as letters. */
function fixNumber(s: string): string {
  const suffix = /[a-z]$/.test(s) ? s.slice(-1) : '';
  const body = suffix ? s.slice(0, -1) : s;
  for (const p of POKEMON_SUBSET_PREFIXES) {
    const rest = body.slice(p.length);
    if (body.startsWith(p) && rest.length > 0 && /^[0-9OoDQIli|SsBZzG]+$/.test(rest)) {
      return p + toDigits(rest) + suffix;
    }
  }
  return toDigits(body) + suffix;
}

const POKEMON_PROMO_PREFIXES = ['SWSH', 'HGSS', 'SVP', 'SM', 'XY', 'BW', 'DP', 'SV'];

// Words that surround a Pokémon name on the top line and are never part of it.
const POKEMON_NAME_NOISE = new Set([
  'basic', 'stage', 'stage1', 'stage2', 'stagel', 'hp', 'evolves', 'from', 'put', 'this', 'card', 'on', 'the',
  'restored', 'break', 'level', 'up', 'lv', 'trainer', 'item', 'supporter', 'stadium', 'tool', 'energy',
  'special', 'pokemon', 'tera', 'ace', 'spec',
]);

export function parsePokemon(raw: Record<string, string>): ScanHints {
  const hints: ScanHints = { game: 'pokemon', raw };
  const bottom = raw.bottom ?? '';
  const top = raw.name ?? '';

  // Collector number "025/198", "TG05/TG30", "GG12/GG70", "RC5/RC32", "4/102". The separator is
  // sometimes read as | or \.
  const num = new RegExp(`(?<![0-9A-Za-z])([A-Z]{0,2}${DIGITISH}{1,3}[a-z]?)\\s*[/|\\\\]\\s*([A-Z]{0,2}${DIGITISH}{2,3})(?![0-9])`).exec(bottom);
  if (num) {
    hints.number = fixNumber(num[1]!);
    hints.total = fixNumber(num[2]!);
    // Set code printed just before the number on Sword & Shield / Scarlet & Violet cards: "PAL EN 123/193".
    const before = bottom.slice(0, num.index);
    // OCR often drops the space between them: "SVIEN".
    const code =
      /\b([A-Z][A-Z0-9]{1,3})\s+(?:([A-Z]{2})\s+)?$/.exec(before.trimEnd() + ' ') ??
      /\b([A-Z][A-Z0-9]{1,3}?)(EN|DE|FR|IT|ES|PT)\s+$/.exec(before.trimEnd() + ' ');
    if (code && !/^\d+$/.test(code[1]!)) {
      hints.setCode = code[1];
      if (code[2]) hints.language = code[2];
    }
  } else {
    // Black Star promos: "SWSH050", "SM210", "XY 67".
    const promo = new RegExp(`\\b(${POKEMON_PROMO_PREFIXES.join('|')})\\s?-?\\s?(${DIGITISH}{2,3})\\b`).exec(bottom);
    if (promo) {
      const digits = toDigits(promo[2]!);
      if (promo[1] === 'SVP' || promo[1] === 'SV') {
        hints.number = digits;
        hints.setCode = 'SVP';
      } else {
        hints.number = promo[1] + digits;
      }
    }
  }

  hints.nameText = top;
  hints.name = guessName(top, POKEMON_NAME_NOISE);
  return hints;
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

/** Keep the alphabetic words of the top line that aren't stage/HP/attribute noise. */
function guessName(text: string, noise: Set<string>): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .sort((a, b) => b.length - a.length)[0];
  if (!line) return undefined;
  const isNoise = (w: string): boolean => {
    const lw = w.toLowerCase();
    if (noise.has(lw)) return true;
    // OCR slips on the noise words themselves: "easic" for BASIC, "Stace" for STAGE.
    return lw.length >= 4 && [...noise].some((n) => n.length >= 4 && levenshtein(lw, n) <= 1);
  };
  const words = line
    .replace(/\b(?:HP|hp)\s*\d+|\d+\s*(?:HP|hp)\b/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'.:&!-]+$/g, ''))
    .filter((w) => /[A-Za-z]/.test(w) && !isNoise(w))
    // Fragments of one or two letters are icon noise, except the suffixes that belong to names.
    .filter((w) => w.length > 2 || /^(ex|EX|GX|V|of|no|Mr|Jr)\.?$/.test(w));
  const name = words.join(' ').trim();
  return name.length >= 3 ? name : undefined;
}
