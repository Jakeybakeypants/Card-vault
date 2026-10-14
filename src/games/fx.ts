import { getJson } from './http';

/**
 * EUR → USD, for cards whose only price is Cardmarket's. Fetched at most once a day from free,
 * keyless rate APIs and remembered in the browser; a stale rate beats none.
 */
const KEY = 'card-vault:eur-usd';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Saved {
  rate: number;
  at: number;
}

function saved(): Saved | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    return s && Number.isFinite(s.rate) && s.rate > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

const SOURCES: Array<[url: string, read: (json: unknown) => number | undefined]> = [
  ['https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', (j) => (j as { rates?: { USD?: number } }).rates?.USD],
  ['https://api.frankfurter.app/latest?from=EUR&to=USD', (j) => (j as { rates?: { USD?: number } }).rates?.USD],
  ['https://open.er-api.com/v6/latest/EUR', (j) => (j as { rates?: { USD?: number } }).rates?.USD],
];

let pending: Promise<number | undefined> | null = null;

export function eurToUsd(): Promise<number | undefined> {
  const s = saved();
  if (s && Date.now() - s.at < DAY_MS) return Promise.resolve(s.rate);
  pending ??= (async () => {
    for (const [url, read] of SOURCES) {
      const rate = await getJson<unknown>(url, { timeoutMs: 8000 }).then(read, () => undefined);
      if (rate && Number.isFinite(rate) && rate > 0) {
        try {
          localStorage.setItem(KEY, JSON.stringify({ rate, at: Date.now() } satisfies Saved));
        } catch {
          // Storage blocked: fetched again next session.
        }
        return rate;
      }
    }
    return s?.rate;
  })().finally(() => (pending = null));
  return pending;
}
