import { parseMtg, REGIONS } from '../scan/parse';
import type { Candidate, CardPrinting, CardSet, ScanHints } from '../types';
import { normalize, partialSimilarity, sameCollectorNumber } from '../util/text';
import { rank, weightedScore, type Game } from './game';
import { getJson, getJsonOrNull, pool, qs } from './http';

// Scryfall: free and keyless (please keep it under ~10 requests/second). https://scryfall.com/docs/api
const API = 'https://api.scryfall.com';

interface SfImages {
  small: string;
  normal: string;
  large: string;
}
interface SfCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  released_at?: string;
  scryfall_uri?: string;
  type_line?: string;
  mana_cost?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  artist?: string;
  finishes?: string[];
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
  image_uris?: SfImages;
  card_faces?: Array<{ image_uris?: SfImages; mana_cost?: string; type_line?: string }>;
  purchase_uris?: { tcgplayer?: string };
}
interface SfList<T> {
  data: T[];
  has_more?: boolean;
  next_page?: string;
  total_cards?: number;
}
interface SfSet {
  code: string;
  name: string;
  set_type: string;
  released_at?: string;
  card_count: number;
  digital: boolean;
  icon_svg_uri?: string;
}

export const MTG_VARIANTS = ['Normal', 'Foil', 'Etched Foil'];
const FINISH_LABELS: Record<string, string> = { nonfoil: 'Normal', foil: 'Foil', etched: 'Etched Foil' };
// Not collectable paper sets: tokens, oversized memorabilia, digital-only rebalances.
const SKIP_SET_TYPES = new Set(['token', 'memorabilia', 'alchemy', 'minigame', 'treasure_chest', 'vanguard']);

function num(s?: string | null): number | undefined {
  const v = s ? Number.parseFloat(s) : NaN;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function fromScryfall(c: SfCard): CardPrinting {
  const img = c.image_uris ?? c.card_faces?.[0]?.image_uris;
  const prices: Record<string, number> = {};
  const add = (label: string, v?: string | null): void => {
    const p = num(v);
    if (p !== undefined) prices[label] = p;
  };
  add('Normal', c.prices?.usd);
  add('Foil', c.prices?.usd_foil);
  add('Etched Foil', c.prices?.usd_etched);
  const variants = (c.finishes ?? ['nonfoil']).map((f) => FINISH_LABELS[f] ?? f);

  const details: Record<string, string> = {};
  const type = c.type_line ?? c.card_faces?.[0]?.type_line;
  if (type) details.Type = type;
  const cost = c.mana_cost || c.card_faces?.[0]?.mana_cost;
  if (cost) details['Mana cost'] = cost;
  if (c.power !== undefined) details['P / T'] = `${c.power} / ${c.toughness ?? '–'}`;
  if (c.loyalty) details.Loyalty = c.loyalty;
  if (c.artist) details.Illustrator = c.artist;

  return {
    game: 'mtg',
    key: `${c.set}-${c.collector_number}`,
    name: c.name,
    setName: c.set_name,
    setCode: c.set.toUpperCase(),
    number: c.collector_number,
    rarity: c.rarity.charAt(0).toUpperCase() + c.rarity.slice(1),
    image: img?.normal,
    imageLarge: img?.large,
    prices: Object.keys(prices).length ? prices : undefined,
    variants: variants.length ? variants : ['Normal'],
    releaseDate: c.released_at,
    url: c.purchase_uris?.tcgplayer ?? c.scryfall_uri,
    details,
    source: 'scryfall',
  };
}

async function bySetNumber(set: string, number: string, fresh = false): Promise<CardPrinting[]> {
  const c = await getJsonOrNull<SfCard>(`${API}/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number)}`, { fresh });
  return c ? [fromScryfall(c)] : [];
}

async function query(q: string, extra: Record<string, string> = {}): Promise<SfCard[]> {
  const res = await getJsonOrNull<SfList<SfCard>>(`${API}/cards/search?${qs({ q, unique: 'prints', order: 'released', ...extra })}`);
  return res?.data ?? [];
}

/** Every printing of the card whose name best matches the (possibly misread) text. */
async function byName(name: string): Promise<CardPrinting[]> {
  const hit = await getJsonOrNull<SfCard>(`${API}/cards/named?${qs({ fuzzy: name })}`);
  const exact = hit?.name ?? name;
  return (await query(`!"${exact.replace(/"/g, '')}"`)).map(fromScryfall);
}

function score(card: CardPrinting, hints: ScanHints): number {
  const nameText = hints.nameText || hints.name;
  return weightedScore([
    [0.5, nameText ? partialSimilarity(card.name.split(' // ')[0]!, nameText) : undefined],
    [0.3, hints.number ? (sameCollectorNumber(card.number, hints.number) ? 1 : 0) : undefined],
    [0.2, hints.setCode ? (normalize(card.setCode) === normalize(hints.setCode) ? 1 : 0) : undefined],
  ]);
}

export const mtg: Game = {
  id: 'mtg',
  name: 'Magic',
  regions: REGIONS.mtg,
  parse: parseMtg,

  async identify(hints) {
    const jobs: Array<Promise<CardPrinting[]>> = [];
    if (hints.setCode && hints.number) jobs.push(bySetNumber(hints.setCode, hints.number.replace(/^0+(?=\d)/, '')));
    if (hints.name) jobs.push(byName(hints.name));
    const settled = await Promise.allSettled(jobs);
    const found = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!found.length && settled.some((r) => r.status === 'rejected')) throw (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    return rank(found.map((card): Candidate => ({ card, score: score(card, hints) })));
  },

  async search(input) {
    const q = input.trim();
    if (!q) return [];
    // "M21 123", "dom 45"
    const m = /^([A-Za-z0-9]{3,5})\s+#?(\d{1,4}[a-z★]?)$/.exec(q);
    if (m) {
      const hit = await bySetNumber(m[1]!, m[2]!);
      if (hit.length) return hit;
    }
    return (await query(q)).slice(0, 80).map(fromScryfall);
  },

  async sets() {
    const res = await getJson<SfList<SfSet>>(`${API}/sets`, { timeoutMs: 30000 });
    return res.data
      .filter((s) => !s.digital && s.card_count > 0 && !SKIP_SET_TYPES.has(s.set_type))
      .map(
        (s): CardSet => ({
          game: 'mtg',
          id: s.code,
          name: s.name,
          code: s.code.toUpperCase(),
          total: s.card_count,
          releaseDate: s.released_at,
          series: s.set_type.replace(/_/g, ' '),
          logo: s.icon_svg_uri,
        }),
      )
      .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  },

  async setCards(set) {
    const out: SfCard[] = [];
    let url: string | undefined = `${API}/cards/search?${qs({ q: `e:${set.id}`, unique: 'prints', order: 'set', include_extras: 'true', include_variations: 'true' })}`;
    for (let page = 0; url && page < 20; page++) {
      const res: SfList<SfCard> | null = await getJsonOrNull<SfList<SfCard>>(url, { timeoutMs: 30000 });
      if (!res) break;
      out.push(...res.data);
      url = res.has_more ? res.next_page : undefined;
    }
    return out.map(fromScryfall);
  },

  async refresh(cards) {
    // One request per card, four at a time, well inside Scryfall's 10/second.
    const out = new Map<string, CardPrinting>();
    await pool(cards, 4, async (c) => {
      const [hit] = await bySetNumber(c.setCode, c.number, true).catch(() => []);
      if (hit) out.set(hit.key, hit);
    });
    return out;
  },
};
