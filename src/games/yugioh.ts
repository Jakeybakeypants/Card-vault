import { parseYugioh, REGIONS } from '../scan/parse';
import type { Candidate, CardPrinting, ScanHints } from '../types';
import { partialSimilarity, similarity } from '../util/text';
import { rank, weightedScore, type Game } from './game';
import { getJsonOrNull, qs } from './http';

// YGOPRODeck API v7: free and keyless (20 requests/second). https://ygoprodeck.com/api-guide/
const API = 'https://db.ygoprodeck.com/api/v7';

interface YgoSet {
  set_name: string;
  set_code: string;
  set_rarity: string;
  set_rarity_code?: string;
  set_price: string;
  set_edition?: string;
}
interface YgoCard {
  id: number;
  name: string;
  type: string;
  frameType: string;
  desc: string;
  ygoprodeck_url?: string;
  atk?: number;
  def?: number;
  level?: number;
  linkval?: number;
  race: string;
  attribute?: string;
  archetype?: string;
  card_sets?: YgoSet[];
  card_images: Array<{ id: number; image_url: string; image_url_small: string }>;
  card_prices?: Array<{ tcgplayer_price?: string; cardmarket_price?: string }>;
}
interface YgoSetInfo {
  id: number;
  name: string;
  set_name: string;
  set_code: string;
  set_rarity: string;
  set_price: string;
}

export const YUGIOH_VARIANTS = ['Unlimited', '1st Edition', 'Limited Edition'];

function price(s?: string): number | undefined {
  const v = s ? Number.parseFloat(s) : NaN;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function printing(card: YgoCard, set: YgoSet | undefined): CardPrinting {
  const details: Record<string, string> = { Type: card.type };
  if (card.attribute) details.Attribute = card.attribute;
  details[card.frameType === 'spell' || card.frameType === 'trap' ? 'Property' : 'Race'] = card.race;
  if (card.linkval) details.Link = String(card.linkval);
  else if (card.level) details[card.frameType.startsWith('xyz') ? 'Rank' : 'Level'] = String(card.level);
  if (card.atk !== undefined) details['ATK / DEF'] = `${card.atk} / ${card.def ?? '–'}`;
  if (card.archetype) details.Archetype = card.archetype;
  details.Passcode = String(card.id).padStart(8, '0');

  const img = card.card_images[0];
  const p = price(set?.set_price) ?? price(card.card_prices?.[0]?.tcgplayer_price);
  const edition = set?.set_edition && YUGIOH_VARIANTS.find((v) => set.set_edition!.toLowerCase().startsWith(v.toLowerCase()));
  return {
    game: 'yugioh',
    key: set ? `${set.set_code}:${set.set_rarity}` : `ygo-${card.id}`,
    name: card.name,
    setName: set?.set_name ?? 'No TCG printing',
    setCode: set?.set_code.split('-')[0] ?? '',
    number: set?.set_code ?? String(card.id),
    rarity: set ? `${set.set_rarity}${set.set_rarity_code ? ` ${set.set_rarity_code}` : ''}` : undefined,
    image: img?.image_url_small,
    imageLarge: img?.image_url,
    prices: p !== undefined ? { default: p } : undefined,
    variants: edition ? [edition, ...YUGIOH_VARIANTS.filter((v) => v !== edition)] : YUGIOH_VARIANTS,
    url: card.ygoprodeck_url,
    details,
    source: 'ygoprodeck',
  };
}

function printings(card: YgoCard, onlyCode?: string): CardPrinting[] {
  const sets = card.card_sets ?? [];
  const chosen = onlyCode ? sets.filter((s) => s.set_code.toUpperCase() === onlyCode.toUpperCase()) : sets;
  if (!chosen.length) return onlyCode ? [] : [printing(card, undefined)];
  return chosen.map((s) => printing(card, s));
}

async function cardById(id: number | string): Promise<YgoCard | null> {
  const res = await getJsonOrNull<{ data: YgoCard[] }>(`${API}/cardinfo.php?${qs({ id })}`);
  return res?.data[0] ?? null;
}

async function cardsByName(fname: string, num = 12): Promise<YgoCard[]> {
  const res = await getJsonOrNull<{ data: YgoCard[] }>(`${API}/cardinfo.php?${qs({ fname, num, offset: 0 })}`);
  return res?.data ?? [];
}

/** All printings that carry this exact set code (usually one; several when a set has multiple rarities). */
async function bySetCode(code: string): Promise<CardPrinting[]> {
  const tries = [code];
  // Older North American prints have no region letters ("SDY-006"); the database often files
  // them with "EN". Try both spellings.
  const m = /^([A-Z0-9]+)-(\d{3})$/.exec(code);
  if (m) tries.push(`${m[1]}-EN${m[2]}`);
  for (const c of tries) {
    const info = await getJsonOrNull<YgoSetInfo>(`${API}/cardsetsinfo.php?${qs({ setcode: c })}`);
    if (!info?.id) continue;
    const card = await cardById(info.id);
    if (!card) continue;
    const found = printings(card, c);
    if (found.length) return found;
  }
  return [];
}

function score(card: CardPrinting, hints: ScanHints): number {
  const nameText = hints.nameText || hints.name;
  return weightedScore([
    [0.45, nameText ? partialSimilarity(card.name, nameText) : undefined],
    [0.45, hints.setCode ? similarity(card.number, hints.setCode) ** 4 : undefined],
    [0.1, hints.passcode ? (card.details.Passcode === hints.passcode ? 1 : 0) : undefined],
  ]);
}

export const yugioh: Game = {
  id: 'yugioh',
  name: 'Yu-Gi-Oh!',
  regions: REGIONS.yugioh,
  parse: parseYugioh,

  async identify(hints) {
    const jobs: Array<Promise<CardPrinting[]>> = [];
    if (hints.setCode) jobs.push(bySetCode(hints.setCode));
    if (hints.passcode) jobs.push(cardById(hints.passcode).then((c) => (c ? printings(c) : [])));
    if (hints.name) {
      jobs.push(
        cardsByName(hints.name).then((cards) =>
          cards
            .sort((a, b) => similarity(b.name, hints.name!) - similarity(a.name, hints.name!))
            .slice(0, 4)
            .flatMap((c) => printings(c)),
        ),
      );
    }
    const settled = await Promise.allSettled(jobs);
    const found = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (!found.length && settled.some((r) => r.status === 'rejected')) {
      throw (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    }
    return rank(found.map((card): Candidate => ({ card, score: score(card, hints) })));
  },

  async search(query) {
    const q = query.trim();
    if (!q) return [];
    if (/^[A-Z0-9]{2,4}-[A-Z]{0,2}\d{3}$/i.test(q)) return bySetCode(q.toUpperCase());
    if (/^\d{5,8}$/.test(q)) {
      const card = await cardById(q);
      return card ? printings(card) : [];
    }
    const cards = await cardsByName(q, 20);
    return cards
      .sort((a, b) => similarity(b.name, q) - similarity(a.name, q))
      .slice(0, 6)
      .flatMap((c) => printings(c));
  },
};
