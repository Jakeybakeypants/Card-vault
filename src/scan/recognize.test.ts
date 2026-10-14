import { describe, expect, it, vi } from 'vitest';
import type { CardPrinting } from '../types';
import { guessFinish, mergeHints } from './recognize';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

const card = (variants: string[]): CardPrinting => ({
  game: 'pokemon',
  key: 'k',
  name: 'Furret',
  setName: 'S',
  setCode: 's',
  number: '136/189',
  variants,
  details: {},
  source: 'test',
});

describe('mergeHints', () => {
  it('takes the number most frames agree on', () => {
    const m = mergeHints([
      { number: '136', total: '189', name: 'Furret' },
      { number: '135', total: '189' },
      { number: '136', total: '189', nameText: 'Furret HP 110' },
    ]);
    expect(m).toMatchObject({ number: '136', total: '189', name: 'Furret' });
  });

  it('fills in what one frame missed from another', () => {
    const m = mergeHints([{ name: 'Dark Magician' }, { setCode: 'LOB-EN005', variant: '1st Edition' }]);
    expect(m).toMatchObject({ name: 'Dark Magician', setCode: 'LOB-EN005', variant: '1st Edition' });
  });
});

describe('guessFinish', () => {
  it('is certain when the card only exists in one finish', () => {
    expect(guessFinish(card(['Holofoil']), {}, 0.9)).toEqual({ variant: 'Holofoil', confidence: 1 });
  });

  it('uses the shimmer to pick reverse holo, and is unsure in the middle', () => {
    expect(guessFinish(card(['Normal', 'Reverse Holofoil']), {}, 0.95).variant).toBe('Reverse Holofoil');
    expect(guessFinish(card(['Normal', 'Reverse Holofoil']), {}, 0.02).variant).toBe('Normal');
    expect(guessFinish(card(['Normal', 'Reverse Holofoil']), {}, 0.2).confidence).toBeLessThan(0.7);
  });

  it('trusts a finish read off the card (1st Edition stamp, Claude)', () => {
    expect(guessFinish(card(['Unlimited', '1st Edition']), { variant: '1st Edition' }, undefined).variant).toBe('1st Edition');
  });
});
