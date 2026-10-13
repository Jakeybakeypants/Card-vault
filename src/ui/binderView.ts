import { listEntries, onCollectionChange } from '../db/store';
import { filledAt, ownedSlots, slotsFor, type SetSlot } from '../db/progress';
import { GAME_LIST, GAMES } from '../games';
import type { CardSet, CollectionEntry, GameId } from '../types';
import { settings, updateSettings } from '../util/settings';
import { cardImg, openAddSheet, openEntrySheet } from './cards';
import { clear, h } from './dom';
import { openSheet } from './overlay';
import type { View } from './view';

/**
 * The binder: every set in the catalog, and for each set a page of slots, one per card.
 * Cards you own are in full colour; the rest are faded so you can see what's left. Slots filled
 * since you last looked at a set flip into colour.
 */

type Filter = 'all' | 'have' | 'need';

const SEEN_KEY = 'card-vault:binder-seen';
const PAGE = 40;

function loadSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function markSeen(key: string): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...loadSeen(), [key]: new Date().toISOString() }));
  } catch {
    // Storage blocked: slots just animate again next time.
  }
}
const setKey = (s: CardSet): string => `${s.game}|${s.id}`;

export function binderView(): View {
  let game: GameId = settings().game;
  let entries: CollectionEntry[] = [];
  let sets: CardSet[] | null = null;
  let setsError = '';
  let query = '';
  let shown = PAGE;
  let visible = false;

  // Open set
  let current: CardSet | null = null;
  let slots: SetSlot[] | null = null;
  let slotsError = '';
  let filter: Filter = 'all';
  let seq = 0;

  const listEl = h('div', { class: 'binder-list' });
  const setEl = h('div', { class: 'binder-set' });
  const gameSwitch = h('div', { class: 'segmented scroll' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Find a set…',
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value.toLowerCase();
      shown = PAGE;
      renderList();
    },
  });
  const listPane = h('div', null, gameSwitch, search, listEl);

  // -------------------------------------------------------------------------------------------
  // Set list

  function renderSwitch(): void {
    clear(
      gameSwitch,
      GAME_LIST.map((g) =>
        h(
          'button',
          {
            type: 'button',
            class: game === g.id ? 'on' : '',
            onclick: () => {
              if (game === g.id) return;
              game = g.id;
              updateSettings({ game });
              renderSwitch();
              void loadSets();
            },
          },
          g.name,
        ),
      ),
    );
  }

  async function loadSets(): Promise<void> {
    const mine = ++seq;
    sets = null;
    setsError = '';
    shown = PAGE;
    renderList();
    try {
      const list = await GAMES[game].sets();
      if (mine !== seq) return;
      sets = list;
    } catch (e) {
      if (mine !== seq) return;
      setsError = e instanceof Error ? e.message : String(e);
    }
    renderList();
  }

  function renderList(): void {
    if (setsError) {
      clear(listEl, h('p', { class: 'warn' }, `Couldn’t load the set list: ${setsError}`), h('button', { type: 'button', onclick: () => void loadSets() }, 'Try again'));
      return;
    }
    if (!sets) {
      clear(listEl, h('p', { class: 'muted' }, 'Loading sets…'));
      return;
    }
    const owned = new Map(sets.map((s) => [s, ownedSlots(s, entries).size]));
    const match = (s: CardSet): boolean => !query || `${s.name} ${s.code} ${s.series ?? ''} ${s.releaseDate?.slice(0, 4) ?? ''}`.toLowerCase().includes(query);
    const started = sets.filter((s) => owned.get(s)! > 0 && match(s)).sort((a, b) => owned.get(b)! / b.total - owned.get(a)! / a.total);
    const all = sets.filter(match);
    clear(
      listEl,
      started.length > 0 && [h('h2', null, 'In progress'), h('div', { class: 'set-rows' }, started.map((s) => setRow(s, owned.get(s)!)))],
      h('h2', null, query ? `${all.length} ${all.length === 1 ? 'set' : 'sets'}` : 'All sets'),
      all.length ? h('div', { class: 'set-rows' }, all.slice(0, shown).map((s) => setRow(s, owned.get(s)!))) : h('p', { class: 'muted' }, 'No sets match.'),
      all.length > shown &&
        h(
          'button',
          {
            type: 'button',
            class: 'wide',
            onclick: () => {
              shown += PAGE * 2;
              renderList();
            },
          },
          `Show more (${all.length - shown} left)`,
        ),
    );
  }

  function setRow(s: CardSet, have: number): HTMLElement {
    const pct = s.total ? Math.min(100, (have / s.total) * 100) : 0;
    const done = s.total > 0 && have >= s.total;
    return h(
      'button',
      { type: 'button', class: `set-row game-${s.game}${done ? ' done' : ''}`, onclick: () => void openSet(s) },
      h('div', { class: 'set-logo' }, s.logo && h('img', { src: s.logo, alt: '', loading: 'lazy', decoding: 'async', onerror: (e: Event) => (e.target as HTMLElement).remove() })),
      h(
        'div',
        { class: 'set-text' },
        h('div', { class: 'set-name' }, s.name),
        h('div', { class: 'set-meta' }, [s.code, s.releaseDate?.slice(0, 4), s.series].filter(Boolean).join(' · ')),
        progressBar(pct, done),
      ),
      h('div', { class: 'set-count' }, h('b', null, have), s.total > 0 && h('span', null, `/${s.total}`)),
    );
  }

  // -------------------------------------------------------------------------------------------
  // One set

  async function openSet(s: CardSet): Promise<void> {
    const mine = ++seq;
    current = s;
    slots = null;
    slotsError = '';
    filter = 'all';
    showPane();
    window.scrollTo(0, 0);
    renderSet();
    try {
      const cards = await GAMES[s.game].setCards(s);
      if (mine !== seq) return;
      slots = slotsFor(cards);
    } catch (e) {
      if (mine !== seq) return;
      slotsError = e instanceof Error ? e.message : String(e);
    }
    renderSet();
  }

  function closeSet(): void {
    seq++;
    current = null;
    slots = null;
    showPane();
    renderList();
  }

  function showPane(): void {
    listPane.hidden = !!current;
    setEl.hidden = !current;
  }

  function renderSet(): void {
    const s = current;
    if (!s) return;
    const back = h('button', { type: 'button', class: 'back', onclick: closeSet }, '‹ All sets');
    const head = (have: number, total: number): HTMLElement => {
      const done = total > 0 && have >= total;
      const pct = total ? Math.min(100, (have / total) * 100) : 0;
      return h(
        'div',
        { class: `set-hero game-${s.game}${done ? ' done' : ''}` },
        s.logo && h('img', { class: 'set-hero-logo', src: s.logo, alt: '', onerror: (e: Event) => (e.target as HTMLElement).remove() }),
        h('h2', null, s.name),
        h('div', { class: 'set-meta' }, [s.code, s.releaseDate, s.series].filter(Boolean).join(' · ')),
        h('div', { class: 'set-hero-count' }, h('b', null, have), ` / ${total}`, h('span', null, done ? ' · Complete!' : ` · ${Math.floor(pct)}%`)),
        progressBar(pct, done),
      );
    };

    if (slotsError) {
      clear(setEl, back, head(ownedSlots(s, entries).size, s.total), h('p', { class: 'warn' }, `Couldn’t load this set: ${slotsError}`), h('button', { type: 'button', onclick: () => void openSet(s) }, 'Try again'));
      return;
    }
    if (!slots) {
      clear(setEl, back, head(ownedSlots(s, entries).size, s.total), h('div', { class: 'binder' }, Array.from({ length: Math.min(s.total, 18) }, () => h('div', { class: 'slot ghost' }))));
      return;
    }

    const owned = ownedSlots(s, entries);
    const ids = new Set(slots.map((x) => x.id));
    const have = [...owned.keys()].filter((id) => ids.has(id)).length;
    const lastSeen = loadSeen()[setKey(s)];
    let stagger = 0;
    const list = slots.filter((x) => filter === 'all' || (filter === 'have') === owned.has(x.id));

    clear(
      setEl,
      back,
      head(have, slots.length),
      h(
        'div',
        { class: 'segmented small' },
        (
          [
            ['all', 'All', slots.length],
            ['have', 'Have', have],
            ['need', 'Need', slots.length - have],
          ] as Array<[Filter, string, number]>
        ).map(([f, label, n]) =>
          h(
            'button',
            {
              type: 'button',
              class: filter === f ? 'on' : '',
              onclick: () => {
                filter = f;
                renderSet();
              },
            },
            `${label} ${n}`,
          ),
        ),
      ),
      list.length
        ? h(
            'div',
            { class: 'binder' },
            list.map((slot) => {
              const mineEntries = owned.get(slot.id);
              const fresh = !!mineEntries && (!lastSeen || filledAt(mineEntries) > lastSeen);
              return slotEl(slot, mineEntries, fresh ? Math.min(stagger++ * 70, 1400) : undefined);
            }),
          )
        : h('p', { class: 'muted empty' }, filter === 'have' ? 'None yet. Tap a faded card to add it.' : 'Nothing left to collect here. 🎉'),
    );
    if (visible) markSeen(setKey(s));
  }

  function slotEl(slot: SetSlot, owned: CollectionEntry[] | undefined, freshDelay: number | undefined): HTMLElement {
    const qty = owned?.reduce((n, e) => n + e.quantity, 0) ?? 0;
    return h(
      'button',
      {
        type: 'button',
        class: `slot ${owned ? 'owned' : 'missing'}${freshDelay !== undefined ? ' fresh' : ''}`,
        style: freshDelay !== undefined ? `--d:${freshDelay}ms` : undefined,
        title: `${slot.card.name} · ${slot.card.number}`,
        onclick: () => (owned ? openOwned(slot, owned) : openAddSheet(slot.card)),
      },
      cardImg(owned?.[0]?.card ?? slot.card),
      h('span', { class: 'slot-num' }, slot.card.game === 'yugioh' ? slot.id.split('-').pop() : slot.id),
      qty > 1 && h('span', { class: 'qty' }, `×${qty}`),
    );
  }

  function openOwned(slot: SetSlot, owned: CollectionEntry[]): void {
    if (owned.length === 1) return openEntrySheet(owned[0]!);
    const sheet = openSheet(
      slot.card.name,
      h(
        'div',
        { class: 'card-list' },
        owned.map((e) =>
          h(
            'button',
            {
              type: 'button',
              class: 'card-row',
              onclick: () => {
                sheet.close();
                openEntrySheet(e);
              },
            },
            cardImg(e.card),
            h('div', { class: 'card-row-text' }, h('div', { class: 'name' }, e.variant), h('div', { class: 'meta' }, [e.card.rarity, e.condition, e.language].filter(Boolean).join(' · '))),
            h('span', { class: 'badge' }, `×${e.quantity}`),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'wide',
            onclick: () => {
              sheet.close();
              openAddSheet(slot.card);
            },
          },
          'Add another copy',
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------------------------

  async function reload(): Promise<void> {
    entries = await listEntries();
    if (current) renderSet();
    else renderList();
  }
  onCollectionChange(() => void reload());

  renderSwitch();
  showPane();
  void loadSets();

  return {
    el: h('section', { class: 'view binder-view' }, listPane, setEl),
    async onShow() {
      visible = true;
      if (game !== settings().game) {
        game = settings().game;
        renderSwitch();
        if (current?.game !== game) closeSet();
        void loadSets();
      }
      await reload();
    },
    onHide() {
      visible = false;
    },
  };
}

function progressBar(pct: number, done: boolean): HTMLElement {
  return h('div', { class: `bar${done ? ' done' : ''}` }, h('i', { style: `width:${pct.toFixed(1)}%` }));
}
