import { ALL_VARIANTS } from '../games';
import { addCard, deleteEntry, entryValue, imageUrl, unitPrice, updateEntry } from '../db/store';
import type { Recognition } from '../scan/recognize';
import { CONDITION_LABELS, CONDITIONS, type CardPrinting, type CollectionEntry, type Condition, type ScanHints } from '../types';
import { settings } from '../util/settings';
import { clear, h, LANGUAGES, money, select, stepper } from './dom';
import { openSheet, toast } from './overlay';

export const GAME_LABEL = { pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!' } as const;

export function cardImg(card: CardPrinting, large = false): HTMLImageElement {
  const img = h('img', { class: 'card-img', alt: card.name, loading: 'lazy', decoding: 'async' });
  if (large && card.imageLarge) img.src = card.imageLarge;
  else void imageUrl(card).then((u) => u && (img.src = u));
  img.onerror = () => img.classList.add('missing');
  return img;
}

function cardMeta(card: CardPrinting): HTMLElement {
  return h('div', { class: 'meta' }, h('span', null, card.setName), ' · ', h('span', { class: 'mono' }, card.number), card.rarity && [' · ', card.rarity]);
}

/** A tappable row for candidate / search results. */
export function cardRow(card: CardPrinting, onpick: () => void, badge?: string): HTMLElement {
  const price = unitPrice(card, card.variants[0] ?? '');
  return h(
    'button',
    { type: 'button', class: 'card-row', onclick: onpick },
    cardImg(card),
    h('div', { class: 'card-row-text' }, h('div', { class: 'name' }, card.name), cardMeta(card), h('div', { class: 'price' }, price !== undefined ? money(price) : '')),
    badge && h('span', { class: 'badge' }, badge),
  );
}

/** Best variant for a scanned card: what the scan saw if the printing has it, else the most likely. */
export function pickVariant(card: CardPrinting, hint?: string): string {
  if (hint) {
    const hit = card.variants.find((v) => v.toLowerCase().startsWith(hint.toLowerCase()));
    if (hit) return hit;
  }
  return card.variants[0] ?? ALL_VARIANTS[card.game][0]!;
}

// ---------------------------------------------------------------------------------------------

export function openAddSheet(card: CardPrinting, hints?: ScanHints, onAdded?: (e: CollectionEntry) => void): void {
  const s = settings();
  let variant = pickVariant(card, hints?.variant);
  let condition: Condition = s.defaultCondition;
  let language = hints?.language && LANGUAGES.includes(hints.language) ? hints.language : s.defaultLanguage;
  let quantity = 1;

  const variants = [...new Set([...card.variants, ...ALL_VARIANTS[card.game]])];
  const priceEl = h('div', { class: 'big-price' });
  const updatePrice = (): void => {
    const p = unitPrice(card, variant);
    clear(priceEl, p !== undefined ? [money(p), h('small', null, ` each · ${variant}`)] : h('small', null, 'No price data'));
  };
  updatePrice();

  const sheet = openSheet(
    'Add to collection',
    h(
      'div',
      { class: 'add-sheet' },
      h('div', { class: 'add-hero' }, cardImg(card, true), h('div', null, h('h3', null, card.name), cardMeta(card), priceEl, details(card))),
      h(
        'div',
        { class: 'form-grid' },
        h('label', null, 'Variant', select(variant, variants, (v) => ((variant = v), updatePrice()))),
        h('label', null, 'Condition', select(condition, CONDITIONS.map((c) => [c, `${c} · ${CONDITION_LABELS[c]}`] as [Condition, string]), (v) => (condition = v))),
        h('label', null, 'Language', select(language, LANGUAGES, (v) => (language = v))),
        h('label', null, 'Quantity', stepper(quantity, (v) => (quantity = v), 1)),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'primary wide',
          onclick: async () => {
            const { entry, undo } = await addCard(card, { variant, condition, language, quantity });
            sheet.close();
            addedToast(entry, undo);
            onAdded?.(entry);
          },
        },
        'Add to collection',
      ),
    ),
  );
}

export function addedToast(entry: CollectionEntry, undo: () => Promise<void>): void {
  toast(
    h('span', null, h('b', null, entry.card.name), ` ${entry.card.number} · ${entry.variant} · now ×${entry.quantity}`),
    { action: 'Undo', onAction: () => void undo().then(() => toast('Removed')), tone: 'ok' },
  );
}

function details(card: CardPrinting): HTMLElement {
  return h(
    'dl',
    { class: 'details' },
    Object.entries(card.details).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
  );
}

// ---------------------------------------------------------------------------------------------

export function openCandidatesSheet(rec: Recognition, onAdded?: (e: CollectionEntry) => void, onSearch?: (q: string) => void): void {
  const { hints, candidates } = rec;
  const read = [hints.name, hints.number && `${hints.number}${hints.total ? `/${hints.total}` : ''}`, hints.setCode, hints.passcode].filter(Boolean).join(' · ');
  const sets = new Set(candidates.map((c) => c.card.setName));
  const filter = h('input', { type: 'search', placeholder: `Filter ${candidates.length} matches by set or rarity…`, class: 'filter' });
  const list = h('div', { class: 'card-list' });
  const render = (): void => {
    const q = filter.value.toLowerCase();
    clear(
      list,
      candidates
        .filter((c) => !q || `${c.card.setName} ${c.card.rarity ?? ''} ${c.card.number}`.toLowerCase().includes(q))
        .slice(0, 60)
        .map((c) =>
          cardRow(
            c.card,
            () => {
              sheet.close();
              openAddSheet(c.card, hints, onAdded);
            },
            `${Math.round(c.score * 100)}%`,
          ),
        ),
    );
  };
  filter.oninput = render;
  const sheet = openSheet(
    candidates.length ? 'Which one is it?' : 'No match found',
    h(
      'div',
      null,
      h('p', { class: 'muted' }, read ? ['Read: ', h('span', { class: 'mono' }, read)] : 'Couldn’t read any text off that card. Try again with less glare, or search by name.'),
      sets.size > 4 && filter,
      list,
      h(
        'button',
        {
          type: 'button',
          class: 'wide',
          onclick: () => {
            sheet.close();
            onSearch?.(hints.name ?? hints.setCode ?? '');
          },
        },
        'Search manually instead',
      ),
      hints.raw && h('details', { class: 'raw' }, h('summary', null, 'What the scanner saw'), h('pre', null, Object.entries(hints.raw).map(([k, v]) => `[${k}]\n${v}\n`).join('\n'))),
    ),
  );
  render();
}

// ---------------------------------------------------------------------------------------------

export function openEntrySheet(entry: CollectionEntry): void {
  let current = entry;
  const card = entry.card;
  const variants = [...new Set([...card.variants, ...ALL_VARIANTS[card.game], entry.variant])];
  const valueEl = h('div', { class: 'big-price' });
  const renderValue = (): void => {
    const v = entryValue(current);
    clear(valueEl, money(v), v !== undefined && h('small', null, ` total · ${money(unitPrice(card, current.variant))} each`));
  };
  const save = async (patch: Parameters<typeof updateEntry>[1]): Promise<void> => {
    current = await updateEntry(current, patch);
    renderValue();
  };
  renderValue();

  const sheet = openSheet(
    card.name,
    h(
      'div',
      { class: 'add-sheet' },
      h(
        'div',
        { class: 'add-hero' },
        cardImg(card, true),
        h(
          'div',
          null,
          h('div', { class: 'eyebrow' }, GAME_LABEL[card.game]),
          cardMeta(card),
          valueEl,
          details(card),
          card.url && h('a', { href: card.url, target: '_blank', rel: 'noopener', class: 'ext' }, card.source === 'ygoprodeck' ? 'View on YGOPRODeck ↗' : 'View on TCGplayer ↗'),
        ),
      ),
      h(
        'div',
        { class: 'form-grid' },
        h('label', null, 'Quantity', stepper(entry.quantity, (v) => void save({ quantity: v }), 1)),
        h('label', null, 'Variant', select(entry.variant, variants, (v) => void save({ variant: v }))),
        h('label', null, 'Condition', select(entry.condition, CONDITIONS.map((c) => [c, `${c} · ${CONDITION_LABELS[c]}`] as [Condition, string]), (v) => void save({ condition: v }))),
        h('label', null, 'Language', select(entry.language, [...new Set([...LANGUAGES, entry.language])], (v) => void save({ language: v }))),
      ),
      h(
        'label',
        { class: 'notes' },
        'Notes',
        h('textarea', { rows: 2, placeholder: 'Graded, signed, in binder 3…', onchange: (e: Event) => void save({ notes: (e.target as HTMLTextAreaElement).value || undefined }) }, entry.notes ?? ''),
      ),
      h('p', { class: 'muted small' }, `Added ${new Date(entry.addedAt).toLocaleDateString()} · data from ${card.source}`),
      h(
        'button',
        {
          type: 'button',
          class: 'danger wide',
          onclick: async () => {
            if (!confirm(`Remove ${card.name} (${current.quantity}×) from your collection?`)) return;
            await deleteEntry(current.id);
            sheet.close();
            toast(`Removed ${card.name}`);
          },
        },
        'Remove from collection',
      ),
    ),
  );
}
