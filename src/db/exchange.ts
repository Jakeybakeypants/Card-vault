import type { CollectionEntry } from '../types';
import { CONDITIONS } from '../types';
import { entryValue, listEntries, putEntry } from './store';

function download(name: string, type: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (): string => new Date().toISOString().slice(0, 10);

export async function exportJson(): Promise<void> {
  const entries = await listEntries();
  download(`card-vault-${stamp()}.json`, 'application/json', JSON.stringify({ app: 'card-vault', version: 1, entries }, null, 2));
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Spreadsheet-friendly export: one row per collection entry. */
export async function exportCsv(): Promise<void> {
  const entries = await listEntries();
  const header = ['Game', 'Name', 'Set', 'Set Code', 'Number', 'Rarity', 'Variant', 'Condition', 'Language', 'Quantity', 'Est. Value (USD)', 'Card ID', 'Source', 'Added', 'Notes'];
  const rows = entries.map((e) => [
    e.card.game === 'pokemon' ? 'Pokémon' : 'Yu-Gi-Oh!',
    e.card.name,
    e.card.setName,
    e.card.setCode,
    e.card.number,
    e.card.rarity,
    e.variant,
    e.condition,
    e.language,
    e.quantity,
    entryValue(e)?.toFixed(2),
    e.card.key,
    e.card.source,
    e.addedAt.slice(0, 10),
    e.notes,
  ]);
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  download(`card-vault-${stamp()}.csv`, 'text/csv', '﻿' + body);
}

function isEntry(x: unknown): x is CollectionEntry {
  const e = x as CollectionEntry;
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.quantity === 'number' &&
    !!e.card &&
    typeof e.card.key === 'string' &&
    (e.card.game === 'pokemon' || e.card.game === 'yugioh') &&
    CONDITIONS.includes(e.condition)
  );
}

/** Merge a JSON backup into the collection. Rows already present keep the larger quantity. */
export async function importJson(file: File): Promise<number> {
  const data = JSON.parse(await file.text()) as { entries?: unknown[] };
  const incoming = (data.entries ?? []).filter(isEntry);
  const existing = new Map((await listEntries()).map((e) => [e.id, e]));
  for (const e of incoming) {
    const prev = existing.get(e.id);
    await putEntry(prev ? { ...e, quantity: Math.max(prev.quantity, e.quantity) } : e);
  }
  return incoming.length;
}
