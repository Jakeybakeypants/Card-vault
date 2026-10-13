import type { Condition, GameId } from '../types';

export interface Settings {
  game: GameId;
  /** Add the card straight away when the scan is unambiguous. */
  autoAdd: boolean;
  defaultCondition: Condition;
  defaultLanguage: string;
  /** Optional: raises pokemontcg.io's rate limits. */
  pokemonTcgApiKey: string;
  /** Optional: enables "AI scan", which reads the card with Claude instead of on-device OCR. */
  anthropicApiKey: string;
  useAi: boolean;
}

const DEFAULTS: Settings = {
  game: 'pokemon',
  autoAdd: true,
  defaultCondition: 'NM',
  defaultLanguage: 'EN',
  pokemonTcgApiKey: '',
  anthropicApiKey: '',
  useAi: false,
};

const KEY = 'card-vault:settings';
let current: Settings = load();
const listeners = new Set<(s: Settings) => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode / storage blocked: settings just won't persist.
  }
  for (const fn of listeners) fn(current);
}

export function onSettings(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
