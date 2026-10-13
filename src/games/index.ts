import type { GameId } from '../types';
import type { Game } from './game';
import { lorcana, LORCANA_VARIANTS } from './lorcana';
import { mtg, MTG_VARIANTS } from './mtg';
import { pokemon, POKEMON_VARIANTS } from './pokemon';
import { yugioh, YUGIOH_VARIANTS } from './yugioh';

export const GAMES: Record<GameId, Game> = { pokemon, yugioh, mtg, lorcana };
export const GAME_LIST: Game[] = [pokemon, yugioh, mtg, lorcana];
export const ALL_VARIANTS: Record<GameId, string[]> = { pokemon: POKEMON_VARIANTS, yugioh: YUGIOH_VARIANTS, mtg: MTG_VARIANTS, lorcana: LORCANA_VARIANTS };

export { isConfident } from './game';
export type { Game } from './game';
