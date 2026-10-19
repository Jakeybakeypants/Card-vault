import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePokemon } from '../scan/parse';
import type { Candidate, CardPrinting } from '../types';
import { isConfident } from './game';
import { clearHttpCache } from './http';
import { lorcana } from './lorcana';
import { mtg } from './mtg';
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

// The photo matcher, for the resolve() tests: likeness per catalog picture, 0.05 for the rest.
const VISUAL = vi.hoisted(() => new Map<string, number>());
vi.mock('../scan/vision', () => ({
  PhotoMatcher: class {
    async compare(url: string | undefined): Promise<number | undefined> {
      if (!url) return undefined;
      const key = url.replace('https://assets.example/', '').replace('/low.webp', '');
      return VISUAL.has(key) ? VISUAL.get(key) : 0.05;
    }
  },
  hasGlare: () => false,
  shimmer: () => 0,
  reverseProbability: () => 0,
}));

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

  it('asks which printing when only the passcode is known', async () => {
    stubFetch([[/cardinfo\.php\?id=46986414/, { data: [darkMagician] }]]);
    const res = await yugioh.identify({ passcode: '46986414' });
    expect(res).toHaveLength(2);
    expect(isConfident(res)).toBe(false);
  });
});

describe('TCGdex (primary Pokémon catalog)', () => {
  const dexCard = {
    id: 'swsh3-136',
    localId: '136',
    name: 'Furret',
    image: 'https://assets.tcgdex.net/en/swsh/swsh3/136',
    rarity: 'Uncommon',
    category: 'Pokemon',
    hp: 110,
    types: ['Colorless'],
    stage: 'Stage1',
    variants: { normal: true, reverse: true, holo: false, firstEdition: false },
    set: { id: 'swsh3', name: 'Darkness Ablaze', cardCount: { official: 189, total: 201 } },
    pricing: {
      cardmarket: { unit: 'EUR', trend: 0.1, 'trend-holo': 0.3 },
      tcgplayer: {
        updated: '2026-10-12T00:00:00Z',
        unit: 'USD',
        normal: { productId: 216712, lowPrice: 0.02, midPrice: 0.15, marketPrice: 0.12 },
        'reverse-holofoil': { productId: 216712, lowPrice: 0.1, midPrice: 0.4, marketPrice: 0.33 },
      },
    },
  };

  it('reads per-finish TCGplayer prices and the finishes the card exists in', async () => {
    const { fromDex } = await import('./tcgdex');
    const card = fromDex(dexCard);
    expect(card).toMatchObject({ key: 'swsh3-136', number: '136/189', setName: 'Darkness Ablaze', image: 'https://assets.tcgdex.net/en/swsh/swsh3/136/low.webp' });
    expect(card.prices).toEqual({ Normal: 0.12, 'Reverse Holofoil': 0.33 });
    expect(card.variants).toEqual(['Normal', 'Reverse Holofoil']);
    expect(card.url).toBe('https://www.tcgplayer.com/product/216712');
    expect(card.pricesUpdatedAt).toBeDefined();
  });

  it('lists holo first for holo rares and tolerates null markets', async () => {
    const { fromDex } = await import('./tcgdex');
    const holo = fromDex({ ...dexCard, variants: { holo: true, reverse: true }, pricing: { tcgplayer: null } });
    expect(holo.variants).toEqual(['Holofoil', 'Reverse Holofoil']);
    expect(holo.prices).toBeUndefined();
  });

  it('finds a card by number and set size', async () => {
    const seen = stubFetch([
      [/tcgdex\.net\/v2\/en\/sets$/, [{ id: 'swsh3', name: 'Darkness Ablaze', cardCount: { official: 189, total: 201 } }, { id: 'A1', name: 'Pocket', cardCount: { official: 189, total: 189 } }]],
      [/tcgdex\.net\/v2\/en\/sets\/swsh3\/136$/, dexCard],
    ]);
    const res = await pokemon.identify({ number: '136', total: '189', name: 'Furret', nameText: 'STAGE 1 Furret HP 110' });
    expect(res[0]!.card).toMatchObject({ key: 'swsh3-136', source: 'tcgdex', prices: { Normal: 0.12 } });
    expect(isConfident(res)).toBe(true);
    // TCG Pocket sets are skipped.
    expect(seen.some((u) => u.includes('/sets/A1/'))).toBe(false);
  });

  it('returns partial results for name searches and completes them on demand', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/cards\?name=Furret/, [{ id: 'swsh3-136', localId: '136', name: 'Furret', image: 'x' }, { id: 'sv4-150', localId: '150', name: 'Furret', image: 'y' }]],
      [/tcgdex\.net\/v2\/en\/cards\/swsh3-136$/, dexCard],
    ]);
    const res = await pokemon.identify({ name: 'Furret', nameText: 'Furret' });
    expect(res).toHaveLength(2);
    expect(res.every((c) => c.card.partial)).toBe(true);
    const full = await pokemon.complete(res.find((c) => c.card.key === 'swsh3-136')!.card);
    expect(full.partial).toBeFalsy();
    expect(full).toMatchObject({ setName: 'Darkness Ablaze', prices: { 'Reverse Holofoil': 0.33 } });
  });
});

describe('yugioh prices', () => {
  it('does not use the cheapest-printing price for a printing without its own', async () => {
    stubFetch([
      [/cardinfo\.php\?id=1/, { data: [{ id: 1, name: 'X', type: 'Normal Monster', frameType: 'normal', desc: '', race: 'Warrior', card_sets: [{ set_name: 'S', set_code: 'S-EN001', set_rarity: 'Secret Rare', set_price: '0' }], card_images: [{ id: 1, image_url: 'a', image_url_small: 'b' }], card_prices: [{ tcgplayer_price: '0.10' }] }] }],
    ]);
    const res = await yugioh.identify({ passcode: '1' });
    expect(res[0]!.card.prices).toBeUndefined();
  });
});

describe('binder sets', () => {
  it('lists TCGdex sets newest first, without TCG Pocket', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/sets$/, [
        { id: 'base1', name: 'Base Set', logo: 'https://assets.example/base1', cardCount: { official: 102, total: 102 } },
        { id: 'A1', name: 'Genetic Apex', cardCount: { official: 226, total: 286 } },
        { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } },
      ]],
    ]);
    const sets = await pokemon.sets();
    expect(sets.map((s) => [s.id, s.total])).toEqual([['sv01', 258], ['base1', 102]]);
    expect(sets[1]!.logo).toBe('https://assets.example/base1.webp');
  });

  it('lists a TCGdex set as partial cards with set name and size', async () => {
    stubFetch([[/sets\/sv01$/, { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 }, cards: [{ id: 'sv01-025', localId: '025', name: 'Pikachu', image: 'https://assets.example/sv01/025' }] }]]);
    const [card] = await pokemon.setCards({ game: 'pokemon', id: 'sv01', name: 'Scarlet & Violet', code: 'SV01', total: 258 });
    expect(card).toMatchObject({ key: 'sv01-025', setName: 'Scarlet & Violet', number: '025/198', partial: true });
  });

  it('falls back to pokemontcg.io and pages through a big set', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ptcgCard(`sv2-${from + i}`, `Card ${from + i}`, String(from + i), 'sv2', 193));
    const seen = stubFetch([
      [/pokemontcg\.io\/v2\/sets/, { data: [{ id: 'sv2', name: 'Paldea Evolved', series: 'Scarlet & Violet', total: 279, ptcgoCode: 'PAL', releaseDate: '2023/06/09', images: { symbol: 's', logo: 'l' } }] }],
      [/set\.id:sv2.*page=1/, { data: page(250, 1), totalCount: 279 }],
      [/set\.id:sv2.*page=2/, { data: page(29, 251), totalCount: 279 }],
    ]);
    const [set] = await pokemon.sets();
    expect(set).toMatchObject({ id: 'ptcg:sv2', code: 'PAL', total: 279, releaseDate: '2023-06-09' });
    expect(await pokemon.setCards(set!)).toHaveLength(279);
    expect(seen.filter((u) => u.includes('set.id:sv2'))).toHaveLength(2);
  });

  it('lists the printings of one Yu-Gi-Oh! set', async () => {
    const card = { id: 46986414, name: 'Dark Magician', type: 'Normal Monster', frameType: 'normal', desc: '', race: 'Spellcaster',
      card_sets: [{ set_name: 'Legend of Blue Eyes White Dragon', set_code: 'LOB-EN005', set_rarity: 'Ultra Rare', set_price: '45.10' }, { set_name: 'Starter Deck: Yugi', set_code: 'SDY-006', set_rarity: 'Ultra Rare', set_price: '12.00' }],
      card_images: [{ id: 46986414, image_url: 'a', image_url_small: 'b' }] };
    stubFetch([
      [/cardsets\.php/, [{ set_name: 'Starter Deck: Yugi', set_code: 'SDY', num_of_cards: 50, tcg_date: '2002-03-29' }, { set_name: 'Legend of Blue Eyes White Dragon', set_code: 'LOB', num_of_cards: 126, tcg_date: '2002-03-08' }]],
      [/cardset=Legend/, { data: [card] }],
    ]);
    const sets = await yugioh.sets();
    expect(sets.map((s) => s.code)).toEqual(['SDY', 'LOB']);
    expect((await yugioh.setCards(sets[1]!)).map((c) => c.key)).toEqual(['LOB-EN005:Ultra Rare']);
  });
});

describe('mtg', () => {
  const bolt = (set: string, number: string, usd = '1.50') => ({
    id: `${set}-${number}`, name: 'Lightning Bolt', set, set_name: `Set ${set}`, collector_number: number, rarity: 'common', released_at: '2020-07-03',
    type_line: 'Instant', mana_cost: '{R}', finishes: ['nonfoil', 'foil'], prices: { usd, usd_foil: '4.00', usd_etched: null },
    image_uris: { small: 's', normal: 'n', large: 'l' },
  });

  it('resolves set code + collector number to one printing', async () => {
    stubFetch([
      [/cards\/m21\/125/, bolt('m21', '125')],
      [/cards\/named/, bolt('m21', '125')],
      [/cards\/search/, { data: [bolt('m21', '125'), bolt('2xm', '117')] }],
    ]);
    const hints = { setCode: 'M21', number: '125', name: 'Lightning Bolt', nameText: 'Lightning Bolt' };
    const res = await mtg.identify(hints);
    expect(res[0]!.card).toMatchObject({ key: 'm21-125', setCode: 'M21', number: '125', prices: { Normal: 1.5, Foil: 4 }, variants: ['Normal', 'Foil'] });
    expect(isConfident(res)).toBe(true);
    expect(mtg.exactId(res[0]!.card, hints)).toBe(true);
  });

  it('pages through a set', async () => {
    stubFetch([
      [/page=2/, { data: [bolt('m21', '2')], has_more: false }],
      [/e:m21/, { data: [bolt('m21', '1')], has_more: true, next_page: 'https://api.scryfall.com/cards/search?q=e:m21&page=2' }],
    ]);
    const cards = await mtg.setCards({ game: 'mtg', id: 'm21', name: 'Core Set 2021', code: 'M21', total: 2 });
    expect(cards.map((c) => c.number)).toEqual(['1', '2']);
  });

  it('skips digital and token sets', async () => {
    stubFetch([[/\/sets/, { data: [
      { code: 'm21', name: 'Core Set 2021', set_type: 'core', released_at: '2020-07-03', card_count: 397, digital: false },
      { code: 'tm21', name: 'M21 Tokens', set_type: 'token', released_at: '2020-07-03', card_count: 14, digital: false },
      { code: 'ha1', name: 'Historic Anthology 1', set_type: 'expansion', released_at: '2019-11-21', card_count: 20, digital: true },
    ] }]]);
    expect((await mtg.sets()).map((s) => s.code)).toEqual(['M21']);
  });

  it('refreshes a saved card by set and number', async () => {
    stubFetch([[/cards\/m21\/125/, bolt('m21', '125', '2.25')]]);
    const fresh = await mtg.refresh({ game: 'mtg', key: 'm21-125', name: 'Lightning Bolt', setName: 'M21', setCode: 'M21', number: '125', variants: [], details: {}, source: 'scryfall' });
    expect(fresh?.prices).toEqual({ Normal: 2.25, Foil: 4 });
    expect(fresh?.pricesUpdatedAt).toBeTruthy();
  });
});

describe('lorcana', () => {
  const lc = (set: string, n: string, name: string, version: string) => ({
    id: `${set}-${n}`, name, version, collector_number: n, rarity: 'Super_rare', set: { id: `set_${set}`, code: set, name: `Set ${set}` },
    image_uris: { digital: { small: 's', normal: 'n', large: 'l' } }, prices: { usd: '2.00', usd_foil: '6.00' },
  });

  it('matches a scan against the whole catalog, counts set sizes and refreshes', async () => {
    stubFetch([
      [/v0\/sets\/1\/cards/, [lc('1', '115', 'Mickey Mouse', 'Brave Little Tailor'), lc('1', '12', 'Elsa', 'Snow Queen')]],
      [/v0\/sets\/2\/cards/, [lc('2', '115', 'Stitch', 'Rock Star')]],
      [/v0\/sets$/, { results: [{ id: 'set_1', name: 'The First Chapter', code: '1', released_at: '2023-08-18' }, { id: 'set_2', name: 'Rise of the Floodborn', code: '2', released_at: '2023-11-17' }] }],
    ]);
    const res = await lorcana.identify({ number: '115', setCode: '1', name: 'MICKEY MOUSE - Brave Little Tailor', nameText: 'MICKEY MOUSE Brave Little Tailor' });
    expect(res[0]!.card).toMatchObject({ key: '1-115', name: 'Mickey Mouse - Brave Little Tailor', rarity: 'Super rare', prices: { Normal: 2, Foil: 6 } });
    expect(isConfident(res)).toBe(true);
    expect((await lorcana.sets()).map((s) => [s.code, s.total])).toEqual([['2', 1], ['1', 2]]);
    expect((await lorcana.search('elsa')).map((c) => c.key)).toEqual(['1-12']);
    expect((await lorcana.refresh(res[0]!.card))?.key).toBe('1-115');
  });
});

describe('special Pokémon cards', () => {
  const dex = (id: string, localId: string, name: string, set: { id: string; name: string; official: number }, pricing: unknown = null) => ({
    id,
    localId,
    name,
    image: `https://assets.example/${id}`,
    rarity: 'Holo Rare',
    category: 'Pokemon',
    variants: { holo: true },
    set: { id: set.id, name: set.name, cardCount: { official: set.official, total: set.official } },
    pricing,
  });

  it('finds an SVP promo from "SVP EN 085" without the name', async () => {
    const { parsePokemon } = await import('../scan/parse');
    const seen = stubFetch([[/sets\/svp\/085$/, dex('svp-085', '085', 'Pikachu', { id: 'svp', name: 'SVP Black Star Promos', official: 225 })]]);
    const hints = parsePokemon({ name: '', bottom: 'G SVP EN 085' });
    expect(hints).toMatchObject({ number: '085', setCode: 'SVP', language: 'EN' });
    const res = await pokemon.identify(hints);
    expect(res[0]!.card.key).toBe('svp-085');
    expect(pokemon.exactId(res[0]!.card, hints)).toBe(true);
    expect(seen.filter((u) => u.includes('tcgdex'))).toHaveLength(1);
  });

  it('looks up a Trainer Gallery number in the gallery sets, and the set code picks one', async () => {
    const tg = { id: 'swsh9tg', name: 'Brilliant Stars Trainer Gallery', official: 30 };
    const seen = stubFetch([[/sets\/swsh9tg\/TG05$/, dex('swsh9tg-TG05', 'TG05', 'Zekrom', tg)]]);
    const res = await pokemon.identify({ number: 'TG05', total: 'TG30' });
    expect(res[0]!.card).toMatchObject({ key: 'swsh9tg-TG05', number: 'TG05/30', setCode: 'BRS' });
    // All four Trainer Galleries are TG30; without a set code each one is asked.
    expect(seen.filter((u) => /sets\/swsh\d+tg\/TG05$/.test(u))).toHaveLength(4);
    expect(pokemon.exactId(res[0]!.card, { number: 'TG05', total: 'TG30' })).toBe(true);
  });

  it('names the set from the printed code instead of every set of that size', async () => {
    const sv1 = { id: 'sv01', name: 'Scarlet & Violet', official: 198 };
    const seen = stubFetch([[/sets\/sv01\/201$/, dex('sv01-201', '201', 'Spidops ex', sv1)]]);
    const res = await pokemon.identify({ number: '201', total: '198', setCode: 'SVI' });
    expect(res[0]!.card).toMatchObject({ key: 'sv01-201', setCode: 'SVI', releaseDate: '2023-03-31' });
    // The coded set is asked first.
    expect(seen.find((u) => /\/sets\/[^/]+\/201$/.test(u))).toMatch(/sets\/sv01\/201$/);
  });

  it('ranks the set the code names above same-name, same-number cards elsewhere', async () => {
    stubFetch([
      [/sets\/svp\/027$/, dex('svp-027', '027', 'Pikachu', { id: 'svp', name: 'SVP Black Star Promos', official: 225 })],
      [/cards\?name=Pikach/, [{ id: 'swsh10.5-027', localId: '027', name: 'Pikachu' }, { id: 'svp-027', localId: '027', name: 'Pikachu' }]],
    ]);
    const res = await pokemon.identify({ number: '027', setCode: 'SVP', name: 'Pikachu', nameText: 'BASIC Pikachu HP 60' });
    expect(res[0]!.card.key).toBe('svp-027');
    expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
  });

  it('prices a gallery card TCGdex has no TCGplayer price for from pokemontcg.io', async () => {
    const tg = { id: 'swsh9tg', name: 'Brilliant Stars Trainer Gallery', official: 30 };
    stubFetch([
      [/tcgdex\.net\/v2\/en\/cards\/swsh9tg-TG05$/, dex('swsh9tg-TG05', 'TG05', 'Zekrom', tg, { tcgplayer: null, cardmarket: { trend: 2 } })],
      [/pokemontcg\.io.*number:TG05/, { data: [{ ...ptcgCard('swsh9tg-TG05', 'Zekrom', 'TG05', 'swsh9tg', 30), set: { id: 'swsh9tg', name: 'Brilliant Stars Trainer Gallery', series: 'Sword & Shield', printedTotal: 30, total: 30, releaseDate: '2022/02/25' }, tcgplayer: { url: 'https://tcgplayer.example/zekrom', prices: { holofoil: { market: 3.5, mid: 4 } } } }] }],
    ]);
    const card = await pokemon.complete({ ...(await pokemon.identify({ number: 'TG05', total: 'TG30' }).then((r) => r[0]!.card)), prices: undefined });
    expect(card.prices).toEqual({ Holofoil: 3.5 });
    expect(card.priceSource).toMatch(/pokemontcg\.io/);
  });

  it('falls back to Cardmarket in USD when pokemontcg.io has nothing', async () => {
    const tg = { id: 'swsh9tg', name: 'Brilliant Stars Trainer Gallery', official: 30 };
    stubFetch([
      [/tcgdex\.net\/v2\/en\/cards\/swsh9tg-TG05$/, dex('swsh9tg-TG05', 'TG05', 'Zekrom', tg, { tcgplayer: null, cardmarket: { trend: 2, 'trend-holo': 5 } })],
      [/frankfurter/, { rates: { USD: 1.1 } }],
    ]);
    const full = await pokemon.complete({ key: 'swsh9tg-TG05', game: 'pokemon', name: 'Zekrom', setName: 'x', setCode: 'x', number: 'TG05', variants: [], details: {}, source: 'tcgdex', partial: true });
    expect(full.prices).toEqual({ Holofoil: 2.2 });
    expect(full.priceSource).toMatch(/Cardmarket/);
  });
});

describe('TCGdex per-finish products', () => {
  it('merges finishes sold as separate TCGplayer products, ignoring stamped printings', async () => {
    const { fromDex } = await import('./tcgdex');
    const card = fromDex({
      id: 'x-1',
      localId: '1',
      name: 'X',
      variants: { normal: true, reverse: true },
      set: { id: 'x', name: 'X', cardCount: { official: 10, total: 10 } },
      pricing: { tcgplayer: { unit: 'USD', normal: { productId: 11, marketPrice: 0.5 } } },
      variants_detailed: [
        { type: 'normal', thirdParty: { tcgplayer: 11 }, pricing: { tcgplayer: { normal: { productId: 11, marketPrice: 0.5 } } } },
        { type: 'reverse', thirdParty: { tcgplayer: 12 }, pricing: { tcgplayer: { 'reverse-holofoil': { productId: 12, marketPrice: 2 } } } },
        { type: 'normal', stamp: ['pre-release'], thirdParty: { tcgplayer: 13 }, pricing: { tcgplayer: { holofoil: { productId: 13, marketPrice: 40 } } } },
      ],
    });
    expect(card.prices).toEqual({ Normal: 0.5, 'Reverse Holofoil': 2 });
    expect(card.url).toBe('https://www.tcgplayer.com/product/11');
  });

  it('links to the TCGplayer product even when TCGdex has no price for it', async () => {
    const { fromDex } = await import('./tcgdex');
    const card = fromDex({ id: 'swsh9tg-TG05', localId: 'TG05', name: 'Zekrom', variants: { holo: true }, set: { id: 'swsh9tg', name: 'BRS TG', cardCount: { official: 30, total: 30 } }, pricing: { tcgplayer: null }, variants_detailed: [{ type: 'holo', thirdParty: { tcgplayer: 262345 } }] });
    expect(card.prices).toBeUndefined();
    expect(card.url).toBe('https://www.tcgplayer.com/product/262345');
  });
});

describe('isConfident: two agreeing signals', () => {
  const printing = (key: string, name: string, number: string): CardPrinting => ({ game: 'pokemon', key, name, setName: 's', setCode: 's', number, variants: [], details: {}, source: 'test' });
  const cand = (key: string, name: string, number: string, score: number, signals?: Candidate['signals'], visual?: number): Candidate => ({ card: printing(key, name, number), score, signals, visual });
  const read = { name: 1, number: true, set: true };

  it('adds on name + number + set alone when no same-name neighbour is in the running', () => {
    expect(isConfident([cand('a-25', 'Pikachu', '25/198', 1, read), cand('b-25', 'Snorlax', '25/198', 0.6, { name: 0.2, number: true, set: true })])).toBe(true);
    // A reprint with the same line, or the same name one digit away: only the photo can tell.
    expect(isConfident([cand('a-25', 'Pikachu', '25/198', 1, read), cand('b-25', 'Pikachu', '25/198', 0.9, read)])).toBe(false);
    expect(isConfident([cand('a-26', 'Pikachu', '26/198', 1, read), cand('a-25', 'Pikachu ex', '25/198', 0.68, { name: 1, number: false, set: true })])).toBe(false);
    expect(isConfident([cand('a-26', 'Pikachu', '26/198', 0.97, read, 0.9), cand('a-25', 'Pikachu ex', '25/198', 0.5, { name: 1, number: false, set: true }, 0.1)])).toBe(true);
    // The size disagrees (misread, or another set's card): not on text alone.
    expect(isConfident([cand('b-26', 'Gyarados', '26/123', 0.9, { name: 1, number: true, set: false }), cand('a-26', 'Gyarados EX', '26/122', 0.8, { name: 0.97, number: false, set: true })])).toBe(false);
    // A fuzzy name hit on another Pokémon ("Cinccino" for Minccino) is not a sure name, and a
    // neighbour whose name reads as well ("Porygon-Z" at 0.95 for a Porygon read) needs the photo.
    expect(isConfident([cand('a-153', 'Cinccino', '153/86', 0.94, { name: 0.875, number: true, set: true }), cand('a-152', 'Minccino', '152/86', 0.68, { name: 1, number: false, set: true })])).toBe(false);
    expect(isConfident([cand('a-155', 'Porygon-Z', '155/182', 0.976, { name: 0.95, number: true, set: true }), cand('a-153', 'Porygon', '153/182', 0.68, { name: 1, number: false, set: true })])).toBe(false);
    expect(isConfident([cand('a-155', 'Porygon-Z', '155/182', 0.976, { name: 0.95, number: true, set: true }), cand('a-153', 'Porygon', '153/182', 0.68, { name: 1, number: false, set: true })].map((c, i) => ({ ...c, visual: i ? 0.1 : 0.8 })))).toBe(true);
  });

  it('needs the photo when the name strip was empty, and a better photo for a name alone', () => {
    const numberOnly = { number: true, set: true };
    expect(isConfident([cand('a-68', 'Pachirisu', '68/198', 0.802, numberOnly, 0.34)])).toBe(false);
    expect(isConfident([cand('a-68', 'Pachirisu', '68/198', 0.85, numberOnly, 0.5)])).toBe(false);
    expect(isConfident([cand('a-68', 'Pachirisu', '68/198', 0.88, numberOnly, 0.6)])).toBe(true);
    expect(isConfident([cand('a-68', 'Pachirisu', '68/198', 0.805, numberOnly)])).toBe(false);
    const nameOnly = { name: 0.9 };
    expect(isConfident([cand('a-1', 'Joltik', '45/114', 0.9, nameOnly, 0.95), cand('b-1', 'Joltik', '70/202', 0.75, nameOnly, 0.3)])).toBe(true);
    expect(isConfident([cand('a-1', 'Joltik', '45/114', 0.82, nameOnly, 0.4), cand('b-1', 'Joltik', '70/202', 0.72, nameOnly, 0.1)])).toBe(false);
    expect(isConfident([cand('a-1', 'Joltik', '45/114', 1, nameOnly)])).toBe(false);
  });

  it('never lets a card without a picture win over one the photo confirmed', () => {
    expect(isConfident([cand('dp7-76', 'Stunky', '76/100', 0.9, read), cand('dp5-76', 'Stunky', '76/100', 0.8, read, 0.7)])).toBe(false);
    expect(isConfident([cand('a-26', 'Pikachu', '26/198', 0.95, read, 0.3), cand('a-25', 'Pikachu', '25/198', 0.8, { name: 1, number: false, set: true }, 0.8)])).toBe(false);
  });

  it('judges games without signals on the score alone', () => {
    expect(isConfident([cand('LOB-EN005', 'Dark Magician', 'LOB-EN005', 0.95), cand('SDY-006', 'Dark Magician', 'SDY-006', 0.6)])).toBe(true);
    expect(isConfident([cand('a', 'X', '1', 0.85), cand('b', 'X', '2', 0.8)])).toBe(false);
  });
});

describe('lookups that survive one OCR slip', () => {
  const dex = (id: string, localId: string, name: string, set: { id: string; name: string; official: number }, image = `https://assets.example/${id}`) => ({
    id, localId, name, image, rarity: 'Common', category: 'Pokemon', variants: { normal: true }, set: { id: set.id, name: set.name, cardCount: { official: set.official, total: set.official } }, pricing: null,
  });
  const brief = (id: string, localId: string, name: string) => ({ id, localId, name, image: `https://assets.example/${id}` });
  const bw1 = { id: 'bw1', name: 'Black & White', official: 114 };
  const sv1 = { id: 'sv01', name: 'Scarlet & Violet', official: 198 };
  const sets = [{ id: 'bw1', name: 'Black & White', cardCount: { official: 114, total: 115 } }, { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } }, { id: 'svp', name: 'SVP Black Star Promos', cardCount: { official: 0, total: 200 } }, { id: 'base1', name: 'Base Set', cardCount: { official: 102, total: 102 } }, { id: 'cel25cc', name: 'Celebrations Classic Collection', cardCount: { official: 25, total: 25 } }];

  it('keeps the same-name card one digit away when the number was misread, and does not add the neighbour on text alone', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/sets$/, sets],
      [/sets\/bw1\/2$/, dex('bw1-2', '2', 'Snivy', bw1)],
      [/cards\?name=Snivy/, [brief('bw1-1', '1', 'Snivy'), brief('bw1-2', '2', 'Snivy'), brief('xy1-1', '1', 'Snivy'), brief('sv09-050', '050', 'Snivy')]],
    ]);
    const hints = parsePokemon({ name: 'BASIC Snivy HP 60', bottom: '2/114' });
    const res = await pokemon.identify(hints);
    expect(res.map((c) => c.card.key)).toEqual(['bw1-2', 'bw1-1', 'xy1-1']);
    expect(res[0]!.score).toBe(1);
    expect(res[1]!.score).toBeCloseTo(0.63, 2); // name and size agree, number not; no code on BW cards
    expect(res[1]!.signals).toEqual({ name: 1, number: false, set: true });
    expect(pokemon.exactId(res[1]!.card, hints)).toBe(false);
    expect(isConfident(res)).toBe(false);
  });

  it('scores a name read without its ex/V/GX mark almost as high, and three-letter names are searched', async () => {
    const seen = stubFetch([[/tcgdex\.net\/v2\/en\/sets$/, sets], [/cards\?name=Mew/, [brief('sv03.5-151', '151', 'Mew ex'), brief('sv03.5-053', '053', 'Mewtwo')]]]);
    const hints = { name: 'Mew', nameText: 'BASIC Mew HP 180', nameCandidates: [] as string[] };
    const res = await pokemon.identify(hints);
    expect(seen.some((u) => u.includes('cards?name=Mew'))).toBe(true);
    expect(res[0]!.card.key).toBe('sv03.5-151');
    expect(res[0]!.score).toBeCloseTo(0.97, 2);
    expect(pokemon.score(res[1]!.card, hints)).toBeLessThan(0.7);
    expect(isConfident(res)).toBe(false);
  });

  it('looks a set code read as the promo code up by size as well, and counts the code for nothing', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/sets$/, sets],
      [/sets\/svp\/005$/, dex('svp-005', '005', 'Quaquaval', { id: 'svp', name: 'SVP Black Star Promos', official: 0 })],
      [/sets\/sv01\/005$/, dex('sv01-005', '005', 'Cacnea', sv1)],
    ]);
    const hints = parsePokemon({ name: '', bottom: 'H SVP EN 005/198' });
    expect(hints).toMatchObject({ number: '005', total: '198', setCode: 'SVP' });
    const res = await pokemon.identify(hints);
    expect(res.map((c) => c.card.key)).toEqual(['sv01-005', 'svp-005']);
    expect(res[0]!.score).toBe(1);
    expect(isConfident(res)).toBe(false);
    // A real promo, no size printed: the promo set alone, as before.
    const promo = await pokemon.identify(parsePokemon({ name: '', bottom: 'G SVP EN 005' }));
    expect(promo.map((c) => c.card.key)).toEqual(['svp-005']);
  });

  it('reaches a Classic Collection reprint by the original line it prints, tied with the original', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/sets$/, sets],
      [/sets\/base1\/4$/, dex('base1-4', '4', 'Charizard', { id: 'base1', name: 'Base Set', official: 102 })],
      [/sets\/cel25cc\/CC002$/, dex('cel25cc-CC002', 'CC002', 'Charizard', { id: 'cel25cc', name: 'Celebrations Classic Collection', official: 25 })],
      [/cards\?name=Charizard/, []],
    ]);
    const hints = parsePokemon({ name: 'STAGE 2 Charizard HP 120', bottom: '4/102' });
    const res = await pokemon.identify(hints);
    expect(res.map((c) => c.card.key).sort()).toEqual(['base1-4', 'cel25cc-CC002']);
    expect(res.map((c) => c.score)).toEqual([1, 1]);
    expect(res.every((c) => pokemon.exactId(c.card, hints))).toBe(true);
    expect(isConfident(res)).toBe(false);
    expect((await pokemon.search('charizard 4/102')).map((c) => c.key)).toContain('cel25cc-CC002');
  });

  it('repairs a set size no set prints, without treating it as an exact read', async () => {
    const seen = stubFetch([[/tcgdex\.net\/v2\/en\/sets$/, sets], [/sets\/sv01\/063$/, dex('sv01-063', '063', 'Pachirisu', sv1)]]);
    const hints = parsePokemon({ name: '', bottom: '063/190' }); // no set has 190 cards
    const res = await pokemon.identify(hints);
    expect(seen.some((u) => u.endsWith('/sets/sv01/063'))).toBe(true);
    expect(res[0]!.card.key).toBe('sv01-063');
    expect(pokemon.exactId(res[0]!.card, hints)).toBe(false);
    expect(isConfident(res)).toBe(false);
  });

  it('gives a size one digit off half credit so the right set stays close', async () => {
    const hints = { name: 'Gyarados', nameText: 'BASIC Gyarados HP 130', number: '26', total: '123' };
    const right = pokemon.score({ ...dexPrinting('xy9-26', 'Gyarados EX', '26/122') }, hints);
    const wrong = pokemon.score({ ...dexPrinting('dp2-26', 'Gyarados', '26/123') }, hints);
    expect(wrong).toBe(1);
    expect(right).toBeGreaterThan(0.9);
  });

  function dexPrinting(key: string, name: string, number: string): CardPrinting {
    return { game: 'pokemon', key, name, setName: 's', setCode: 's', number, variants: [], details: {}, source: 'tcgdex' };
  }
});

describe('resolve(): the photo against candidates with and without a picture', () => {
  const canvas = {} as HTMLCanvasElement;
  const dex = (id: string, localId: string, name: string, set: { id: string; name: string; official: number }, image?: string) => ({
    id, localId, name, image, rarity: 'Common', category: 'Pokemon', variants: { normal: true }, set: { id: set.id, name: set.name, cardCount: { official: set.official, total: set.official } }, pricing: null,
  });
  const dp5 = { id: 'dp5', name: 'Majestic Dawn', official: 100 };
  const dp7 = { id: 'dp7', name: 'Stormfront', official: 100 };
  const sets = [{ id: 'dp5', name: 'Majestic Dawn', cardCount: { official: 100, total: 100 } }, { id: 'dp7', name: 'Stormfront', cardCount: { official: 100, total: 100 } }, { id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } }];

  it('ranks the printing the photo confirmed above a same-line reprint whose picture is missing', async () => {
    const { resolve } = await import('../scan/recognize');
    stubFetch([
      [/tcgdex\.net\/v2\/en\/sets$/, sets],
      [/sets\/dp5\/76$/, dex('dp5-76', '76', 'Stunky', dp5, 'https://assets.example/dp5-76')],
      [/sets\/dp7\/76$/, dex('dp7-76', '76', 'Stunky', dp7)],
      [/cards\?name=Stunky/, []],
    ]);
    VISUAL.clear();
    VISUAL.set('dp5-76', 0.7);
    const out = await resolve('pokemon', parsePokemon({ name: 'BASIC Stunky HP 60', bottom: '76/100' }), canvas);
    expect(out.map((c) => [c.card.key, c.visual])).toEqual([['dp5-76', 0.7], ['dp7-76', undefined]]);
    expect(out[0]!.score).toBeCloseTo(0.91, 2);
    expect(out[1]!.score).toBeCloseTo(0.805, 3);
  });

  it('does not add a card whose number was read one digit off on an unverified picture', async () => {
    const { resolve } = await import('../scan/recognize');
    const sv1 = { id: 'sv01', name: 'Scarlet & Violet', official: 198 };
    for (const [image, visual, confident] of [[undefined, undefined, false], ['https://assets.example/sv01-068', 0.5, false], ['https://assets.example/sv01-068', 0.8, true]] as const) {
      stubFetch([[/tcgdex\.net\/v2\/en\/sets$/, sets], [/sets\/sv01\/068$/, dex('sv01-068', '068', 'Pachirisu', sv1, image)]]);
      clearHttpCache();
      VISUAL.clear();
      if (visual !== undefined) VISUAL.set('sv01-068', visual);
      const out = await resolve('pokemon', parsePokemon({ name: '', bottom: 'H SVI EN 068/198' }), canvas);
      expect(out[0]!.card.key).toBe('sv01-068');
      expect(out[0]!.visual).toBe(visual);
      expect(isConfident(out)).toBe(confident);
    }
  });
});
