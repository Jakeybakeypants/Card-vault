import { afterEach, describe, expect, it, vi } from 'vitest';
import { isConfident } from './game';
import { clearHttpCache } from './http';
import { pokemon } from './pokemon';
import { yugioh } from './yugioh';

// The catalogs are stubbed with responses shaped like the real APIs, so these tests check query
// building and ranking, not the network.


function ptcgCard(id: string, name: string, number: string, setId: string, printedTotal: number, ptcgoCode?: string) {
  return {
    id,
    name,
    supertype: 'Pokémon',
    subtypes: ['Basic'],
    number,
    rarity: 'Common',
    set: { id: setId, name: `Set ${setId}`, series: 'Scarlet & Violet', printedTotal, total: printedTotal + 50, ptcgoCode, releaseDate: '2023/03/31' },
    images: { small: `https://images.example/${id}.png`, large: `https://images.example/${id}_hires.png` },
    tcgplayer: { url: 'https://prices.example', prices: { normal: { market: 0.25, mid: 0.3 }, reverseHolofoil: { market: 1.1, mid: 1.2 } } },
  };
}

function stubFetch(routes: Array<[RegExp, unknown]>): string[] {
  const seen: string[] = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string) => {
      const url = decodeURIComponent(raw.replace(/\+/g, ' '));
      seen.push(url);
      const hit = routes.find(([re]) => re.test(url));
      if (!hit) return new Response('{"error":"not found"}', { status: 400 });
      return new Response(JSON.stringify(hit[1]), { status: 200 });
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe('pokemon.identify', () => {
  it('finds a card by number + set total and ranks by name', async () => {
    const seen = stubFetch([
      [/printedTotal:198/, { data: [ptcgCard('sv1-63', 'Pikachu', '63', 'sv1', 198, 'SVI'), ptcgCard('sv9-63', 'Snorlax', '63', 'sv9', 198, 'XYZ')] }],
    ]);
    const res = await pokemon.identify({ number: '063', total: '198', nameText: 'BASIC Pikachu HP 60', name: 'Pikachu', setCode: 'SVI' });
    expect(seen.some((u) => u.includes('(number:063 OR number:63) set.printedTotal:198'))).toBe(true);
    expect(res[0]!.card).toMatchObject({ key: 'sv1-63', name: 'Pikachu', number: '63/198', setCode: 'SVI' });
    expect(res[0]!.card.prices).toEqual({ Normal: 0.25, 'Reverse Holofoil': 1.1 });
    expect(isConfident(res)).toBe(true);
  });

  it('is not confident when only a name was read', async () => {
    stubFetch([[/name:Pikachu\*/, { data: [ptcgCard('a-1', 'Pikachu', '1', 'a', 100), ptcgCard('b-2', 'Pikachu', '2', 'b', 100)] }]]);
    const res = await pokemon.identify({ name: 'Pikachu', nameText: 'Pikachu' });
    expect(res).toHaveLength(2);
    expect(isConfident(res)).toBe(false);
  });

  it('parses "name number/total" searches', async () => {
    const seen = stubFetch([[/printedTotal:102/, { data: [ptcgCard('base1-4', 'Charizard', '4', 'base1', 102)] }]]);
    const cards = await pokemon.search('charizard 4/102');
    expect(seen.some((u) => u.includes('number:4 set.printedTotal:102'))).toBe(true);
    expect(cards[0]!.name).toBe('Charizard');
  });
});

describe('pokemon sets', () => {
  it('lists sets and pages through a big set', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ptcgCard(`sv2-${from + i}`, `Card ${from + i}`, String(from + i), 'sv2', 193));
    const seen = stubFetch([
      [/v2\/sets/, { data: [{ id: 'sv2', name: 'Paldea Evolved', series: 'Scarlet & Violet', total: 279, ptcgoCode: 'PAL', releaseDate: '2023/06/09', images: { symbol: 's', logo: 'l' } }] }],
      [/set\.id:sv2.*page=1/, { data: page(250, 1), totalCount: 279 }],
      [/set\.id:sv2.*page=2/, { data: page(29, 251), totalCount: 279 }],
    ]);
    const [set] = await pokemon.sets();
    expect(set).toMatchObject({ id: 'sv2', code: 'PAL', total: 279, releaseDate: '2023-06-09' });
    const cards = await pokemon.setCards(set!);
    expect(cards).toHaveLength(279);
    expect(seen.filter((u) => u.includes('set.id:sv2'))).toHaveLength(2);
  });
});

describe('yugioh.identify', () => {
  const darkMagician = {
    id: 46986414,
    name: 'Dark Magician',
    type: 'Normal Monster',
    frameType: 'normal',
    desc: 'The ultimate wizard in terms of attack and defense.',
    atk: 2500,
    def: 2100,
    level: 7,
    race: 'Spellcaster',
    attribute: 'DARK',
    card_sets: [
      { set_name: 'Legend of Blue Eyes White Dragon', set_code: 'LOB-EN005', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '45.10' },
      { set_name: 'Starter Deck: Yugi', set_code: 'SDY-006', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '12.00' },
    ],
    card_images: [{ id: 46986414, image_url: 'https://img.example/46986414.jpg', image_url_small: 'https://img.example/s/46986414.jpg' }],
    card_prices: [{ tcgplayer_price: '0.80' }],
  };

  it('resolves a set code to that exact printing', async () => {
    stubFetch([
      [/cardsetsinfo\.php\?setcode=LOB-EN005/, { id: 46986414, name: 'Dark Magician', set_name: 'Legend of Blue Eyes White Dragon', set_code: 'LOB-EN005', set_rarity: 'Ultra Rare', set_price: '45.10' }],
      [/cardinfo\.php\?id=46986414/, { data: [darkMagician] }],
      [/fname=Dark/, { data: [darkMagician] }],
    ]);
    const res = await yugioh.identify({ setCode: 'LOB-EN005', name: 'Dark Magician', nameText: 'Dark Magician' });
    expect(res[0]!.card).toMatchObject({ key: 'LOB-EN005:Ultra Rare', number: 'LOB-EN005', setCode: 'LOB', prices: { default: 45.1 } });
    expect(res[0]!.card.details).toMatchObject({ 'ATK / DEF': '2500 / 2100', Level: '7', Passcode: '46986414' });
    expect(isConfident(res)).toBe(true);
  });

  it('falls back to the EN spelling for region-less codes', async () => {
    const seen = stubFetch([
      [/setcode=SDY-EN006/, { id: 46986414, name: 'Dark Magician', set_name: 'Starter Deck: Yugi', set_code: 'SDY-EN006', set_rarity: 'Ultra Rare', set_price: '12.00' }],
      [/cardinfo\.php\?id=46986414/, { data: [{ ...darkMagician, card_sets: [{ ...darkMagician.card_sets[1]!, set_code: 'SDY-EN006' }] }] }],
    ]);
    const res = await yugioh.identify({ setCode: 'SDY-006' });
    expect(seen.some((u) => u.includes('setcode=SDY-006'))).toBe(true);
    expect(res[0]!.card.number).toBe('SDY-EN006');
  });

  it('lists the printings of one set', async () => {
    stubFetch([
      [/cardsets\.php/, [{ set_name: 'Starter Deck: Yugi', set_code: 'SDY', num_of_cards: 50, tcg_date: '2002-03-29' }, { set_name: 'Legend of Blue Eyes White Dragon', set_code: 'LOB', num_of_cards: 126, tcg_date: '2002-03-08' }]],
      [/cardset=Legend/, { data: [darkMagician] }],
    ]);
    const sets = await yugioh.sets();
    expect(sets.map((s) => s.code)).toEqual(['SDY', 'LOB']);
    const cards = await yugioh.setCards(sets[1]!);
    expect(cards.map((c) => c.key)).toEqual(['LOB-EN005:Ultra Rare']);
  });

  it('asks which printing when only the passcode is known', async () => {
    stubFetch([[/cardinfo\.php\?id=46986414/, { data: [darkMagician] }]]);
    const res = await yugioh.identify({ passcode: '46986414' });
    expect(res).toHaveLength(2);
    expect(isConfident(res)).toBe(false);
  });
});
