import { describe, expect, it } from 'vitest';
import type { CardPrinting, CollectionEntry } from '../types';
import { entryValue, otherPrice, sameFinish, unitPrice } from './store';

const card = (over: Partial<CardPrinting>): CardPrinting => ({
  game: 'pokemon', key: 'k', name: 'X', setName: 'S', setCode: 's', number: '1/10', variants: ['Normal'], details: {}, source: 'tcgdex', ...over,
});
const entry = (c: CardPrinting, variant: string, quantity = 1): CollectionEntry => ({ id: 'x', card: c, quantity, variant, condition: 'NM', language: 'EN', addedAt: '', updatedAt: '' });

describe('unitPrice: exactly this finish, never a neighbour', () => {
  it('has no price for a reverse holo when TCGplayer only lists the holofoil', () => {
    const c = card({ prices: { Holofoil: 9 }, variants: ['Holofoil', 'Reverse Holofoil'] });
    expect(unitPrice(c, 'Holofoil')).toBe(9);
    expect(unitPrice(c, 'Reverse Holofoil')).toBeUndefined();
    expect(otherPrice(c, 'Reverse Holofoil')).toEqual({ finish: 'Holofoil', value: 9 });
    expect(otherPrice(c, 'Holofoil')).toBeUndefined();
  });

  it('does not price a 1st Edition Holofoil at the Unlimited Holofoil price', () => {
    const c = card({ prices: { 'Unlimited Holofoil': 300 }, variants: ['Unlimited Holofoil'] });
    expect(unitPrice(c, '1st Edition Holofoil')).toBeUndefined();
    expect(otherPrice(c, '1st Edition Holofoil')).toEqual({ finish: 'Unlimited Holofoil', value: 300 });
  });

  it('Magic: a foil copy priced only non-foil has no price', () => {
    const c = card({ game: 'mtg', prices: { Normal: 1.5 }, variants: ['Normal', 'Foil'], source: 'scryfall' });
    expect(unitPrice(c, 'Foil')).toBeUndefined();
    expect(otherPrice(c, 'Foil')).toEqual({ finish: 'Normal', value: 1.5 });
  });

  it('behaves the same whether one or several other finishes are priced', () => {
    const c = card({ prices: { Holofoil: 9, 'Reverse Holofoil': 12 }, variants: ['Holofoil', 'Reverse Holofoil'] });
    expect(unitPrice(c, '1st Edition Holofoil')).toBeUndefined();
    // The base finish is named first.
    expect(otherPrice(c, '1st Edition Holofoil')).toEqual({ finish: 'Holofoil', value: 9 });
  });

  it('treats Normal and Unlimited (Holofoil and Unlimited Holofoil) as the same physical card', () => {
    const c = card({ prices: { Unlimited: 0.3, '1st Edition': 1.5 }, variants: ['Unlimited', '1st Edition'] });
    expect(unitPrice(c, 'Normal')).toBe(0.3);
    expect(unitPrice(c, 'Unlimited')).toBe(0.3);
    expect(otherPrice(c, 'Normal')).toBeUndefined();
    expect(unitPrice(card({ prices: { 'Unlimited Holofoil': 300 } }), 'Holofoil')).toBe(300);
    expect(unitPrice(card({ prices: { Holofoil: 2 } }), 'Unlimited Holofoil')).toBe(2);
    expect(sameFinish('Normal', 'Unlimited')).toBe(true);
    expect(sameFinish('Normal', 'Holofoil')).toBe(false);
  });

  it('uses the `default` price for every printing (Yu-Gi-Oh!)', () => {
    expect(unitPrice(card({ game: 'yugioh', prices: { default: 45.1 }, source: 'ygoprodeck' }), '1st Edition')).toBe(45.1);
  });

  it('values an entry only by its own finish, so tiles, CSV and the total agree', () => {
    const c = card({ prices: { Holofoil: 9 }, variants: ['Holofoil', 'Reverse Holofoil'] });
    expect(entryValue(entry(c, 'Reverse Holofoil', 3))).toBeUndefined();
    expect(entryValue(entry(c, 'Holofoil', 3))).toBe(27);
    expect(entryValue(entry(card({}), 'Normal'))).toBeUndefined();
  });
});
