/**
 * Offline accuracy check for Pokémon lookups against the real TCGdex catalog.
 *
 * Builds a fake TCGdex API from a local checkout of https://github.com/tcgdex/cards-database
 * and feeds `parsePokemon` + `pokemon.identify` the text that is printed on real cards (name
 * line, collector line in each era's format), then reports how often the right printing comes
 * out on top. Skipped unless TCGDEX_DIR points at the checkout:
 *
 *   TCGDEX_DIR=../cards-database npx vitest run scripts/pokemon-eval.test.ts
 */
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parsePokemon } from '../src/scan/parse';
import { isConfident } from '../src/games/game';
import { clearHttpCache } from '../src/games/http';
import { pokemon } from '../src/games/pokemon';
import { classicPrintedNumber } from '../src/games/pokemonSetIndex';
import { fakeApi, loadCatalog, type RawCard } from './tcgdexFake';

const DIR = process.env.TCGDEX_DIR;
const ERAS = ['Scarlet & Violet', 'Mega Evolution', 'Sword & Shield', 'Sun & Moon'];

/**
 * The collector line as printed in each era. `over` swaps in a misread number, size or set
 * code, as an OCR slip would.
 */
function bottomLine(c: RawCard, over: { localId?: string; official?: string; code?: string } = {}): string {
  const { set } = c;
  // Classic Collection reprints print the original card's line ("4/102"), not their CC number.
  const classic = classicPrintedNumber(c.id);
  if (classic) return classic.total ? `${classic.number}/${classic.total}` : classic.number;
  const localId = over.localId ?? c.localId;
  const official = over.official ?? String(set.official);
  const code = over.code ?? set.code.split(':')[0]!;
  const pad = (n: string, w: number) => (/^\d+$/.test(n) ? n.padStart(w, '0') : n);
  if (set.id === 'svp' || set.id === 'mep') return `G ${code} EN ${pad(localId, 3)}`;
  if (/^(SWSH|SM)\d/.test(localId)) return localId;
  const prefix = /^[A-Z]+/.exec(localId)?.[0];
  if (prefix) return `${localId}/${prefix}${official}`;
  if (set.era === 'Scarlet & Violet' || set.era === 'Mega Evolution') return `H ${code} EN ${pad(localId, 3)}/${pad(official, 3)}`;
  return `${localId}/${official}`;
}

function nameLine(c: RawCard, name = c.name): string {
  return c.category === 'Pokemon' ? `BASIC ${name} HP 120` : name;
}

/** "063" → "064", "TG05" → "TG06": the last digit read one off. */
function lastDigitOff(n: string): string {
  const m = /^([A-Za-z]*)(\d+)([a-z]?)$/.exec(n);
  if (!m) return n;
  return `${m[1]}${m[2]!.slice(0, -1)}${(Number(m[2]!.slice(-1)) + 1) % 10}${m[3]}`;
}

/** Special-printing marks OCR usually drops: "Charizard ex" → "Charizard". */
const SUFFIX = /\s+(ex|EX|GX|V|VMAX|VSTAR|LV\.X|☆|BREAK|Prime|LEGEND)$|-GX$/;
const hasSuffix = (c: RawCard): boolean => SUFFIX.test(c.name);
const codedSet = (c: RawCard): boolean => !!c.set.code && !['svp', 'mep'].includes(c.set.id) && (c.set.era === 'Scarlet & Violet' || c.set.era === 'Mega Evolution');

function kind(c: RawCard): string {
  if (['svp', 'mep', 'swshp', 'smp'].includes(c.set.id)) return 'promo';
  const prefix = /^[A-Z]+/.exec(c.localId)?.[0];
  if (prefix) return `subset ${prefix}`;
  if (Number(c.localId) > c.set.official) return 'secret (above set size)';
  return 'numbered';
}

describe.skipIf(!DIR)('pokemon lookup accuracy against the TCGdex catalog', () => {
  const { sets, cards } = DIR ? loadCatalog(DIR, ERAS) : { sets: [], cards: [] };
  // A spread of every kind of card, deterministic: every 7th card plus every subset/promo/secret.
  const sample = cards.filter((c, i) => i % 7 === 0 || kind(c) !== 'numbered');
  const results = new Map<string, { n: number; top1: number; top10: number; top60: number; auto: number; autoWrong: number; misses: string[]; wrong: string[] }>();
  afterAll(() => {
    vi.unstubAllGlobals();
    const rows = [...results.entries()].sort();
    const pct = (a: number, n: number) => `${((100 * a) / n).toFixed(0)}%`.padStart(7);
    const report = [
      '',
      '(top-60 = photo-compared in the app; auto = added without asking on text alone; AUTO-WRONG = a wrong card added that way)',
      'scenario / kind                                    cards   top-1  top-10  top-60    auto  AUTO-WRONG',
      ...rows.map(([k, r]) => `${k.padEnd(50)} ${String(r.n).padStart(5)} ${pct(r.top1, r.n)} ${pct(r.top10, r.n)} ${pct(r.top60, r.n)} ${pct(r.auto, r.n)} ${pct(r.autoWrong, r.n).padStart(11)}   ${[...r.wrong.slice(0, 2).map((w) => `WRONG:${w}`), ...r.misses.slice(0, 3)].join(' ')}`),
    ].join('\n');
    console.log(report);
    if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, report);
    // Every miss and wrong auto-add, for comparing two runs: EVAL_MISSES=misses.txt
    if (process.env.EVAL_MISSES) writeFileSync(process.env.EVAL_MISSES, rows.flatMap(([k, r]) => [...r.wrong.map((w) => `${k}\tWRONG\t${w}`), ...r.misses.map((m) => `${k}\tmiss\t${m}`)]).join('\n'));
  });

  // null skips the card for that scenario.
  const scenarios: Array<[string, (c: RawCard) => Record<string, string> | null]> = [
    ['name + number', (c) => ({ name: nameLine(c), bottom: bottomLine(c) })],
    // An empty name strip, as when OCR returns nothing for the title: the name term is dropped.
    ['number only', (c) => ({ name: '', bottom: bottomLine(c) })],
    ['name only', (c) => ({ name: nameLine(c), bottom: '' })],
    // One OCR slip in the number: the right card must stay in the list for the photo to pick,
    // and a same-name neighbour must not be added on text alone.
    ['name + number, last digit misread', (c) => (/\d/.test(c.localId) ? { name: nameLine(c), bottom: bottomLine(c, { localId: lastDigitOff(c.localId) }) } : null)],
    ['name + number, size last digit misread', (c) => (c.set.official > 9 && /^\d+$/.test(c.localId) ? { name: nameLine(c), bottom: bottomLine(c, { official: lastDigitOff(String(c.set.official)) }) } : null)],
    // The "ex" / "V" / "GX" mark is foil OCR rarely reads.
    ['name without suffix + number', (c) => (hasSuffix(c) ? { name: nameLine(c, c.name.replace(SUFFIX, '')), bottom: bottomLine(c) } : null)],
    ['name without suffix only', (c) => (hasSuffix(c) ? { name: nameLine(c, c.name.replace(SUFFIX, '')), bottom: '' } : null)],
    // The set code read as the promo code (SVI → SVP, MEG → MEP), name unreadable.
    ['number only, set code read as promo code', (c) => (codedSet(c) ? { name: '', bottom: bottomLine(c, { code: c.set.era === 'Mega Evolution' ? 'MEP' : 'SVP' }) } : null)],
  ];

  it.each(scenarios)('%s', async (scenario, raw) => {
    fakeApi(sets, cards);
    for (const c of sample) {
      const input = raw(c);
      if (!input) continue;
      clearHttpCache();
      const hints = parsePokemon(input);
      const found = await pokemon.identify(hints).catch(() => []);
      const ids = found.map((x) => x.card.key.toLowerCase());
      const key = `${scenario} / ${kind(c)}`;
      const r = results.get(key) ?? { n: 0, top1: 0, top10: 0, top60: 0, auto: 0, autoWrong: 0, misses: [], wrong: [] };
      r.n++;
      const confident = isConfident(found);
      if (ids[0] === c.id.toLowerCase()) {
        r.top1++;
        if (confident) r.auto++;
      } else {
        r.misses.push(c.id);
        if (confident) {
          r.autoWrong++;
          r.wrong.push(`${c.id}→${ids[0]}`);
        }
      }
      if (process.env.EVAL_DEBUG?.split(',').includes(c.id)) {
        console.log(`[${scenario}] ${c.id} ${JSON.stringify(input)} → ${JSON.stringify({ ...hints, raw: undefined })} confident=${confident}\n  ` + found.slice(0, 4).map((x) => `${x.card.key} ${x.card.name} ${x.card.number} ${x.score.toFixed(3)} ${JSON.stringify(x.signals)}`).join('\n  '));
      }
      if (ids.slice(0, 60).includes(c.id.toLowerCase())) r.top60++;
      if (ids.slice(0, 10).includes(c.id.toLowerCase())) r.top10++;
      results.set(key, r);
    }
    expect(results.size).toBeGreaterThan(0);
  }, 600_000);
});
