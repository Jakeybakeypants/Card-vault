export type GameId = 'pokemon' | 'yugioh' | 'mtg' | 'lorcana';

/** One exact printing of a card, as returned by a catalog source. */
export interface CardPrinting {
  game: GameId;
  /** Stable id for this printing: `sv1-25` (Pokémon), `LOB-EN005:Ultra Rare` (Yu-Gi-Oh!), `m21-123` (Magic), `1-12` (Lorcana). */
  key: string;
  name: string;
  setName: string;
  /** Short set code: `sv1` / `PAL` for Pokémon, `LOB` for Yu-Gi-Oh!, `M21` for Magic, `1` for Lorcana. */
  setCode: string;
  /** Collector number as printed: `25/198`, `TG05/TG30`, `LOB-EN005`. */
  number: string;
  rarity?: string;
  image?: string;
  imageLarge?: string;
  /** Market price in USD per variant label (`Holofoil`, `1st Edition`…), or `default` for all. */
  prices?: Record<string, number>;
  /** Where the prices came from and when, so stale prices can be refreshed. */
  priceSource?: string;
  pricesUpdatedAt?: string;
  /** Variants this printing exists in, best guess first. */
  variants: string[];
  releaseDate?: string;
  url?: string;
  /** Short facts shown on the detail sheet (HP, types, ATK/DEF…). */
  details: Record<string, string>;
  source: string;
  /**
   * Search results that only carry name, number and image (enough to compare pictures). The
   * game's `complete()` fills in the rest before the card is shown or saved.
   */
  partial?: boolean;
}

export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
export const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const CONDITION_LABELS: Record<Condition, string> = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
};

/** A row in the collection: N copies of one printing in one variant/condition/language. */
export interface CollectionEntry {
  id: string;
  card: CardPrinting;
  quantity: number;
  variant: string;
  condition: Condition;
  language: string;
  notes?: string;
  addedAt: string;
  updatedAt: string;
}

/** Everything the scanner could read off a card. All fields optional; parsers fill what they can. */
export interface ScanHints {
  game?: GameId;
  /** Best guess at the card name, if one could be isolated. */
  name?: string;
  /** Raw text of the name strip, for fuzzy matching candidates against. */
  nameText?: string;
  /** Other plausible name words from the name strip, most likely first, to search on as well. */
  nameCandidates?: string[];
  /** Pokémon: the card type a label on the name strip gave away (TRAINER / ITEM / SUPPORTER / ENERGY…). */
  category?: 'trainer' | 'energy';
  /** Pokémon: collector number without the total (`25`, `TG05`, `SWSH050`). */
  number?: string;
  /** Pokémon: printed set total (`198`). */
  total?: string;
  /** Pokémon: PTCGO set code seen near the number (`PAL`). YGO: full set code (`LOB-EN005`). */
  setCode?: string;
  /** The expansion's name, when it could be told (AI scan reads the set symbol). */
  setName?: string;
  /** Yu-Gi-Oh!: 8-digit passcode. */
  passcode?: string;
  /** Variant read off the card (`1st Edition`, `Reverse Holofoil`…). */
  variant?: string;
  /** 0–1: how sure the variant guess is. Below ~0.7 the app asks with one tap instead of assuming. */
  variantConfidence?: number;
  /** Bright, washed-out patches over the identifier text: the user should tilt the card. */
  glare?: boolean;
  language?: string;
  /** Everything OCR returned, region by region, for debugging. */
  raw?: Record<string, string>;
}

export interface Candidate {
  card: CardPrinting;
  /** 0–1: how well this printing matches the scan. */
  score: number;
  /** 0–1: how alike the photo and the catalog picture are, when they could be compared. */
  visual?: number;
  /**
   * Which of the scan's signals this printing agrees with: name similarity (0–1), whether the
   * collector number matches, and whether the set does (printed size or set code). Each is
   * undefined when the scan didn't read that signal. A game that fills this in gets the
   * two-signal rule in `isConfident`; one that doesn't is judged on the score alone.
   */
  signals?: { name?: number; number?: boolean; set?: boolean };
}

/** A set / expansion, as listed by a catalog. */
export interface CardSet {
  game: GameId;
  /** Catalog id: `sv01` (TCGdex), `ptcg:sv1` (pokemontcg.io fallback), the set name (Yu-Gi-Oh!), the set code (Magic, Lorcana). */
  id: string;
  name: string;
  /** Short code shown next to the name: `SVI`, `LOB`. */
  code: string;
  /** Cards in the set, including secret rares. */
  total: number;
  releaseDate?: string;
  series?: string;
  logo?: string;
}
