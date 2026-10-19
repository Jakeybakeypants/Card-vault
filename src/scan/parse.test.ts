import { describe, expect, it } from 'vitest';
import { fixSetCode, mergeSecondLook, nameCandidates, parseLorcana, parseMtg, parsePokemon, parseYugioh, plausibleNumber, pokemonCategory } from './parse';
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
    expect(h.setCode).not.toBe('EN');
    // The lowercase code is repaired against the set table.
    expect(h.setCode).toBe('SVI');
    expect(parsePokemon({ bottom: 'G EN 063/198' }).language).toBe('EN');
    expect(parsePokemon({ bottom: 'G EN 063/198' }).setCode).toBeUndefined();
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

describe('Pokémon numbers with glued letters (P2)', () => {
  it('drops a regulation mark or "V rule" letter glued to the number', () => {
    expect(parsePokemon({ bottom: 'V085/202' })).toMatchObject({ number: '085', total: '202' });
    expect(parsePokemon({ bottom: 'E012/198' })).toMatchObject({ number: '012', total: '198' });
    expect(parsePokemon({ bottom: 'D001/202' })).toMatchObject({ number: '001', total: '202' });
    expect(parsePokemon({ bottom: 'F016/025' })).toMatchObject({ number: '016', total: '025' });
    expect(parsePokemon({ bottom: 'RT257/198' })).toMatchObject({ number: '257', total: '198' });
    expect(parsePokemon({ bottom: 'T9/127 S' })).toMatchObject({ number: '9', total: '127' });
  });

  it('never runs the digit fixes over the prefix letters', () => {
    expect(parsePokemon({ bottom: 'SVI EN G063/198' })).toMatchObject({ number: '063', total: '198', setCode: 'SVI' });
    expect(parsePokemon({ bottom: 'S105/217' })).toMatchObject({ number: '105', total: '217' });
  });

  it('keeps H only as the two-digit Crystal Guardians holo prefix', () => {
    expect(parsePokemon({ bottom: 'H002/172' })).toMatchObject({ number: '002', total: '172' });
    expect(parsePokemon({ bottom: 'H5/H12' })).toMatchObject({ number: 'H5', total: 'H12' });
    expect(parsePokemon({ bottom: 'CC1/CC25' })).toMatchObject({ number: 'CC1', total: 'CC25' });
    expect(parsePokemon({ bottom: 'RC5/RC32' })).toMatchObject({ number: 'RC5', total: 'RC32' });
  });
});

describe('Pokémon sizes with a stray digit (P3)', () => {
  it('cuts a 4-digit size back to the printed size', () => {
    expect(parsePokemon({ bottom: 'Mus. Kouki Sedov 42/1140' })).toMatchObject({ number: '42', total: '114' });
    expect(parsePokemon({ bottom: 'Mus. Sywomo Choki 3/1460 ®' })).toMatchObject({ number: '3', total: '146' });
    expect(parsePokemon({ bottom: '©1999 Wizards. 4/1020' })).toMatchObject({ number: '4', total: '102' });
    // Both halves are printed sizes: a leading 1 is the separator read as a digit.
    expect(parsePokemon({ bottom: '43/1102 @' })).toMatchObject({ number: '43', total: '102' });
    expect(parsePokemon({ bottom: '93/1140 BY' })).toMatchObject({ number: '93', total: '114' });
  });

  it('cuts a 3-digit size whose first two digits are the printed size', () => {
    expect(parsePokemon({ bottom: 'g1 1/834' })).toMatchObject({ number: '1', total: '83' });
    expect(parsePokemon({ bottom: '150/149' })).toMatchObject({ number: '150', total: '149' });
    expect(parsePokemon({ bottom: '025/025' })).toMatchObject({ number: '025', total: '025' });
  });

  it('drops a stray digit in front of the number', () => {
    expect(parsePokemon({ bottom: '{00050/202%' })).toMatchObject({ number: '050', total: '202' });
    expect(parsePokemon({ bottom: '4166/198' })).toMatchObject({ number: '166', total: '198' });
    expect(parsePokemon({ bottom: '1157/1230' })).toMatchObject({ number: '115', total: '123' });
  });

  it('skips junk around a separator in favour of the printed pair', () => {
    expect(parsePokemon({ bottom: 'BY svis| 166/198 &' })).toMatchObject({ number: '166', total: '198' });
    expect(parsePokemon({ bottom: '7\n\n/ into the shadows\n\n10/114 %' })).toMatchObject({ number: '10', total: '114' });
    expect(parsePokemon({ bottom: '4\n\nx2\n\n/\n\nII RIN' }).number).toBeUndefined();
    expect(parsePokemon({ bottom: 'ULI 2/13 plliod' }).number).toBeUndefined();
    // A size the table does not know yet (a brand-new set) still reads.
    expect(parsePokemon({ bottom: 'H NEW EN 045/250' })).toMatchObject({ number: '045', total: '250' });
  });
});

describe('Pokémon number suffixes (P4)', () => {
  it('reads a misread last digit as a digit; only a and b are suffixes', () => {
    expect(parsePokemon({ bottom: 'Mus, Kogemaru Hiumeno s/114% BY' })).toMatchObject({ number: '5', total: '114' });
    expect(parsePokemon({ bottom: '©1999 Wizards. 1l/102' })).toMatchObject({ number: '11', total: '102' });
    expect(parsePokemon({ bottom: '©l999 Wizards. 7l/lO2 ★' })).toMatchObject({ number: '71', total: '102' });
    expect(parsePokemon({ bottom: '©1999 Wizards. l/102' })).toMatchObject({ number: '1', total: '102' });
    expect(parsePokemon({ bottom: '28a/83' })).toMatchObject({ number: '28a', total: '83' });
  });
});

describe('Pokémon subset prefixes garbled by OCR', () => {
  it('normalises 5v / Sv / T6 / 16 / 66 to the printed prefix', () => {
    expect(parsePokemon({ bottom: 'sV105/5v122' })).toMatchObject({ number: 'SV105', total: 'SV122' });
    expect(parsePokemon({ bottom: 'D svosi/svi22' })).toMatchObject({ number: 'SV051', total: 'SV122' });
    expect(parsePokemon({ bottom: '1607/1630' })).toMatchObject({ number: 'TG07', total: 'TG30' });
    expect(parsePokemon({ bottom: '6669/6670' })).toMatchObject({ number: 'GG69', total: 'GG70' });
    expect(parsePokemon({ bottom: '® ® TG24/7G30' })).toMatchObject({ number: 'TG24', total: 'TG30' });
    expect(parsePokemon({ bottom: 'GG1/GG70' })).toMatchObject({ number: 'GG1', total: 'GG70' });
    expect(parsePokemon({ bottom: 'GG69/GG70R SES' })).toMatchObject({ number: 'GG69', total: 'GG70' });
  });

  it('copies the prefix from whichever side has it', () => {
    expect(parsePokemon({ bottom: '81/5v94' })).toMatchObject({ number: 'SV81', total: 'SV94' });
    expect(parsePokemon({ bottom: 'TG05/30' })).toMatchObject({ number: 'TG05', total: 'TG30' });
  });

  it('does not turn a plain number into a subset number', () => {
    expect(parsePokemon({ bottom: '165/132' })).toMatchObject({ number: '165', total: '132' });
    expect(parsePokemon({ bottom: '162/149' })).toMatchObject({ number: '162', total: '149' });
  });
});

describe('Pokémon set codes (P7)', () => {
  it('repairs a code against the set table', () => {
    expect(parsePokemon({ bottom: 'GSVI EN 063/198' }).setCode).toBe('SVI');
    expect(parsePokemon({ bottom: 'IMEG EN 001/132' }).setCode).toBe('MEG');
    expect(parsePokemon({ bottom: 'G SVl EN 063/198' }).setCode).toBe('SVI');
    expect(parsePokemon({ bottom: 'G PAl EN 025/193' }).setCode).toBe('PAL');
    expect(parsePokemon({ bottom: 'G SV1 EN 063/198' }).setCode).toBe('SVI');
    expect(parsePokemon({ bottom: 'G 0BF EN 125/197' }).setCode).toBe('OBF');
    expect(parsePokemon({ bottom: 'G ASC EN 184/217' }).setCode).toBe('ASC');
    expect(parsePokemon({ bottom: 'G SVIEN 063/198 ¢' })).toMatchObject({ setCode: 'SVI', language: 'EN' });
  });

  it('keeps only codes that name a set', () => {
    expect(parsePokemon({ bottom: 'BI 063/198' }).setCode).toBeUndefined();
    expect(parsePokemon({ bottom: 'CITY EN 063/198' }).setCode).toBeUndefined();
    expect(parsePokemon({ bottom: 'Mus, Kogemaru Hiumeno 5/114% BY' }).setCode).toBeUndefined();
    expect(parsePokemon({ bottom: 'me 2 ©2011 Pokemon SS 10/114' }).setCode).toBeUndefined();
    // Repairs need the language beside the code; an exact code stands on its own.
    expect(fixSetCode('SVl', '063', false)).toBeUndefined();
    expect(fixSetCode('SVI', '063', false)).toBe('SVI');
  });
});

describe('Pokémon name line (P5, P8, P9)', () => {
  it('names the card, not what it evolves from', () => {
    expect(parsePokemon({ name: 'STAGE 2 Evolves from Kadabra Put Alakazam on the Stage 1 card\nAlakazam 80 HP' }).name).toBe('Alakazam');
    expect(parsePokemon({ name: 'STAGE 1 Evolves from Weedle Put Kakuna on the Basic Pokémon\nKakuna 80 HP' }).name).toBe('Kakuna');
    expect(parsePokemon({ name: 'STAGE 2 Evolves from Charmeleon\nCharizard ex HP 330' }).name).toBe('Charizard ex');
    expect(parsePokemon({ name: 'Tentacruel HP 120\nSTAGE 1 Evolves from Tentacool' }).name).toBe('Tentacruel');
    expect(parsePokemon({ name: 'STAGE 1 Evolves from Grimer\nMuk HP 140' }).name).toBe('Muk');
    expect(parsePokemon({ name: '¢ Evolves from Kadabra Put Alakazam on the Stage | card\nSTAGE 2\nAlakazam SO HP ®' })).toMatchObject({ name: 'Alakazam', nameCandidates: ['Alakazam'] });
  });

  it('ranks the card before its pre-evolution among the candidates', () => {
    expect(nameCandidates('Tentacruel HP 120\nSTAGE 1 Evolves from Tentacool', new Set())[0]).toBe('Tentacruel');
    expect(nameCandidates('STAGE 2 Evolves from Charmeleon\nCharizard ex HP 330', new Set())[0]).toBe('Charizard');
  });

  it('offers three-letter names on the HP line', () => {
    expect(parsePokemon({ name: 'BASIC Mew HP 60' })).toMatchObject({ name: 'Mew', nameCandidates: ['Mew'] });
    expect(parsePokemon({ name: 'BASIC Mew V HP 180' })).toMatchObject({ name: 'Mew V' });
    expect(parsePokemon({ name: 'BASIC Mew V HP 180' }).nameCandidates).toContain('Mew');
    expect(parsePokemon({ name: 'Ere "ne\n— ©]\n/+180®\n2225 Mew (BX\n| 7' }).name).toBe('Mew');
  });

  it('strips HP junk and icon junk from the name', () => {
    expect(parsePokemon({ name: 'BASIC Zebstrika w90' }).name).toBe('Zebstrika');
    expect(parsePokemon({ name: 'STAGE2 Serperior wl30' }).name).toBe('Serperior');
    expect(parsePokemon({ name: 'aricez Decidueye Jw140' }).name).toBe('Decidueye');
    expect(parsePokemon({ name: 'Electabuzz JOHP' }).name).toBe('Electabuzz');
    expect(parsePokemon({ name: 'Alakazam SO HP' }).name).toBe('Alakazam');
    expect(parsePokemon({ name: '2amcg Pikachu HP 60' }).name).toBe('Pikachu');
    expect(parsePokemon({ name: '_ I\n2°<)”Kadabra .80®\n,—  Kadabra  -,80¢' }).name).toBe('Kadabra');
    expect(parsePokemon({ name: '“2%°“Machop Ww70@&' }).name).toBe('Machop');
    expect(parsePokemon({ name: 'BASIC\nPikachu LV.12 40 HP' }).name).toBe('Pikachu');
    expect(parsePokemon({ name: 'LEVEL UP\nMewtwo LV.X 120 HP' }).name).toBe('Mewtwo LV.X');
    expect(parsePokemon({ name: 'VT Lr - Tr al ed et el\n\\%Z5 AlcremieV | ©' }).name).toBe('Alcremie V');
  });

  it('prefers the Capitalised line over junk lines', () => {
    expect(parsePokemon({ name: 'sracel,/ Wh\n~~" Pawmo 7 »90:4)' }).name).toBe('Pawmo');
    expect(parsePokemon({ name: 'a eas 21200\nBASIC Xerneas : v TT « |\n1 $e SOR' }).name).toBe('Xerneas');
    expect(parsePokemon({ name: 'TTT EmEEETTTTT TT\n| imcez Brio A N&€\n| = Blastoise@Y 4330.6) |' }).name).toBe('Blastoise');
    expect(parsePokemon({ name: 'BASIC Single Strike Urshifu V HP 220' }).name).toBe('Single Strike Urshifu V');
  });
});

describe('Pokémon Trainer and Energy strips (P6)', () => {
  it('records the category a label gives away', () => {
    expect(pokemonCategory('TRAINER\nBill')).toBe('trainer');
    expect(pokemonCategory('supporter TRAINER\nArven')).toBe('trainer');
    expect(pokemonCategory('7 IRATETS ITEM')).toBe('trainer');
    expect(pokemonCategory('"ENERGY BX)')).toBe('energy');
    expect(pokemonCategory('Basic Energy')).toBe('energy');
    expect(pokemonCategory('BASIC Pikachu HP 60')).toBeUndefined();
    expect(parsePokemon({ name: 'Item ~~ TRAINER )\nC...%% Lb.' }).category).toBe('trainer');
    expect(parsePokemon({ name: 'BASIC Pikachu HP 60' }).category).toBeUndefined();
  });

  it('takes the line under the label as the name', () => {
    expect(parsePokemon({ name: "TRAINER\nProfessor's Research\nSupporter" }).name).toBe("Professor's Research");
    expect(parsePokemon({ name: 'TRAINER Item\nRare Candy' }).name).toBe('Rare Candy');
    expect(parsePokemon({ name: 'supporter ~~ TRAINER\nClive\nCease Ars vm' }).name).toBe('Clive');
    expect(parsePokemon({ name: 'Supporter\nIono' }).name).toBe('Iono');
    expect(parsePokemon({ name: 'TRAINER\nf Eneroy Search' }).name).toBe('Eneroy Search');
  });

  it('keeps Energy in Energy names', () => {
    expect(parsePokemon({ name: 'Fire Energy\nENERGY' }).name).toBe('Fire Energy');
    expect(parsePokemon({ name: 'Double Colorless Energy' }).name).toBe('Double Colorless Energy');
    expect(parsePokemon({ name: 'Jet Energy' }).name).toBe('Jet Energy');
    expect(parsePokemon({ name: 'ENERGY' }).name).toBeUndefined();
  });
});

describe('second look plausibility gate (P1)', () => {
  it('tells printed numbers from glued glyphs', () => {
    expect(plausibleNumber({ number: '187', total: '202' })).toBe(true);
    expect(plausibleNumber({ number: 'V187', total: '202' })).toBe(false);
    expect(plausibleNumber({ number: '417', total: '102' })).toBe(false);
    expect(plausibleNumber({ number: '106', total: '011' })).toBe(false);
    expect(plausibleNumber({ number: 'TG05', total: 'TG30' })).toBe(true);
    expect(plausibleNumber({ number: 'SWSH050' })).toBe(true);
    expect(plausibleNumber({ number: '1', total: '834' })).toBe(false);
  });

  it('keeps a plausible strip read over a worse close read', () => {
    expect(mergeSecondLook({ number: '187', total: '202' }, parsePokemon({ bottom: 'V187/202' }))).toEqual({ number: '187', total: '202' });
    expect(mergeSecondLook({ number: '17', total: '102' }, { number: '417', total: '102' })).toEqual({ number: '17', total: '102' });
    expect(mergeSecondLook({ number: '106', total: '111' }, { number: '106', total: '011' })).toEqual({ number: '106', total: '111' });
    expect(mergeSecondLook({ number: '56', total: '64' }, { number: '54', total: '64' })).toEqual({ number: '56', total: '64' });
    expect(mergeSecondLook({ number: 'TG24', total: 'TG30' }, { number: '24', total: '163' })).toEqual({ number: 'TG24', total: 'TG30' });
    expect(mergeSecondLook({ number: '206', total: '165' }, { number: '206' })).toEqual({ number: '206', total: '165' });
    // A size the second look cut down from four digits is no better than the strip's.
    expect(mergeSecondLook({ number: '024', total: '025' }, parsePokemon({ bottom: '0024/0285' }), '0024/0285')).toEqual({ number: '024', total: '025' });
    expect(mergeSecondLook({ number: '93', total: '100' }, { number: '93', total: '109' }, '93/109')).toEqual({ number: '93', total: '109' });
  });

  it('takes the close read when it is the plausible one or extends the strip read', () => {
    expect(mergeSecondLook({ number: '14', total: '146' }, { number: '114', total: '146' })).toEqual({ number: '114', total: '146' });
    expect(mergeSecondLook({ number: '5a', total: '114' }, { number: '54', total: '114' })).toEqual({ number: '54', total: '114' });
    expect(mergeSecondLook({ number: 'V156', total: '202' }, { number: '156', total: '202' })).toEqual({ number: '156', total: '202' });
    expect(mergeSecondLook({}, { number: '9', total: '102' })).toEqual({ number: '9', total: '102' });
    expect(mergeSecondLook({ number: '9', total: '102' }, {})).toEqual({ number: '9', total: '102' });
  });
});
