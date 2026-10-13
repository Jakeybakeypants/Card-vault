/** Lowercase, strip accents and punctuation, collapse whitespace. "Pokémon-ex!" → "pokemon ex". */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** 0–1 similarity of two whole strings. */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * 0–1: how well `needle` appears somewhere inside `haystack`, tolerating OCR typos.
 * Slides a needle-sized window across the haystack and keeps the best match, so a name
 * buried in "BASIC Pikachu HP 60 ⚡" still scores near 1.
 */
export function partialSimilarity(needle: string, haystack: string): number {
  const n = normalize(needle).replace(/ /g, '');
  const h = normalize(haystack).replace(/ /g, '');
  if (!n || !h) return 0;
  if (h.includes(n)) return 1;
  if (h.length <= n.length) return 1 - levenshtein(n, h) / n.length;
  let best = Infinity;
  for (const len of [n.length - 1, n.length, n.length + 1]) {
    if (len < 1 || len > h.length) continue;
    for (let i = 0; i + len <= h.length; i++) {
      best = Math.min(best, levenshtein(n, h.slice(i, i + len)));
      if (best === 0) return 1;
    }
  }
  return Math.max(0, 1 - best / n.length);
}

/** "025" → "25", "TG05" → "TG5", "SWSH050" → "SWSH50". Letters kept, leading zeros of the digits dropped. */
export function stripLeadingZeros(num: string): string {
  const m = /^([A-Za-z]*)0*(\d+)([A-Za-z]*)$/.exec(num.trim());
  return m ? `${m[1]!.toUpperCase()}${m[2]}${m[3]!.toLowerCase()}` : num.trim();
}

export function sameCollectorNumber(a: string, b: string): boolean {
  return stripLeadingZeros(a).toUpperCase() === stripLeadingZeros(b).toUpperCase();
}
