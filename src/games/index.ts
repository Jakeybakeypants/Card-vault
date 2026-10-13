import type { GameId } from '../types';
import type { Game } from './game';
import { pokemon, POKEMON_VARIANTS } from './pokemon';
import { yugioh, YUGIOH_VARIANTS } from './yugioh';

export const GAMES: Record<GameId, Game> = { pokemon, yugioh };
export const GAME_LIST: Game[] = [pokemon, yugioh];
export const ALL_VARIANTS: Record<GameId, string[]> = { pokemon: POKEMON_VARIANTS, yugioh: YUGIOH_VARIANTS };

export { isConfident } from './game';
export type { Game } from './game';
