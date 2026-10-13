import { exportCsv, exportJson, importJson } from '../db/exchange';
import { entryValue, listEntries, onCollectionChange } from '../db/store';
import type { CollectionEntry, GameId } from '../types';
import { cardImg, GAME_LABEL, openEntrySheet } from './cards';
import { clear, h, money, select } from './dom';
import { toast } from './overlay';
import type { View } from './view';

type Sort = 'recent' | 'name' | 'set' | 'value';
type Filter = 'all' | GameId;

export function collectionView(onCount: (n: number) => void): View {
  let entries: CollectionEntry[] = [];
  let filter: Filter = 'all';
  let sort: Sort = 'recent';
  let query = '';

  const stats = h('div', { class: 'stats' });
  const chips = h('div', { class: 'segmented small' });
  const grid = h('div', { class: 'grid' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Search name, set, number…',
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value.toLowerCase();
      render();
    },
  });
  const importInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    hidden: true,
    onchange: async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const f = input.files?.[0];
      input.value = '';
      if (!f) return;
      try {
        toast(`Imported ${await importJson(f)} entries`, { tone: 'ok' });
      } catch (err) {
        toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, { tone: 'warn' });
      }
    },
  });

  function visible(): CollectionEntry[] {
    const list = entries.filter(
      (e) =>
        (filter === 'all' || e.card.game === filter) &&
        (!query || `${e.card.name} ${e.card.setName} ${e.card.number} ${e.card.rarity ?? ''} ${e.notes ?? ''}`.toLowerCase().includes(query)),
    );
    const by: Record<Sort, (a: CollectionEntry, b: CollectionEntry) => number> = {
      recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      name: (a, b) => a.card.name.localeCompare(b.card.name),
      set: (a, b) => a.card.setName.localeCompare(b.card.setName) || a.card.number.localeCompare(b.card.number, undefined, { numeric: true }),
      value: (a, b) => (entryValue(b) ?? -1) - (entryValue(a) ?? -1),
    };
    return list.sort(by[sort]);
  }

  function render(): void {
    const list = visible();
    const scope = entries.filter((e) => filter === 'all' || e.card.game === filter);
    const copies = scope.reduce((n, e) => n + e.quantity, 0);
    const value = scope.reduce((n, e) => n + (entryValue(e) ?? 0), 0);
    clear(
      stats,
      stat(copies.toLocaleString(), copies === 1 ? 'card' : 'cards'),
      stat(new Set(scope.map((e) => `${e.card.game}|${e.card.key}`)).size.toLocaleString(), 'unique'),
      stat(money(value), 'est. value'),
    );
    clear(
      chips,
      (['all', 'pokemon', 'yugioh'] as Filter[]).map((f) =>
        h(
          'button',
          {
            type: 'button',
            class: filter === f ? 'on' : '',
            onclick: () => {
              filter = f;
              render();
            },
          },
          f === 'all' ? 'All' : GAME_LABEL[f],
          ` ${entries.filter((e) => f === 'all' || e.card.game === f).reduce((n, e) => n + e.quantity, 0)}`,
        ),
      ),
    );
    if (!entries.length) {
      clear(grid, h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, '🃏'), h('p', null, 'No cards yet.'), h('p', { class: 'muted' }, 'Scan a card, or add one by name from the Add tab.')));
      return;
    }
    clear(
      grid,
      list.length ? list.map(tile) : h('p', { class: 'muted empty' }, 'Nothing matches.'),
    );
  }

  function tile(e: CollectionEntry): HTMLElement {
    const v = entryValue(e);
    return h(
      'button',
      { type: 'button', class: 'tile', onclick: () => openEntrySheet(e) },
      h('div', { class: 'tile-img' }, cardImg(e.card), e.quantity > 1 && h('span', { class: 'qty' }, `×${e.quantity}`)),
      h('div', { class: 'tile-name' }, e.card.name),
      h('div', { class: 'tile-meta mono' }, e.card.number),
      h('div', { class: 'tile-meta' }, [e.variant, e.condition, e.language !== 'EN' && e.language].filter(Boolean).join(' · ')),
      v !== undefined && h('div', { class: 'tile-price' }, money(v)),
    );
  }

  async function reload(): Promise<void> {
    entries = await listEntries();
    onCount(entries.reduce((n, e) => n + e.quantity, 0));
    render();
  }
  onCollectionChange(() => void reload());
  void reload();

  const el = h(
    'section',
    { class: 'view collection-view' },
    stats,
    h('div', { class: 'toolbar' }, chips, h('div', { class: 'toolbar-row' }, search, select<Sort>(sort, [['recent', 'Recent'], ['name', 'Name'], ['set', 'Set'], ['value', 'Value']], (v) => ((sort = v), render()), 'Sort'))),
    grid,
    h(
      'div',
      { class: 'exports' },
      h('button', { type: 'button', onclick: () => void exportCsv() }, 'Export CSV'),
      h('button', { type: 'button', onclick: () => void exportJson() }, 'Back up (JSON)'),
      h('button', { type: 'button', onclick: () => importInput.click() }, 'Restore'),
      importInput,
    ),
  );
  return { el, onShow: () => void reload() };
}

function stat(value: string, label: string): HTMLElement {
  return h('div', { class: 'stat' }, h('b', null, value), h('span', null, label));
}
