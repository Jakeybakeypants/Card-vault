import { describe, expect, it } from 'vitest';
import { candidateSets, localIdIn, pokemonSet, promoSet, sameTotal, setsForCode } from './pokemonSetIndex';

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
