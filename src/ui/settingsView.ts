import { clearCollection } from '../db/store';
import { CONDITION_LABELS, CONDITIONS, type Condition } from '../types';
import { settings, updateSettings, type Settings } from '../util/settings';
import { h, LANGUAGES, select } from './dom';
import { toast } from './overlay';
import type { View } from './view';

function toggle(key: 'autoAdd' | 'useAi', label: string, hint: string): HTMLElement {
  return h(
    'label',
    { class: 'switch-row' },
    h('div', null, h('div', null, label), h('small', { class: 'muted' }, hint)),
    h('input', { type: 'checkbox', role: 'switch', checked: settings()[key], onchange: (e: Event) => updateSettings({ [key]: (e.target as HTMLInputElement).checked }) }),
  );
}

function secret(key: 'anthropicApiKey' | 'pokemonTcgApiKey', label: string, hint: Node | string, placeholder: string): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    label,
    h('input', {
      type: 'password',
      autocomplete: 'off',
      spellcheck: false,
      placeholder,
      value: settings()[key],
      onchange: (e: Event) => updateSettings({ [key]: (e.target as HTMLInputElement).value.trim() } as Partial<Settings>),
    }),
    h('small', { class: 'muted' }, hint),
  );
}

export function settingsView(): View {
  const el = h(
    'section',
    { class: 'view settings-view' },
    h('h2', null, 'Scanning'),
    toggle('autoAdd', 'Add automatically', 'When a scan matches exactly one card, add it without asking. You can always undo.'),
    h(
      'div',
      { class: 'form-grid' },
      h('label', null, 'Default condition', select(settings().defaultCondition, CONDITIONS.map((c) => [c, `${c} · ${CONDITION_LABELS[c]}`] as [Condition, string]), (v) => updateSettings({ defaultCondition: v }))),
      h('label', null, 'Default language', select(settings().defaultLanguage, LANGUAGES, (v) => updateSettings({ defaultLanguage: v }))),
    ),

    h('h2', null, 'AI scan (optional)'),
    h(
      'p',
      { class: 'muted' },
      'On-device text recognition is free and private but struggles with glare, holo foil and angled shots. AI scan sends the photo to Claude instead, which reads cards far more reliably and detects the game for you. Costs about a cent per scan on your own Anthropic API key.',
    ),
    toggle('useAi', 'Use AI scan', 'Needs an API key below.'),
    secret(
      'anthropicApiKey',
      'Anthropic API key',
      h('span', null, 'Stored only in this browser and sent only to api.anthropic.com. Get one at ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), '.'),
      'sk-ant-…',
    ),

    h('h2', null, 'Card data'),
    secret(
      'pokemonTcgApiKey',
      'Pokémon TCG API key (optional)',
      h('span', null, 'Raises pokemontcg.io’s rate limit. Free at ', h('a', { href: 'https://dev.pokemontcg.io', target: '_blank', rel: 'noopener' }, 'dev.pokemontcg.io'), '.'),
      'Not needed for normal use',
    ),
    h(
      'p',
      { class: 'muted small' },
      'Pokémon data and prices: pokemontcg.io (TCGplayer market prices), with TCGdex as a fallback. Yu-Gi-Oh! data and prices: YGOPRODeck. Magic: Scryfall. Lorcana: Lorcast. Your collection is stored on this device only. Use Back up on the Collection tab to keep a copy.',
    ),

    h('h2', null, 'Danger zone'),
    h(
      'button',
      {
        type: 'button',
        class: 'danger',
        onclick: async () => {
          if (!confirm('Delete every card in your collection from this device? Export a backup first if you might want it back.')) return;
          await clearCollection();
          toast('Collection cleared');
        },
      },
      'Delete entire collection',
    ),
  );
  return { el };
}
