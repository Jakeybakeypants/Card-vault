import { GAMES } from '../games';
import type { Candidate, GameId, ScanHints } from '../types';
import { readCardWithClaude } from './ai';
import { ocrRegion, ocrRegions } from './ocr';

export interface Recognition {
  game: GameId;
  hints: ScanHints;
  candidates: Candidate[];
}

function hasId(h: ScanHints): boolean {
  return !!(h.number || h.setCode || h.passcode);
}

/** On-device OCR of the card strips, then a catalog lookup. */
export async function recognizeWithOcr(game: GameId, card: HTMLCanvasElement, status: (s: string) => void): Promise<Recognition> {
  const g = GAMES[game];
  status('Reading card…');
  const raw = await ocrRegions(card, g.regions);
  let hints = g.parse(raw);

  // No number/code found: the print may be light-on-dark (full arts, ex cards, Pendulum
  // boxes). Re-read the identifier strips inverted and keep whatever that adds.
  if (!hasId(hints)) {
    status('Looking closer…');
    const inverted: Record<string, string> = { ...raw };
    for (const r of g.regions.filter((r) => r.key !== 'name')) inverted[r.key] = await ocrRegion(card, r, true);
    const retry = g.parse(inverted);
    if (hasId(retry)) hints = { ...retry, name: hints.name ?? retry.name, nameText: hints.nameText };
  }

  if (!hasId(hints) && !hints.name) return { game, hints, candidates: [] };
  status('Looking it up…');
  return { game, hints, candidates: await g.identify(hints) };
}

/** Claude reads the card (and works out which game it is), then a catalog lookup. */
export async function recognizeWithClaude(card: HTMLCanvasElement, apiKey: string, status: (s: string) => void): Promise<Recognition> {
  status('Asking Claude…');
  const hints = await readCardWithClaude(card, apiKey);
  const game = hints.game!;
  status('Looking it up…');
  return { game, hints, candidates: await GAMES[game].identify(hints) };
}
