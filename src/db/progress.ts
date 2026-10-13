import type { CardPrinting, CardSet, CollectionEntry } from '../types';
import { stripLeadingZeros } from '../util/text';

/**
 * Set completion: which slots of a set the collection fills. A slot is one collector number
 * (Pokémon `25`, Yu-Gi-Oh! `LOB-EN005`, Magic `123`, Lorcana `12`); owning any variant, rarity
 * or condition of it fills it.
 */

export interface SetSlot {
  /** Collector number, normalised so different paddings of the same number agree. */
  id: string;
  card: CardPrinting;
}

export function slotId(card: CardPrinting): string {
  if (card.game === 'yugioh') return card.number.toUpperCase();
  return stripLeadingZeros(card.number.split('/')[0] ?? card.number).toUpperCase();
}

/** One slot per collector number, in collector-number order. */
export function slotsFor(cards: CardPrinting[]): SetSlot[] {
  const byId = new Map<string, SetSlot>();
  for (const card of cards) {
    const id = slotId(card);
    if (!byId.has(id)) byId.set(id, { id, card });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** pokemontcg.io keys are `<setId>-<number>`; TCGdex keys are `<setId>-<localId>`. */
function keySet(key: string): string {
  return key.slice(0, key.lastIndexOf('-'));
}

export function entryInSet(e: CollectionEntry, set: CardSet): boolean {
  if (e.card.game !== set.game) return false;
  if (set.game === 'yugioh') return e.card.setName === set.name;
  if (set.game !== 'pokemon') return e.card.setCode.toUpperCase() === set.code.toUpperCase();
  const setId = set.id.replace(/^dex:/, '');
  if (keySet(e.card.key) === setId) return true;
  // Entries from the other Pokémon catalog have different ids; fall back to the set name.
  const sameSource = set.id.startsWith('dex:') === (e.card.source === 'tcgdex');
  return !sameSource && e.card.setName === set.name;
}

/** The collection's entries for one set, grouped by slot. */
export function ownedSlots(set: CardSet, entries: CollectionEntry[]): Map<string, CollectionEntry[]> {
  const out = new Map<string, CollectionEntry[]>();
  for (const e of entries) {
    if (!entryInSet(e, set)) continue;
    const id = slotId(e.card);
    const list = out.get(id);
    if (list) list.push(e);
    else out.set(id, [e]);
  }
  return out;
}

/** When a slot was first filled: the earliest add among its entries. */
export function filledAt(entries: CollectionEntry[]): string {
  return entries.reduce((min, e) => (e.addedAt < min ? e.addedAt : min), entries[0]?.addedAt ?? '');
}
