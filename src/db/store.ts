import type { CardPrinting, CollectionEntry, Condition, GameId } from '../types';

/**
 * The collection lives in IndexedDB on this device: one `entries` row per
 * (printing, variant, condition, language), plus card images cached as blobs so the
 * collection works offline and doesn't keep hot-linking the catalogs' image servers.
 */
const DB_NAME = 'card-vault';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

// ---------------------------------------------------------------------------------------------
// Change notifications so every view stays in sync.

const listeners = new Set<() => void>();
export function onCollectionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed(): void {
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------------------------------------

export function entryId(game: GameId, key: string, variant: string, condition: Condition, language: string): string {
  return [game, key, variant, condition, language].join('|');
}

export function listEntries(): Promise<CollectionEntry[]> {
  return tx<CollectionEntry[]>('entries', 'readonly', (s) => s.getAll());
}

export function getEntry(id: string): Promise<CollectionEntry | undefined> {
  return tx<CollectionEntry | undefined>('entries', 'readonly', (s) => s.get(id));
}

export async function putEntry(entry: CollectionEntry): Promise<void> {
  await tx('entries', 'readwrite', (s) => s.put(entry));
  changed();
}

/** Write many entries in one transaction with a single change notification. */
export async function putEntries(entries: CollectionEntry[]): Promise<void> {
  if (!entries.length) return;
  await db().then(
    (d) =>
      new Promise<void>((resolve, reject) => {
        const t = d.transaction('entries', 'readwrite');
        const store = t.objectStore('entries');
        for (const e of entries) store.put(e);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
  changed();
}

export async function deleteEntry(id: string): Promise<void> {
  await tx('entries', 'readwrite', (s) => s.delete(id));
  changed();
}

export interface AddOptions {
  variant: string;
  condition: Condition;
  language: string;
  quantity?: number;
}

/**
 * Add copies of a card. Re-adding the same printing/variant/condition/language bumps the
 * quantity instead of creating a duplicate row. Returns an undo function.
 */
export async function addCard(card: CardPrinting, opts: AddOptions): Promise<{ entry: CollectionEntry; undo: () => Promise<void> }> {
  const id = entryId(card.game, card.key, opts.variant, opts.condition, opts.language);
  const now = new Date().toISOString();
  const prev = await getEntry(id);
  const entry: CollectionEntry = prev
    ? { ...prev, card, quantity: prev.quantity + (opts.quantity ?? 1), updatedAt: now }
    : {
        id,
        card,
        quantity: opts.quantity ?? 1,
        variant: opts.variant,
        condition: opts.condition,
        language: opts.language,
        addedAt: now,
        updatedAt: now,
      };
  await putEntry(entry);
  void cacheImage(card);
  return {
    entry,
    undo: () => (prev ? putEntry(prev) : deleteEntry(id)),
  };
}

/**
 * Edit an entry. Changing variant/condition/language changes its identity, so the row moves,
 * merging into an existing row with the same identity if there is one.
 */
export async function updateEntry(entry: CollectionEntry, patch: Partial<Pick<CollectionEntry, 'quantity' | 'variant' | 'condition' | 'language' | 'notes'>>): Promise<CollectionEntry> {
  const next: CollectionEntry = { ...entry, ...patch, updatedAt: new Date().toISOString() };
  next.id = entryId(next.card.game, next.card.key, next.variant, next.condition, next.language);
  if (next.id !== entry.id) {
    const existing = await getEntry(next.id);
    if (existing) next.quantity += existing.quantity;
    await tx('entries', 'readwrite', (s) => s.delete(entry.id));
  }
  await putEntry(next);
  return next;
}

export async function clearCollection(): Promise<void> {
  await tx('entries', 'readwrite', (s) => s.clear());
  await tx('images', 'readwrite', (s) => s.clear());
  changed();
}

// ---------------------------------------------------------------------------------------------
// Images

const objectUrls = new Map<string, string>();

async function cacheImage(card: CardPrinting): Promise<void> {
  if (!card.image) return;
  const key = `${card.game}|${card.key}`;
  try {
    const existing = await tx<Blob | undefined>('images', 'readonly', (s) => s.get(key));
    if (existing) return;
    const res = await fetch(card.image, { mode: 'cors' });
    if (!res.ok) return;
    const blob = await res.blob();
    await tx('images', 'readwrite', (s) => s.put(blob, key));
  } catch {
    // Image host without CORS, or offline: the remote URL is used instead.
  }
}

/** Cached blob URL for a card image when we have one, else the remote URL. */
export async function imageUrl(card: CardPrinting): Promise<string | undefined> {
  const key = `${card.game}|${card.key}`;
  const known = objectUrls.get(key);
  if (known) return known;
  try {
    const blob = await tx<Blob | undefined>('images', 'readonly', (s) => s.get(key));
    if (blob) {
      const url = URL.createObjectURL(blob);
      objectUrls.set(key, url);
      return url;
    }
  } catch {
    // fall through
  }
  return card.image;
}

// ---------------------------------------------------------------------------------------------
// Value

export function unitPrice(card: CardPrinting, variant: string): number | undefined {
  const p = card.prices;
  if (!p) return undefined;
  const values = Object.values(p);
  return p[variant] ?? p.default ?? (values.length === 1 ? values[0] : undefined);
}

export function entryValue(e: CollectionEntry): number | undefined {
  const unit = unitPrice(e.card, e.variant);
  return unit !== undefined ? unit * e.quantity : undefined;
}
