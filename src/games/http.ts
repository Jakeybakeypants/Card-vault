export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}`);
  }
}

const cache = new Map<string, Promise<unknown>>();

export interface GetInit {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Skip the session cache (price refreshes). The fresh response replaces the cached one. */
  fresh?: boolean;
}

/**
 * GET a JSON document with a timeout. Successful responses are memoised for the session so
 * re-scanning the same card, or flicking between candidates, costs no extra requests.
 */
export function getJson<T>(url: string, init: GetInit = {}): Promise<T> {
  const hit = init.fresh ? undefined : cache.get(url);
  if (hit) return hit as Promise<T>;
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, { headers: init.headers, signal: ctrl.signal });
      if (!res.ok) throw new HttpError(res.status, url);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

/** Like getJson, but "no such card" (400/404) resolves to null instead of throwing. */
export async function getJsonOrNull<T>(url: string, init?: GetInit): Promise<T | null> {
  try {
    return await getJson<T>(url, init);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 400 || e.status === 404)) return null;
    throw e;
  }
}

export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  return u.toString();
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run jobs a few at a time, to stay polite to the APIs. */
export async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** For tests. */
export function clearHttpCache(): void {
  cache.clear();
}
