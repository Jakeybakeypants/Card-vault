import { describe, expect, it } from 'vitest';
import { candidateSets, CLASSIC_COLLECTION, classicPrintedNumber, classicReprints, localIdIn, pokemonSet, promoCodeDoubtful, promoSet, repairedSizes, sameTotal, setsForCode } from './pokemonSetIndex';

describe('pokemon set index', () => {
  const ids = (sets: Array<{ id: string }>) => sets.map((s) => s.id);

  it('names the set from the printed code, and the gallery from a TG/GG number', () => {
    expect(ids(candidateSets({ number: '063', total: '198', setCode: 'SVI' }))).toEqual(['sv01']);
    expect(ids(setsForCode('BRS', 'TG05'))).toEqual(['swsh9tg']);
    expect(ids(setsForCode('BRS', '123'))).toEqual(['swsh9']);
    expect(ids(setsForCode('CRZ', 'GG01'))).toEqual(['swsh12.5gg']);
  });

  it('falls back to every set of the printed size, newest first, within the subset family', () => {
    expect(ids(candidateSets({ number: 'TG05', total: 'TG30' }))).toEqual(['swsh12tg', 'swsh11tg', 'swsh10tg', 'swsh9tg']);
    expect(ids(candidateSets({ number: 'SV001', total: 'SV122' }))).toEqual(['swsh4.5sv']);
    expect(ids(candidateSets({ number: 'SV1', total: 'SV94' }))).toEqual(['sma']);
    expect(ids(candidateSets({ number: 'RC5', total: 'RC25' }))).toContain('bw11');
    const s198 = ids(candidateSets({ number: '201', total: '198' }));
    expect(s198.indexOf('sv01')).toBeLessThan(s198.indexOf('swsh6'));
  });

  it('puts the set AI scan named first', () => {
    expect(ids(candidateSets({ number: 'TG05', total: 'TG30', setName: 'Brilliant Stars' }))[0]).toBe('swsh9tg');
    expect(ids(candidateSets({ number: '201', total: '198', setName: 'Chilling Reign' }))[0]).toBe('swsh6');
  });

  it('knows promo prefixes and each set’s id padding', () => {
    expect(promoSet({ number: 'SWSH050' })).toBe('swshp');
    expect(promoSet({ number: '085', setCode: 'SVP' })).toBe('svp');
    expect(localIdIn(pokemonSet('sv01')!, '25')).toBe('025');
    expect(localIdIn(pokemonSet('swsh9tg')!, 'TG5')).toBe('TG05');
    expect(localIdIn(pokemonSet('smp')!, 'SM7')).toBe('SM07');
    expect(localIdIn(pokemonSet('swsh1')!, '025')).toBe('25');
    expect(sameTotal('TG30', '30')).toBe(true);
    expect(sameTotal('198', '199')).toBe(false);
  });
});

describe('misread sizes, promo codes and Classic Collection reprints', () => {
  const ids = (sets: Array<{ id: string }>) => sets.map((s) => s.id);

  it('repairs a size no set prints: a stray digit, then one digit wrong, only to printed sizes', () => {
    expect(repairedSizes('1982', new Set(['198', '982', '193']))).toEqual(['198', '982']);
    expect(repairedSizes('190', new Set(['198', '193', '191', '90', '100']))).toEqual(['90', '191', '193', '198', '100']);
    expect(repairedSizes('198', new Set(['198', '193']))).toEqual(['193']);
    // A size some set prints is taken as read: no repairs.
    expect(ids(candidateSets({ number: '063', total: '198' }))).toContain('sv01');
    expect(ids(candidateSets({ number: '063', total: '198' }))).not.toContain('sv02');
    expect(ids(candidateSets({ number: '063', total: '1982' }))).toContain('sv01');
    expect(ids(candidateSets({ number: '063', total: '190' }))).toEqual(expect.arrayContaining(['sv02', 'sv08']));
    // Within the subset family only.
    expect(ids(candidateSets({ number: 'TG05', total: 'TG36' }))).toEqual(['swsh12tg', 'swsh11tg', 'swsh10tg', 'swsh9tg']);
  });

  it('doubts a promo code read beside a set size, never one the number itself carries', () => {
    expect(promoCodeDoubtful({ number: '005', total: '198', setCode: 'SVP' })).toBe(true);
    expect(promoCodeDoubtful({ number: '085', setCode: 'SVP' })).toBe(false);
    expect(promoCodeDoubtful({ number: 'SWSH050', total: '198' })).toBe(false);
    expect(promoCodeDoubtful({ number: '063', total: '198', setCode: 'SVI' })).toBe(false);
  });

  it('maps the line printed on a Classic Collection reprint both ways', () => {
    expect(classicPrintedNumber('cel25cc-CC002')).toEqual({ number: '4', total: '102' });
    expect(classicPrintedNumber('cel25cc-CC008')).toEqual({ number: '24', total: '' });
    expect(classicPrintedNumber('base1-4')).toBeUndefined();
    expect(classicReprints('4', '102')).toEqual(['CC002']);
    expect(classicReprints('004', '102')).toEqual(['CC002']);
    expect(classicReprints('15', '102')).toEqual(['CC003']);
    expect(classicReprints('15', '82')).toEqual(['CC006']);
    expect(classicReprints('24', undefined)).toEqual([]);
    expect(classicReprints('4', '130')).toEqual([]);
    expect(Object.keys(CLASSIC_COLLECTION)).toHaveLength(25);
  });
});
