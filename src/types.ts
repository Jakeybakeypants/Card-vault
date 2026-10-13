export type GameId = 'pokemon' | 'yugioh';

/** One exact printing of a card, as returned by a catalog source. */
export interface CardPrinting {
  game: GameId;
  /** Stable id for this printing: `sv1-25` (Pokémon), `LOB-EN005:Ultra Rare` (Yu-Gi-Oh!). */
  key: string;
  name: string;
  setName: string;
  /** Short set code: `sv1` / `PAL` for Pokémon, `LOB` for Yu-Gi-Oh!. */
  setCode: string;
  /** Collector number as printed: `25/198`, `TG05/TG30`, `LOB-EN005`. */
  number: string;
  rarity?: string;
  image?: string;
  imageLarge?: string;
  /** Market price in USD per variant label (`Holofoil`, `1st Edition`…). */
  prices?: Record<string, number>;
  /** Variants this printing exists in, best guess first. */
  variants: string[];
  releaseDate?: string;
  url?: string;
  /** Short facts shown on the detail sheet (HP, types, ATK/DEF…). */
  details: Record<string, string>;
  source: string;
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
  /** Pokémon: collector number without the total (`25`, `TG05`, `SWSH050`). */
  number?: string;
  /** Pokémon: printed set total (`198`). */
  total?: string;
  /** Pokémon: PTCGO set code seen near the number (`PAL`). YGO: full set code (`LOB-EN005`). */
  setCode?: string;
  /** Yu-Gi-Oh!: 8-digit passcode. */
  passcode?: string;
  /** Variant read off the card (`1st Edition`, `Reverse Holofoil`…). */
  variant?: string;
  language?: string;
  /** Everything OCR returned, region by region, for debugging. */
  raw?: Record<string, string>;
}

export interface Candidate {
  card: CardPrinting;
  /** 0–1: how well this printing matches the scan. */
  score: number;
}
