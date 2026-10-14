import { describe, expect, it } from 'vitest';
import { parseLorcana, parseMtg, parsePokemon, parseYugioh } from './parse';
import { partialSimilarity, sameCollectorNumber, stripLeadingZeros } from '../util/text';

describe('parsePokemon', () => {
  it('reads a Scarlet & Violet bottom line', () => {
    const h = parsePokemon({ name: 'BASIC Pikachu HP 60', bottom: 'G SVI EN 063/198 Illus. Naoki Saito' });
    expect(h).toMatchObject({ number: '063', total: '198', setCode: 'SVI', language: 'EN', name: 'Pikachu' });
  });

  it('reads a WotC-era number on the right', () => {
    const h = parsePokemon({ name: 'Charizard 120 HP', bottom: 'Illus. Mitsuhiro Arita ©1995, 96, 98 Nintendo 4/102 ★' });
    expect(h).toMatchObject({ number: '4', total: '102', name: 'Charizard' });
  });

  it('splits a set code run into the language', () => {
    expect(parsePokemon({ bottom: 'G SVIEN 063/198 ¢' })).toMatchObject({ setCode: 'SVI', language: 'EN', number: '063' });
  });

  it('does not mistake the language for a set code', () => {
    const h = parsePokemon({ bottom: "'G svi EN 063/198 °" });
    expect(h).toMatchObject({ number: '063', total: '198', language: 'EN' });
    expect(h.setCode).toBeUndefined();
  });

  it('offers name-like words from a noisy name strip as search candidates', () => {
    const h = parsePokemon({ name: '4 -\n~ A,\nk Metagross »" Sommseeaes - 100 HP "1' });
    expect(h.nameCandidates).toContain('Metagross');
    expect(parsePokemon({ name: 'BASIC Pi =H\n>> Pikachuz=Y 4,190 4}' }).nameCandidates).toContain('Pikachuz');
  });

  it('drops misread stage words', () => {
    expect(parsePokemon({ name: 'sasic Pikachu we 60' }).name).toBe('Pikachu');
  });

  it('fixes common OCR digit confusions', () => {
    expect(parsePokemon({ bottom: 'PAL EN O25/l93' })).toMatchObject({ number: '025', total: '193' });
    expect(parsePokemon({ bottom: '1O2/1O2' })).toMatchObject({ number: '102', total: '102' });
  });

  it('keeps subset prefixes', () => {
    expect(parsePokemon({ bottom: 'TG05/TG30' })).toMatchObject({ number: 'TG05', total: 'TG30' });
    expect(parsePokemon({ bottom: 'GG12 / GG70' })).toMatchObject({ number: 'GG12', total: 'GG70' });
  });

  it('accepts | as the separator', () => {
    expect(parsePokemon({ bottom: 'D 136 | 202' })).toMatchObject({ number: '136', total: '202' });
  });

  it('reads Black Star promo numbers', () => {
    expect(parsePokemon({ bottom: 'SWSH050' })).toMatchObject({ number: 'SWSH050' });
    expect(parsePokemon({ bottom: 'SM 210' })).toMatchObject({ number: 'SM210' });
  });

  it('pulls a multi-word name out of stage and HP noise', () => {
    expect(parsePokemon({ name: 'STAGE 2 Charizard ex HP 330' }).name).toBe('Charizard ex');
    expect(parsePokemon({ name: 'BASIC\nMew V HP180' }).name).toBe('Mew V');
  });

  it('returns no number when there is none', () => {
    expect(parsePokemon({ bottom: 'Illus. 5ban Graphics' }).number).toBeUndefined();
  });
});

describe('parseYugioh', () => {
  it('reads a set code and edition', () => {
    const h = parseYugioh({ name: 'Blue-Eyes White Dragon DARK', middle: '1st Edition   LOB-EN001', bottom: '89631139   ©1996 KAZUKI TAKAHASHI' });
    expect(h).toMatchObject({ setCode: 'LOB-EN001', variant: '1st Edition', passcode: '89631139', language: 'EN', name: 'Blue-Eyes White Dragon' });
  });

  it('keeps attribute words that are part of the name', () => {
    expect(parseYugioh({ name: '| Dark Magician' }).name).toBe('Dark Magician');
    expect(parseYugioh({ name: 'Light and Darkness Dragon LIGHT' }).name).toBe('Light and Darkness Dragon');
  });

  it('reads codes without region letters and with OCR slips', () => {
    expect(parseYugioh({ middle: 'SDY-O06' }).setCode).toBe('SDY-006');
    expect(parseYugioh({ middle: 'RA01-ENOl6' }).setCode).toBe('RA01-EN016');
  });

  it('maps region letters to languages', () => {
    expect(parseYugioh({ middle: 'LOB-G001' }).language).toBe('DE');
    expect(parseYugioh({ middle: 'MP23-FR001' }).language).toBe('FR');
  });

  it('finds the set code on Pendulum cards near the bottom', () => {
    expect(parseYugioh({ middle: '', bottom: 'MP15-EN077 Limited Edition\n12345678' })).toMatchObject({ setCode: 'MP15-EN077', variant: 'Limited Edition' });
  });

  it('ignores codes without a letter in the prefix', () => {
    expect(parseYugioh({ middle: '1996-2002' }).setCode).toBeUndefined();
  });
});

describe('text helpers', () => {
  it('matches names buried in OCR noise', () => {
    expect(partialSimilarity('Pikachu', 'BASIC Pikachu HP 60 @')).toBe(1);
    expect(partialSimilarity('Pikachu', 'BASIC Plkachu HP 60')).toBeGreaterThan(0.8);
    expect(partialSimilarity('Charizard', 'BASIC Pikachu HP 60')).toBeLessThan(0.5);
  });

  it('compares collector numbers ignoring zero padding', () => {
    expect(stripLeadingZeros('025')).toBe('25');
    expect(stripLeadingZeros('TG05')).toBe('TG5');
    expect(sameCollectorNumber('025', '25')).toBe(true);
    expect(sameCollectorNumber('TG05', 'TG5')).toBe(true);
    expect(sameCollectorNumber('25', '125')).toBe(false);
  });
});

describe('parseMtg', () => {
  it('reads a modern collector line', () => {
    const h = parseMtg({ name: 'Lightning Bolt', bottom: '0125 C\nM21 • EN  Christopher Moeller' });
    expect(h).toMatchObject({ number: '125', setCode: 'M21', language: 'EN', name: 'Lightning Bolt' });
  });

  it('reads a 2015–2019 number with total', () => {
    expect(parseMtg({ bottom: '123/269 R\nDOM • EN' })).toMatchObject({ number: '123', total: '269', setCode: 'DOM' });
  });

  it('fixes OCR digit confusions', () => {
    expect(parseMtg({ bottom: 'O2S U\nNEO * JA' })).toMatchObject({ number: '25', setCode: 'NEO', language: 'JP' });
  });
});

describe('parseLorcana', () => {
  it('reads number, language and set', () => {
    const h = parseLorcana({ name: 'MICKEY MOUSE\nBrave Little Tailor', bottom: 'Illus. Someone\n115/204 • EN • 1' });
    expect(h).toMatchObject({ number: '115', total: '204', language: 'EN', setCode: '1', name: 'MICKEY MOUSE - Brave Little Tailor' });
  });

  it('keeps enchanted numbers above the set size', () => {
    expect(parseLorcana({ bottom: '2O7/2O4 · EN · 2' })).toMatchObject({ number: '207', total: '204', setCode: '2' });
  });
});

describe('Pokémon promos', () => {
  it('reads Scarlet & Violet and Mega Evolution promo numbers', () => {
    expect(parsePokemon({ bottom: 'G SVP EN 085 Illus. 5ban Graphics' })).toMatchObject({ number: '085', setCode: 'SVP', language: 'EN' });
    expect(parsePokemon({ bottom: 'I MEP EN 012' })).toMatchObject({ number: '012', setCode: 'MEP' });
    expect(parsePokemon({ bottom: 'SWSH050' })).toMatchObject({ number: 'SWSH050' });
  });
});

describe('Pokémon subset numbers', () => {
  it('repairs a mangled size prefix from the number’s prefix', () => {
    expect(parsePokemon({ bottom: 'SV107/5v122' })).toMatchObject({ number: 'SV107', total: 'SV122' });
    expect(parsePokemon({ bottom: 'TG05/T630' })).toMatchObject({ number: 'TG05', total: 'TG30' });
    expect(parsePokemon({ bottom: 'GG44/GG70' })).toMatchObject({ number: 'GG44', total: 'GG70' });
  });

  it('reads a bare Shiny Vault number as one, not as an SVP promo', () => {
    expect(parsePokemon({ bottom: 'SV107 Illus. 5ban' })).toMatchObject({ number: 'SV107' });
    expect(parsePokemon({ bottom: 'SV107' }).setCode).toBeUndefined();
  });
});
