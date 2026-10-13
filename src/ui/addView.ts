import { GAME_LIST, GAMES } from '../games';
import type { GameId } from '../types';
import { settings, updateSettings } from '../util/settings';
import { cardRow, openAddSheet } from './cards';
import { clear, h } from './dom';
import type { View } from './view';

export interface AddView extends View {
  search(q: string, game: GameId): void;
}

const PLACEHOLDER: Record<GameId, string> = {
  pokemon: 'Name or number: “Charizard”, “4/102”, “pikachu 25/198”',
  yugioh: 'Name, set code or passcode: “Dark Magician”, “LOB-EN005”',
  mtg: 'Name, or set + number: “Lightning Bolt”, “M21 123”',
  lorcana: 'Name or number: “Elsa Spirit of Winter”, “207/204”',
};

export function addView(): AddView {
  let game: GameId = settings().game;
  const results = h('div', { class: 'card-list' });
  const input = h('input', { type: 'search', enterkeyhint: 'search', autocomplete: 'off' });
  const gameSwitch = h('div', { class: 'segmented scroll' });
  let seq = 0;

  const renderSwitch = (): void => {
    input.placeholder = PLACEHOLDER[game];
    clear(
      gameSwitch,
      GAME_LIST.map((g) =>
        h(
          'button',
          {
            type: 'button',
            class: game === g.id ? 'on' : '',
            onclick: () => {
              game = g.id;
              updateSettings({ game });
              renderSwitch();
              if (input.value.trim()) void run();
            },
          },
          g.name,
        ),
      ),
    );
  };

  async function run(): Promise<void> {
    const q = input.value.trim();
    if (!q) return;
    const mine = ++seq;
    clear(results, h('p', { class: 'muted' }, 'Searching…'));
    try {
      const cards = await GAMES[game].search(q);
      if (mine !== seq) return;
      clear(results, cards.length ? cards.slice(0, 80).map((c) => cardRow(c, () => openAddSheet(c))) : h('p', { class: 'muted' }, `No ${GAMES[game].name} cards found for “${q}”.`));
    } catch (e) {
      if (mine !== seq) return;
      clear(results, h('p', { class: 'warn' }, `Search failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  renderSwitch();
  const form = h(
    'form',
    {
      class: 'search-form',
      onsubmit: (e: Event) => {
        e.preventDefault();
        input.blur();
        void run();
      },
    },
    input,
    h('button', { type: 'submit', class: 'primary' }, 'Search'),
  );

  return {
    el: h('section', { class: 'view add-view' }, gameSwitch, form, results),
    onShow() {
      if (game !== settings().game) {
        game = settings().game;
        renderSwitch();
      }
    },
    search(q, g) {
      game = g;
      renderSwitch();
      input.value = q;
      if (q) void run();
      else input.focus();
    },
  };
}
