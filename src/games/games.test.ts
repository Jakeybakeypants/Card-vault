import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('WotC-era prices and finishes (TCGdex)', () => {
  // Base Set Gastly as the API serves it: the Unlimited product (42394) is priced "1st-edition" /
  // "unlimited"; the shadowless product (107047) is a separate listing priced "1st-edition" / "normal".
  const gastly = {
    id: 'base1-50',
    localId: '50',
    name: 'Gastly',
    rarity: 'Common',
    category: 'Pokemon',
    variants: { normal: true, holo: false, reverse: false, firstEdition: true },
    set: { id: 'base1', name: 'Base Set', cardCount: { official: 102, total: 102 } },
    pricing: { tcgplayer: { unit: 'USD', updated: '2026-10-12T00:00:00Z', '1st-edition': { productId: 42394, marketPrice: 1.5 }, unlimited: { productId: 42394, marketPrice: 0.3 } } },
    variants_detailed: [
      { type: 'normal', subtype: 'unlimited', size: 'standard', thirdParty: { tcgplayer: 42394 }, pricing: { tcgplayer: { '1st-edition': { productId: 42394, marketPrice: 1.5 }, unlimited: { productId: 42394, marketPrice: 0.3 } } } },
      { type: 'normal', subtype: 'shadowless', size: 'standard', stamp: ['1st-edition'], thirdParty: { tcgplayer: 107047 }, pricing: { tcgplayer: { '1st-edition': { productId: 107047, marketPrice: 6 }, normal: { productId: 107047, marketPrice: 2 } } } },
      { type: 'normal', subtype: 'shadowless', size: 'standard', thirdParty: { tcgplayer: 107047 }, pricing: { tcgplayer: { '1st-edition': { productId: 107047, marketPrice: 6 }, normal: { productId: 107047, marketPrice: 2 } } } },
      { type: 'normal', subtype: '1999-2000-copyright', size: 'standard' },
    ],
  };
  const charizard = {
    id: 'base1-4',
    localId: '4',
    name: 'Charizard',
    rarity: 'Rare',
    variants: { normal: false, holo: true, reverse: false, firstEdition: true },
    set: { id: 'base1', name: 'Base Set', cardCount: { official: 102, total: 102 } },
    pricing: { tcgplayer: { unit: 'USD', 'unlimited-holofoil': { productId: 42382, marketPrice: 300 }, '1st-edition-holofoil': { productId: 42382, marketPrice: 5000 } } },
    variants_detailed: [
      { type: 'holo', subtype: 'unlimited', thirdParty: { tcgplayer: 42382 }, pricing: { tcgplayer: { 'unlimited-holofoil': { productId: 42382, marketPrice: 300 }, '1st-edition-holofoil': { productId: 42382, marketPrice: 5000 } } } },
      { type: 'holo', subtype: 'shadowless', stamp: ['1st-edition'], thirdParty: { tcgplayer: 106999 }, pricing: { tcgplayer: { holofoil: { productId: 106999, marketPrice: 900 }, '1st-edition-holofoil': { productId: 106999, marketPrice: 6000 } } } },
      { type: 'holo', subtype: 'shadowless', thirdParty: { tcgplayer: 106999 }, pricing: { tcgplayer: { holofoil: { productId: 106999, marketPrice: 900 }, '1st-edition-holofoil': { productId: 106999, marketPrice: 6000 } } } },
      { type: 'holo', subtype: '1999-2000-copyright' },
    ],
  };

  it('prices the plain print run as Unlimited and offers it first, never the shadowless price', async () => {
    const { fromDex } = await import('./tcgdex');
    const { unitPrice } = await import('../db/store');
    const { guessFinish } = await import('../scan/recognize');
    const card = fromDex(gastly);
    expect(card.prices).toEqual({ '1st Edition': 1.5, Unlimited: 0.3 });
    expect(card.variants).toEqual(['Unlimited', '1st Edition']);
    expect(card.variants).not.toContain('Normal');
    const finish = guessFinish(card, {}, undefined);
    expect(finish.variant).toBe('Unlimited');
    expect(unitPrice(card, finish.variant)).toBe(0.3);
    expect(card.url).toBe('https://www.tcgplayer.com/product/42394');
    // A copy saved as "Normal" by an older version is the same card.
    expect(unitPrice(card, 'Normal')).toBe(0.3);
  });

  it('values an Unlimited Charizard at the Unlimited Holofoil price, not the shadowless one', async () => {
    const { fromDex } = await import('./tcgdex');
    const { unitPrice } = await import('../db/store');
    const { guessFinish } = await import('../scan/recognize');
    const card = fromDex(charizard);
    expect(card.prices).toEqual({ 'Unlimited Holofoil': 300, '1st Edition Holofoil': 5000 });
    expect(card.variants).toEqual(['Unlimited Holofoil', '1st Edition Holofoil']);
    expect(unitPrice(card, guessFinish(card, {}, undefined).variant)).toBe(300);
    expect(unitPrice(card, '1st Edition Holofoil')).toBe(5000);
  });

  it('drops the card-level price list when it belongs to a shadowless product', async () => {
    const { fromDex } = await import('./tcgdex');
    // The plain Unlimited variant has no listing today, so TCGdex's root pricing is the shadowless one.
    const card = fromDex({
      ...gastly,
      pricing: { tcgplayer: { unit: 'USD', '1st-edition': { productId: 107047, marketPrice: 6 }, normal: { productId: 107047, marketPrice: 2 } } },
      variants_detailed: [{ type: 'normal', subtype: 'unlimited', thirdParty: { tcgplayer: 42394 } }, ...gastly.variants_detailed.slice(1)],
    });
    expect(card.prices).toBeUndefined();
    expect(card.variants).toEqual(['Normal', '1st Edition']);
    expect(card.url).toBe('https://www.tcgplayer.com/product/42394');
  });

  it('keeps the card-level price list when the only printings are special foils (Fossil)', async () => {
    const { fromDex } = await import('./tcgdex');
    const card = fromDex({
      id: 'base3-18', localId: '18', name: 'Raichu', variants: { holo: true, firstEdition: true },
      set: { id: 'base3', name: 'Fossil', cardCount: { official: 62, total: 62 } },
      pricing: { tcgplayer: { unit: 'USD', 'unlimited-holofoil': { productId: 44426, marketPrice: 20 }, '1st-edition-holofoil': { productId: 44426, marketPrice: 90 } } },
      variants_detailed: [
        { type: 'holo', foil: 'galaxy', thirdParty: { tcgplayer: 44426 }, pricing: { tcgplayer: { 'unlimited-holofoil': { productId: 44426, marketPrice: 20 }, '1st-edition-holofoil': { productId: 44426, marketPrice: 90 } } } },
        { type: 'holo', stamp: ['1st-edition'], foil: 'galaxy', thirdParty: { tcgplayer: 44426 } },
        { type: 'holo', subtype: '1999-2000-copyright' },
      ],
    });
    expect(card.prices).toEqual({ 'Unlimited Holofoil': 20, '1st Edition Holofoil': 90 });
    expect(card.variants).toEqual(['Unlimited Holofoil', '1st Edition Holofoil']);
  });

  it('does not take a jumbo printing’s price for the standard card', async () => {
    const { fromDex } = await import('./tcgdex');
    const card = fromDex({
      id: 'hgss4-101', localId: '101', name: 'Darkrai & Cresselia LEGEND', variants: { holo: true },
      set: { id: 'hgss4', name: 'Triumphant', cardCount: { official: 102, total: 103 } },
      pricing: { tcgplayer: null },
      variants_detailed: [
        { type: 'holo', size: 'standard', thirdParty: { tcgplayer: 87914 }, pricing: { tcgplayer: null } },
        { type: 'holo', size: 'jumbo', thirdParty: { tcgplayer: 211449 }, pricing: { tcgplayer: { holofoil: { productId: 211449, marketPrice: 25 } } } },
      ],
    });
    expect(card.prices).toBeUndefined();
    expect(card.url).toBe('https://www.tcgplayer.com/product/87914');
  });

  it('names TCGplayer’s own price date in the source, and keeps the fetch time for the refresh', async () => {
    const { dexPriceSource, fromDex } = await import('./tcgdex');
    const card = fromDex(gastly);
    expect(card.priceSource).toBe('TCGplayer market (via TCGdex, prices of 2026-10-12)');
    expect(card.pricesUpdatedAt!.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(dexPriceSource(undefined)).toBe('TCGplayer market (via TCGdex)');
  });

  it('dexVariants: the 1st Edition label follows the base finish; Unlimited replaces Normal only when priced', async () => {
    const { dexVariants } = await import('./tcgdex');
    expect(dexVariants({ variants: { normal: true, firstEdition: true } } as never, [])).toEqual(['Normal', '1st Edition']);
    expect(dexVariants({ variants: { holo: true, firstEdition: true } } as never, ['Unlimited Holofoil', '1st Edition Holofoil'])).toEqual(['Unlimited Holofoil', '1st Edition Holofoil']);
    expect(dexVariants({ variants: { normal: true, reverse: true } } as never, ['Normal', 'Reverse Holofoil'])).toEqual(['Normal', 'Reverse Holofoil']);
    // Flagged normal but only ever sold as holofoil: holofoil first.
    expect(dexVariants({ variants: { normal: true, reverse: true } } as never, ['Holofoil', 'Reverse Holofoil'])).toEqual(['Holofoil', 'Normal', 'Reverse Holofoil']);
  });
});

describe('pokemontcg.io fallback finishes', () => {
  const priced = (id: string, name: string, number: string, set: { id: string; name: string; printedTotal: number; releaseDate?: string }, prices: Record<string, { market: number | null; mid: number | null }>, rarity = 'Rare Holo') => ({
    ...ptcgCard(id, name, number, set.id, set.printedTotal),
    rarity,
    set: { id: set.id, name: set.name, series: 'X', printedTotal: set.printedTotal, total: set.printedTotal, releaseDate: set.releaseDate ?? '2020/01/01' },
    tcgplayer: { url: `https://www.tcgplayer.com/product/${id}`, prices },
  });

  it('orders finishes like TCGdex: an Unlimited Charizard is not auto-added as 1st Edition', async () => {
    const { guessFinish } = await import('../scan/recognize');
    const { unitPrice } = await import('../db/store');
    stubFetch([[/pokemontcg\.io.*printedTotal:102/, { data: [priced('base1-4', 'Charizard', '4', { id: 'base1', name: 'Base', printedTotal: 102 }, { '1stEditionHolofoil': { market: 5000, mid: 5200 }, unlimitedHolofoil: { market: 300, mid: 320 } })] }]]);
    const res = await pokemon.identify({ number: '4', total: '102', name: 'Charizard', nameText: 'Charizard' });
    const card = res[0]!.card;
    expect(card.variants).toEqual(['Unlimited Holofoil', '1st Edition Holofoil']);
    const finish = guessFinish(card, {}, undefined);
    expect(finish.variant).toBe('Unlimited Holofoil');
    expect(unitPrice(card, finish.variant)).toBe(300);
    expect(isConfident(res)).toBe(true);
  });

  it('a card priced only as reverse holo still offers Normal first', async () => {
    const { guessFinish } = await import('../scan/recognize');
    stubFetch([[/pokemontcg\.io.*printedTotal:189/, { data: [priced('swsh3-136', 'Furret', '136', { id: 'swsh3', name: 'Darkness Ablaze', printedTotal: 189 }, { reverseHolofoil: { market: 0.33, mid: 0.4 } }, 'Uncommon')] }]]);
    const card = (await pokemon.identify({ number: '136', total: '189', name: 'Furret', nameText: 'Furret' }))[0]!.card;
    expect(card.variants).toEqual(['Normal', 'Holofoil', 'Reverse Holofoil']);
    expect(card.prices).toEqual({ 'Reverse Holofoil': 0.33 });
    const flat = guessFinish(card, {}, 0.0);
    expect(flat.variant).toBe('Normal');
    expect(flat.confidence).toBeLessThan(1);
  });

  it('ptcgVariants mirrors dexVariants for every price-key combination', async () => {
    const { ptcgVariants } = await import('./pokemon');
    expect(ptcgVariants(['Normal', 'Reverse Holofoil'], 'Common')).toEqual(['Normal', 'Holofoil', 'Reverse Holofoil']);
    expect(ptcgVariants(['Holofoil', 'Reverse Holofoil'], 'Rare Holo')).toEqual(['Holofoil', 'Normal', 'Reverse Holofoil']);
    expect(ptcgVariants(['Normal', 'Holofoil', 'Reverse Holofoil'], 'Common')).toEqual(['Holofoil', 'Normal', 'Reverse Holofoil']);
    expect(ptcgVariants(['1st Edition', 'Unlimited'], 'Common')).toEqual(['Unlimited', '1st Edition']);
    expect(ptcgVariants(['1st Edition Holofoil', 'Unlimited Holofoil'], 'Rare Holo')).toEqual(['Unlimited Holofoil', '1st Edition Holofoil']);
    expect(ptcgVariants([], 'Rare Holo')).toEqual(['Holofoil', 'Normal', 'Reverse Holofoil']);
    expect(ptcgVariants([], 'Common')).toEqual(['Normal', 'Holofoil', 'Reverse Holofoil']);
  });
});

describe('ptcgTwin set matching', () => {
  const dexCard = (id: string, localId: string, name: string, set: { id: string; name: string; official: number }) => ({
    id, localId, name, rarity: 'Rare', category: 'Pokemon', variants: { holo: true },
    set: { id: set.id, name: set.name, cardCount: { official: set.official, total: set.official } },
    pricing: { tcgplayer: null, cardmarket: null },
    variants_detailed: [{ type: 'holo', thirdParty: { cardmarket: 1 } }],
  });
  const hit = (id: string, name: string, number: string, set: { id: string; name: string; printedTotal: number; releaseDate?: string }, price: number) => ({
    ...ptcgCard(id, name, number, set.id, set.printedTotal),
    set: { id: set.id, name: set.name, series: 'X', printedTotal: set.printedTotal, total: set.printedTotal, releaseDate: set.releaseDate ?? '2020/01/01' },
    tcgplayer: { url: `https://www.tcgplayer.com/product/${id}`, prices: { holofoil: { market: price, mid: price } } },
  });
  const partial = (key: string, name: string, setName: string, number: string) => ({ game: 'pokemon' as const, key, name, setName, setCode: 'x', number, variants: [], details: {}, source: 'tcgdex', partial: true });

  it('maps TCGdex set ids to pokemontcg.io’s spellings', async () => {
    const { ptcgSetIds } = await import('./pokemon');
    expect(ptcgSetIds('sv01')).toContain('sv1');
    expect(ptcgSetIds('sv03.5')).toContain('sv3pt5');
    expect(ptcgSetIds('me02.5')).toContain('me2pt5');
    expect(ptcgSetIds('sm3.5')).toContain('sm35');
    expect(ptcgSetIds('sm11.5')).toContain('sm115');
    expect(ptcgSetIds('swsh4.5sv')).toContain('swsh45sv');
    expect(ptcgSetIds('swsh12.5gg')).toContain('swsh12pt5gg');
    expect(ptcgSetIds('cel25cc')).toEqual(['cel25c']);
    expect(ptcgSetIds('swsh9tg')).toEqual(['swsh9tg']);
    expect(ptcgSetIds('base1')).toEqual(['base1']);
  });

  it('takes no twin from another set when the only hit is in one (My First Battle)', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/cards\/mfb-7$/, dexCard('mfb-7', '7', 'Pikachu', { id: 'mfb', name: 'My First Battle', official: 48 })],
      [/pokemontcg\.io.*number:7.*name:"Pikachu"/, { data: [hit('mcd19-7', 'Pikachu', '7', { id: 'mcd19', name: "McDonald's Collection 2019", printedTotal: 12 }, 4.2)] }],
    ]);
    const full = await pokemon.complete(partial('mfb-7', 'Pikachu', 'My First Battle', '7/48'));
    expect(full.prices).toBeUndefined();
    expect(full.url).not.toContain('mcd19-7');
  });

  it('picks the same set by id even when the names differ and a newer same-size set exists', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/cards\/sve-001$/, dexCard('sve-001', '001', 'Basic Grass Energy', { id: 'sve', name: 'Scarlet & Violet Energy', official: 8 })],
      [/pokemontcg\.io.*name:"Basic Grass Energy"/, { data: [
        hit('me1e-1', 'Basic Grass Energy', '1', { id: 'me1e', name: 'Mega Evolution Energies', printedTotal: 8, releaseDate: '2025/09/26' }, 0.9),
        hit('sve-1', 'Basic Grass Energy', '1', { id: 'sve', name: 'Scarlet & Violet Energies', printedTotal: 8, releaseDate: '2023/03/31' }, 0.1),
      ] }],
    ]);
    const full = await pokemon.complete(partial('sve-001', 'Basic Grass Energy', 'Scarlet & Violet Energy', '001/8'));
    expect(full.prices).toEqual({ Holofoil: 0.1 });
    expect(full.url).toBe('https://www.tcgplayer.com/product/sve-1');
  });

  it('names WotC-era twin prices as Unlimited on the chips too', async () => {
    stubFetch([
      [/tcgdex\.net\/v2\/en\/cards\/base1-50$/, { ...dexCard('base1-50', '50', 'Gastly', { id: 'base1', name: 'Base Set', official: 102 }), variants: { normal: true, firstEdition: true } }],
      [/pokemontcg\.io.*number:50.*name:"Gastly"/, { data: [{ ...hit('base1-50', 'Gastly', '50', { id: 'base1', name: 'Base', printedTotal: 102 }, 0), tcgplayer: { url: 'https://www.tcgplayer.com/product/42394', prices: { '1stEdition': { market: 1.5, mid: 2 }, unlimited: { market: 0.3, mid: 0.4 } } } }] }],
    ]);
    const full = await pokemon.complete(partial('base1-50', 'Gastly', 'Base Set', '50/102'));
    expect(full.prices).toEqual({ '1st Edition': 1.5, Unlimited: 0.3 });
    expect(full.variants).toEqual(['Unlimited', '1st Edition']);
  });
});
