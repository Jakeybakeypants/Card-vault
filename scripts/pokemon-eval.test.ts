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
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parsePokemon } from '../src/scan/parse';
import { clearHttpCache } from '../src/games/http';
import { pokemon } from '../src/games/pokemon';

const DIR = process.env.TCGDEX_DIR;
const ERAS = ['Scarlet & Violet', 'Mega Evolution', 'Sword & Shield', 'Sun & Moon'];

interface RawSet {
  id: string;
  name: string;
  official: number;
  code: string;
  date: string;
  era: string;
}
interface RawCard {
  id: string;
  localId: string;
  name: string;
  rarity: string;
  category: string;
  variants: Record<string, boolean>;
  set: RawSet;
}

function load(): { sets: RawSet[]; cards: RawCard[] } {
  const sets: RawSet[] = [];
  const cards: RawCard[] = [];
  for (const era of ERAS) {
    const base = join(DIR!, 'data', era);
    for (const f of readdirSync(base)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(base, f), 'utf8');
      const set: RawSet = {
        id: /\bid:\s*"([^"]+)"/.exec(src)![1]!,
        name: /name:\s*\{[^}]*?\ben:\s*"([^"]+)"/s.exec(src)?.[1] ?? f.slice(0, -3),
        official: Number(/official:\s*(\d+)/.exec(src)?.[1] ?? 0),
        code: /abbreviations:\s*\{[^}]*?official:\s*"([^"]+)"/s.exec(src)?.[1] ?? '',
        date: /releaseDate:\s*"([^"]+)"/.exec(src)?.[1] ?? '',
        era,
      };
      sets.push(set);
      const dir = join(base, f.slice(0, -3));
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const c of readdirSync(dir)) {
        if (!c.endsWith('.ts')) continue;
        const s = readFileSync(join(dir, c), 'utf8');
        const name = /name:\s*\{[^}]*?\ben:\s*"([^"]+)"/s.exec(s)?.[1];
        if (!name) continue;
        const types = [...s.matchAll(/type:\s*'(normal|holo|reverse)'/g)].map((m) => m[1]!);
        const legacy = /variants:\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
        const variants: Record<string, boolean> = {};
        for (const t of types) variants[t] = true;
        for (const m of legacy.matchAll(/(normal|holo|reverse|firstEdition):\s*(true|false)/g)) variants[m[1]!] = m[2] === 'true';
        const localId = c.slice(0, -3);
        cards.push({
          id: `${set.id}-${localId}`,
          localId,
          name,
          rarity: /rarity:\s*"([^"]+)"/.exec(s)?.[1] ?? '',
          category: /category:\s*"([^"]+)"/.exec(s)?.[1] ?? '',
          variants,
          set,
        });
      }
    }
  }
  sets.sort((a, b) => a.date.localeCompare(b.date));
  return { sets, cards };
}

function fakeApi(sets: RawSet[], cards: RawCard[]): void {
  const byId = new Map(cards.map((c) => [c.id.toLowerCase(), c]));
  const bySet = new Map<string, RawCard[]>();
  for (const c of cards) bySet.set(c.set.id, [...(bySet.get(c.set.id) ?? []), c]);
  const brief = (c: RawCard) => ({ id: c.id, localId: c.localId, name: c.name, image: `https://assets.example/${c.id}` });
  const count = (s: RawSet) => ({ official: s.official, total: Math.max(s.official, bySet.get(s.id)?.length ?? 0) });
  const full = (c: RawCard) => ({ ...brief(c), rarity: c.rarity, category: c.category, variants: c.variants, set: { id: c.set.id, name: c.set.name, cardCount: count(c.set) }, pricing: null });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.host !== 'api.tcgdex.net') return json({ error: 'unavailable' }, 503);
      const path = decodeURIComponent(url.pathname).replace(/^\/v2\/en/, '');
      let m: RegExpExecArray | null;
      if (path === '/sets') return json(sets.map((s) => ({ id: s.id, name: s.name, cardCount: count(s) })));
      if ((m = /^\/sets\/([^/]+)$/.exec(path))) {
        const s = sets.find((x) => x.id === m![1]);
        return s ? json({ id: s.id, name: s.name, cardCount: count(s), cards: (bySet.get(s.id) ?? []).map(brief) }) : json({}, 404);
      }
      if ((m = /^\/sets\/([^/]+)\/(.+)$/.exec(path))) {
        const c = byId.get(`${m[1]}-${m[2]}`.toLowerCase());
        return c ? json(full(c)) : json({}, 404);
      }
      if ((m = /^\/cards\/(.+)$/.exec(path))) {
        const c = byId.get(m[1]!.toLowerCase());
        return c ? json(full(c)) : json({}, 404);
      }
      if (path === '/cards') {
        const q = (url.searchParams.get('name') ?? '').toLowerCase();
        return json(cards.filter((c) => c.name.toLowerCase().includes(q)).map(brief));
      }
      return json({}, 404);
    }),
  );
}

/** The collector line as printed in each era. */
function bottomLine(c: RawCard): string {
  const { set, localId } = c;
  const pad = (n: string, w: number) => (/^\d+$/.test(n) ? n.padStart(w, '0') : n);
  if (set.id === 'svp' || set.id === 'mep') return `G ${set.code} EN ${pad(localId, 3)}`;
  if (/^(SWSH|SM)\d/.test(localId)) return localId;
  const prefix = /^[A-Z]+/.exec(localId)?.[0];
  if (prefix) return `${localId}/${prefix}${set.official}`;
  if (set.era === 'Scarlet & Violet' || set.era === 'Mega Evolution') return `H ${set.code.split(':')[0]} EN ${pad(localId, 3)}/${pad(String(set.official), 3)}`;
  return `${localId}/${set.official}`;
}

function nameLine(c: RawCard): string {
  return c.category === 'Pokemon' ? `BASIC ${c.name} HP 120` : c.name;
}

function kind(c: RawCard): string {
  if (['svp', 'mep', 'swshp', 'smp'].includes(c.set.id)) return 'promo';
  const prefix = /^[A-Z]+/.exec(c.localId)?.[0];
  if (prefix) return `subset ${prefix}`;
  if (Number(c.localId) > c.set.official) return 'secret (above set size)';
  return 'numbered';
}

describe.skipIf(!DIR)('pokemon lookup accuracy against the TCGdex catalog', () => {
  const { sets, cards } = DIR ? load() : { sets: [], cards: [] };
  // A spread of every kind of card, deterministic: every 7th card plus every subset/promo/secret.
  const sample = cards.filter((c, i) => i % 7 === 0 || kind(c) !== 'numbered');
  const results = new Map<string, { n: number; top1: number; top10: number; top60: number; misses: string[] }>();
  afterAll(() => {
    vi.unstubAllGlobals();
    const rows = [...results.entries()].sort();
    const report = ['', 'scenario / kind                          cards   top-1  top-10  top-60 (photo-compared)', ...rows.map(([k, r]) => `${k.padEnd(40)} ${String(r.n).padStart(5)} ${((100 * r.top1) / r.n).toFixed(0).padStart(6)}% ${((100 * r.top10) / r.n).toFixed(0).padStart(6)}% ${((100 * r.top60) / r.n).toFixed(0).padStart(6)}%   ${r.misses.slice(0, 3).join(' ')}`)].join('\n');
    console.log(report);
    if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, report);
  });

  const scenarios: Array<[string, (c: RawCard) => Record<string, string>]> = [
    ['name + number', (c) => ({ name: nameLine(c), bottom: bottomLine(c) })],
    ['number only', (c) => ({ name: '~~ ##', bottom: bottomLine(c) })],
    ['name only', (c) => ({ name: nameLine(c), bottom: '' })],
  ];

  it.each(scenarios)('%s', async (scenario, raw) => {
    fakeApi(sets, cards);
    for (const c of sample) {
      clearHttpCache();
      const hints = parsePokemon(raw(c));
      const found = await pokemon.identify(hints).catch(() => []);
      const ids = found.map((x) => x.card.key.toLowerCase());
      const key = `${scenario} / ${kind(c)}`;
      const r = results.get(key) ?? { n: 0, top1: 0, top10: 0, top60: 0, misses: [] };
      r.n++;
      if (ids[0] === c.id.toLowerCase()) r.top1++;
      else r.misses.push(c.id);
      if (process.env.EVAL_DEBUG?.split(',').includes(c.id)) {
        console.log(`[${scenario}] ${c.id} ${JSON.stringify(raw(c))} → ${JSON.stringify({ ...hints, raw: undefined })}\n  ` + found.slice(0, 4).map((x) => `${x.card.key} ${x.card.name} ${x.card.number} ${x.score.toFixed(3)}`).join('\n  '));
      }
      if (ids.slice(0, 60).includes(c.id.toLowerCase())) r.top60++;
      if (ids.slice(0, 10).includes(c.id.toLowerCase())) r.top10++;
      results.set(key, r);
    }
    expect(results.size).toBeGreaterThan(0);
  }, 600_000);
});
