/**
 * A fake TCGdex API built from a local checkout of https://github.com/tcgdex/cards-database, for
 * replaying scans against the real catalog offline (scripts/pokemon-eval.test.ts and
 * scripts/ocr-replay.test.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

export interface RawSet {
  id: string;
  name: string;
  official: number;
  code: string;
  date: string;
  era: string;
}
export interface RawCard {
  id: string;
  localId: string;
  name: string;
  rarity: string;
  category: string;
  variants: Record<string, boolean>;
  set: RawSet;
}

/** Every set and card of the given eras (directory names under data/; default: all but TCG Pocket). */
export function loadCatalog(dir: string, eras?: string[]): { sets: RawSet[]; cards: RawCard[] } {
  const sets: RawSet[] = [];
  const cards: RawCard[] = [];
  const root = join(dir, 'data');
  for (const era of eras ?? readdirSync(root).filter((e) => e !== 'Pokémon TCG Pocket' && statSync(join(root, e)).isDirectory())) {
    const base = join(root, era);
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

export function fakeApi(sets: RawSet[], cards: RawCard[]): void {
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

