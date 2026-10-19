import { describe, expect, it, vi } from 'vitest';
import type { CardPrinting } from '../types';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

// Just enough DOM for `h()`: elements with children and a textContent.
class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  className = '';
  constructor(public text = '') {}
  appendChild(c: FakeNode): void {
    this.children.push(c);
  }
  replaceChildren(): void {
    this.children = [];
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
}
vi.stubGlobal('Node', FakeNode);
vi.stubGlobal('document', { createElement: () => new FakeNode(), createTextNode: (t: string) => new FakeNode(t) });

const { noPriceText, priceNote } = await import('./cards');

const card = (over: Partial<CardPrinting>): CardPrinting => ({
  game: 'pokemon', key: 'k', name: 'X', setName: 'S', setCode: 's', number: '1/10', variants: ['Holofoil', 'Reverse Holofoil'], details: {}, source: 'tcgdex', ...over,
});

describe('price texts', () => {
  it('names the finish that is priced instead of borrowing its price', () => {
    expect(noPriceText(card({ prices: { Holofoil: 9 } }), 'Reverse Holofoil')).toBe('No Reverse Holofoil price · Holofoil $9.00');
    expect(noPriceText(card({ prices: { 'Unlimited Holofoil': 300 } }), '1st Edition Holofoil')).toBe('No 1st Edition Holofoil price · Unlimited Holofoil $300.00');
    expect(noPriceText(card({}), 'Normal')).toBe('No price for Normal');
  });

  it('says when the catalog has no market price for the printing', () => {
    const note = priceNote(card({}));
    expect(note && note.textContent).toBe('No market price in the catalog for this printing');
    // A partial result that couldn't be completed is unknown, not unpriced.
    expect(priceNote(card({ partial: true }))).toBe(false);
  });

  it('shows the source’s own price date and when the app last checked', () => {
    const note = priceNote(card({ prices: { Holofoil: 9 }, priceSource: 'TCGplayer market (via TCGdex, prices of 2026-10-12)', pricesUpdatedAt: '2026-10-19T08:00:00Z' }));
    const text = note ? note.textContent : '';
    expect(text).toContain('prices of 2026-10-12');
    expect(text).toContain(`checked ${new Date('2026-10-19T08:00:00Z').toLocaleDateString()}`);
  });
});
