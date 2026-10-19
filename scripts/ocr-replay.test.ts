/**
 * Replays what OCR read on real card photos through the parser and the lookup, against a local
 * copy of the TCGdex catalog: text only, no photo comparison, so it measures the parser and the
 * ranking on real reads in seconds. The input is the results file of the real-photo harness
 * (one JSON object per scan with dexId, condition, kind and hints.raw as the app recorded it).
 *
 *   OCR_LOG=scans.jsonl TCGDEX_DIR=../cards-database REPLAY_OUT=replay.txt REPLAY_MISSES=misses.txt npx vitest run scripts/ocr-replay.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as parse from '../src/scan/parse';
import { isConfident } from '../src/games/game';
import { pokemon } from '../src/games/pokemon';
import type { ScanHints } from '../src/types';
import { fakeApi, loadCatalog } from './tcgdexFake';

const DIR = process.env.TCGDEX_DIR;
const LOG = process.env.OCR_LOG;

interface Scan {
  dexId: string;
  condition: string;
  kind: string;
  era: string;
  name: string;
  hints?: { raw?: Record<string, string> };
}

type Merge = (first: { number?: string; total?: string }, closer: { number?: string; total?: string }, text?: string) => { number?: string; total?: string };
// Older parsers had no gate: the close read always won.
const merge: Merge = (parse as { mergeSecondLook?: Merge }).mergeSecondLook ?? ((first, closer) => (closer.number ? closer : first));

/** The app's readWithOcr, replayed from the strips it recorded. */
function readHints(raw: Record<string, string>): ScanHints {
  let hints = parse.parsePokemon({ name: raw.name ?? '', bottom: raw.bottom ?? '' });
  const inverted = raw['name (inverted)'];
  if (!hints.name && inverted) {
    const retry = parse.parsePokemon({ name: inverted, bottom: raw.bottom ?? '' });
    if (retry.name) hints = { ...hints, name: retry.name, nameText: retry.nameText, nameCandidates: retry.nameCandidates };
  }
  const reread = raw['bottom (second look)'];
  if (reread) {
    const closer = parse.parsePokemon({ name: raw.name ?? '', bottom: reread });
    const merged = merge(hints, closer, reread);
    hints.number = merged.number;
    hints.total = merged.total;
  }
  return hints;
}

interface Tally {
  n: number;
  top1: number;
  top10: number;
  auto: number;
  autoWrong: number;
  none: number;
}
const tally = (): Tally => ({ n: 0, top1: 0, top10: 0, auto: 0, autoWrong: 0, none: 0 });

describe.skipIf(!DIR || !LOG)('real OCR reads replayed through parser and lookup', () => {
  const { sets, cards } = DIR && LOG ? loadCatalog(DIR) : { sets: [], cards: [] };
  const scans: Scan[] = LOG ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Scan) : [];
  const byCondition = new Map<string, Tally>();
  const byKind = new Map<string, Tally>();
  const misses: string[] = [];
  const all = tally();

  afterAll(() => {
    vi.unstubAllGlobals();
    const pct = (a: number, n: number) => `${((100 * a) / n).toFixed(0)}%`.padStart(7);
    const row = (k: string, r: Tally) => `${k.padEnd(14)} ${String(r.n).padStart(5)} ${pct(r.top1, r.n)} ${pct(r.top10, r.n)} ${pct(r.auto, r.n)} ${pct(r.autoWrong, r.n).padStart(11)} ${pct(r.none, r.n).padStart(9)}`;
    const report = [
      `${scans.length} scans, text only (auto = would be added without asking before the photo is compared)`,
      `${'group'.padEnd(14)}     n   top-1  top-10    auto  AUTO-WRONG  no match`,
      ...[...byCondition.entries()].sort().map(([k, r]) => row(k, r)),
      ...[...byKind.entries()].sort().map(([k, r]) => row(k, r)),
      row('ALL', all),
    ].join('\n');
    console.log(report);
    if (process.env.REPLAY_OUT) writeFileSync(process.env.REPLAY_OUT, report);
    if (process.env.REPLAY_MISSES) writeFileSync(process.env.REPLAY_MISSES, misses.join('\n'));
  });

  it('runs every scan', async () => {
    fakeApi(sets, cards);
    for (const scan of scans) {
      const raw = scan.hints?.raw;
      if (!raw) continue;
      const hints = readHints(raw);
      const found = hints.number || hints.name ? await pokemon.identify(hints) : [];
      const at = found.findIndex((c) => c.card.key === scan.dexId);
      const confident = found.length > 0 && isConfident(found);
      for (const t of [all, byCondition.get(scan.condition) ?? byCondition.set(scan.condition, tally()).get(scan.condition)!, byKind.get(scan.kind) ?? byKind.set(scan.kind, tally()).get(scan.kind)!]) {
        t.n++;
        if (at === 0) t.top1++;
        if (at >= 0 && at < 10) t.top10++;
        if (confident) t.auto++;
        if (confident && at !== 0) t.autoWrong++;
        if (!found.length) t.none++;
      }
      if (at !== 0) {
        misses.push(
          `${confident ? 'WRONG-AUTO' : at < 0 ? 'miss' : `top${at + 1}`}\t${scan.dexId}\t${scan.condition}\t${scan.kind}\t${scan.name}\t${JSON.stringify({ name: hints.name, number: hints.number, total: hints.total, setCode: hints.setCode })}\t${found.slice(0, 3).map((c) => `${c.card.key}:${c.score.toFixed(2)}`).join(' ')}`,
        );
      }
    }
    expect(all.autoWrong).toBe(0);
  }, 20 * 60 * 1000);
});
