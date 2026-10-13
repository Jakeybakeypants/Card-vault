import { describe, expect, it } from 'vitest';
import type { CardPrinting, CardSet, CollectionEntry } from '../types';
import { entryInSet, filledAt, ownedSlots, slotsFor } from './progress';

function card(p: Partial<CardPrinting> & Pick<CardPrinting, 'key' | 'number'>): CardPrinting {
  return { game: 'pokemon', name: 'X', setName: 'Scarlet & Violet', setCode: 'SVI', variants: ['Normal'], details: {}, source: 'pokemontcg.io', ...p };
}
function entry(c: CardPrinting, addedAt = '2026-01-01T00:00:00Z', variant = 'Normal'): CollectionEntry {
  return { id: `${c.key}|${variant}`, card: c, quantity: 1, variant, condition: 'NM', language: 'EN', addedAt, updatedAt: addedAt };
}

const sv1: CardSet = { game: 'pokemon', id: 'sv1', name: 'Scarlet & Violet', code: 'SVI', total: 258 };

describe('slotsFor', () => {
  it('orders by collector number and merges duplicates', () => {
    const slots = slotsFor([card({ key: 'sv1-10', number: '10/198' }), card({ key: 'sv1-2', number: '2/198' }), card({ key: 'sv1-2b', number: '002/198' }), card({ key: 'sv1-TG1', number: 'TG01/TG30' })]);
    expect(slots.map((s) => s.id)).toEqual(['2', '10', 'TG1']);
  });

  it('uses the full set code for Yu-Gi-Oh!', () => {
    const ygo = (number: string, rarity: string) => card({ game: 'yugioh', key: `${number}:${rarity}`, number, rarity });
    expect(slotsFor([ygo('LOB-EN005', 'Ultra Rare'), ygo('LOB-EN001', 'Common'), ygo('LOB-EN005', 'Secret Rare')]).map((s) => s.id)).toEqual(['LOB-EN001', 'LOB-EN005']);
  });
});

describe('ownedSlots', () => {
  it('fills a slot from any variant and ignores other sets', () => {
    const owned = ownedSlots(sv1, [
      entry(card({ key: 'sv1-25', number: '25/198' })),
      entry(card({ key: 'sv1-25', number: '25/198' }), undefined, 'Reverse Holofoil'),
      entry(card({ key: 'sv2-25', number: '25/193', setName: 'Paldea Evolved' })),
    ]);
    expect([...owned.keys()]).toEqual(['25']);
    expect(owned.get('25')).toHaveLength(2);
  });

  it('matches TCGdex entries to pokemontcg.io sets by name', () => {
    const dex = card({ key: 'sv01-025', number: '025/198', source: 'tcgdex' });
    expect(entryInSet(entry(dex), sv1)).toBe(true);
    expect(ownedSlots(sv1, [entry(dex)]).has('25')).toBe(true);
  });

  it('does not match a same-named set by name within one catalog', () => {
    expect(entryInSet(entry(card({ key: 'other-1', number: '1/10' })), sv1)).toBe(false);
  });
});

it('filledAt is the earliest add', () => {
  const c = card({ key: 'sv1-1', number: '1/198' });
  expect(filledAt([entry(c, '2026-03-01T00:00:00Z'), entry(c, '2026-02-01T00:00:00Z')])).toBe('2026-02-01T00:00:00Z');
});
