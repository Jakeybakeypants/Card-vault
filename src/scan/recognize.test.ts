import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardPrinting } from '../types';
import type { OcrResult } from './ocr';
import { guessFinish, mergeHints, readWithOcr } from './recognize';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

// OCR and vision need a browser; readWithOcr is tested on scripted reads.
const reads: Record<string, string[]> = {};
const rereads: string[] = [];
const ocr = (text: string): OcrResult => ({ text, words: text.split(/\s+/).filter(Boolean).map((t) => ({ text: t, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } })), image: {} as HTMLCanvasElement });
vi.mock('./ocr', () => ({
  ocrRegions: async (_card: unknown, regions: Array<{ key: string }>) => Object.fromEntries(regions.map((r) => [r.key, ocr(reads[r.key]?.shift() ?? '')])),
  ocrRegion: async (_card: unknown, r: { key: string; y: number }, invert = false) => ocr(reads[`${r.key}${r.y > 0.05 && r.key === 'name' ? ' (lower)' : ''}${invert ? ' (inverted)' : ''}`]?.shift() ?? ''),
  rereadWord: async () => rereads.shift() ?? '',
}));
vi.mock('./vision', async (importOriginal) => ({ ...(await importOriginal<typeof import('./vision')>()), hasGlare: () => false }));
vi.mock('./ai', () => ({ readCardWithClaude: async () => ({}) }));

const canvas = {} as HTMLCanvasElement;

describe('readWithOcr', () => {
  beforeEach(() => {
    for (const k of Object.keys(reads)) delete reads[k];
    rereads.length = 0;
  });

  it('keeps the strip read when the second look glues a letter on (P1)', async () => {
    reads.name = ['BASIC Zacian V HP 220'];
    reads.bottom = ['Illus. 5ban Graphics 187/202 ©2020 Pokémon'];
    rereads.push('V187/202');
    const h = await readWithOcr('pokemon', canvas);
    expect(h).toMatchObject({ number: '187', total: '202', name: 'Zacian V' });
    expect(h.raw?.['bottom (second look)']).toBe('V187/202');
  });

  it('takes the second look when it is the plausible read', async () => {
    reads.name = ['BASIC Pikachu HP 60'];
    reads.bottom = ['Illus. Atsuko Nishida V156/202'];
    rereads.push('156/202');
    expect(await readWithOcr('pokemon', canvas)).toMatchObject({ number: '156', total: '202' });
  });

  it('reads the strip under a TRAINER banner for the name and records the category (P6)', async () => {
    reads.name = ['TRAINER'];
    reads['name (lower)'] = ['Bill'];
    reads.bottom = ['91/102'];
    const h = await readWithOcr('pokemon', canvas);
    expect(h).toMatchObject({ name: 'Bill', category: 'trainer', number: '91', total: '102' });
    expect(h.raw?.['name (lower)']).toBe('Bill');
    expect(h.nameText).toContain('Bill');
  });

  it('records the inverted re-reads even when they are not used', async () => {
    reads.name = ['', '', ''];
    reads['name (lower)'] = [''];
    reads['name (inverted)'] = ['noise'];
    reads.bottom = ['nothing here'];
    reads['bottom (inverted)'] = ['still nothing'];
    const h = await readWithOcr('pokemon', canvas);
    expect(h.number).toBeUndefined();
    expect(h.raw).toMatchObject({ 'bottom (inverted)': 'still nothing', 'name (inverted)': 'noise', 'name (lower)': '' });
  });
});

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
    expect(mergeHints([{ category: 'trainer' }, { name: 'Bill' }]).category).toBe('trainer');
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
