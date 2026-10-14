import { ALL_VARIANTS, GAMES } from '../games';
import { addCard, deleteEntry, entryValue, imageUrl, unitPrice, updateEntry } from '../db/store';
import { guessFinish, type Recognition } from '../scan/recognize';
import { shareScanReport } from '../scan/scanLog';
import { learnFinish } from '../scan/vision';
import { CONDITION_LABELS, CONDITIONS, type CardPrinting, type CollectionEntry, type Condition, type GameId, type ScanHints } from '../types';
import { settings } from '../util/settings';
import { clear, h, LANGUAGES, money, select, stepper } from './dom';
import { openSheet, toast } from './overlay';

export const GAME_LABEL: Record<GameId, string> = { pokemon: 'Pokémon', yugioh: 'Yu-Gi-Oh!', mtg: 'Magic', lorcana: 'Lorcana' };

export function cardImg(card: CardPrinting, large = false): HTMLImageElement {
  const img = h('img', { class: 'card-img', alt: card.name, loading: 'lazy', decoding: 'async' });
  if (large && card.imageLarge) img.src = card.imageLarge;
  else void imageUrl(card).then((u) => u && (img.src = u));
  // Failed loads show the plain placeholder, not the browser's broken-image icon and alt text.
  img.onerror = () => {
    img.classList.add('missing');
    img.removeAttribute('src');
  };
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

// ---------------------------------------------------------------------------------------------
// Finish (Normal / Holofoil / Reverse Holofoil / 1st Edition…)

/** One-tap buttons for the finishes this printing exists in. */
function finishChips(options: string[], current: string, onpick: (v: string) => void): HTMLElement {
  const wrap = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Finish' });
  const render = (sel: string): void =>
    clear(
      wrap,
      options.map((v) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(v === sel),
            class: v === sel ? 'chip on' : 'chip',
            onclick: () => {
              render(v);
              onpick(v);
            },
          },
          v,
        ),
      ),
    );
  render(current);
  return wrap;
}

/** Teach the reverse-holo detector from a finish the user chose or confirmed. */
function learn(card: CardPrinting, variant: string, shimmer: number | undefined): void {
  if (shimmer !== undefined && card.variants.includes('Reverse Holofoil') && card.variants.length > 1) learnFinish(shimmer, variant === 'Reverse Holofoil');
}

// ---------------------------------------------------------------------------------------------

export interface AddOptions {
  hints?: ScanHints;
  /** Reverse-holo shimmer measured on the scan, if this came from one. */
  shimmer?: number;
  onAdded?: (e: CollectionEntry) => void;
}

export async function openAddSheet(partialCard: CardPrinting, opts: AddOptions = {}): Promise<void> {
  const card = partialCard.partial || !partialCard.prices ? await GAMES[partialCard.game].complete(partialCard).catch(() => partialCard) : partialCard;
  const s = settings();
  const hints = opts.hints ?? {};
  let variant = guessFinish(card, hints, opts.shimmer).variant;
  let condition: Condition = s.defaultCondition;
  let language = hints.language && LANGUAGES.includes(hints.language) ? hints.language : s.defaultLanguage;
  let quantity = 1;

  const others = ALL_VARIANTS[card.game].filter((v) => !card.variants.includes(v));
  const priceEl = h('div', { class: 'big-price' });
  const updatePrice = (): void => {
    const p = unitPrice(card, variant);
    clear(priceEl, p !== undefined ? [money(p), h('small', null, ` each · ${variant}`)] : h('small', null, `No price for ${variant}`));
  };
  updatePrice();
  const pick = (v: string): void => {
    variant = v;
    updatePrice();
  };

  const sheet = openSheet(
    'Add to collection',
    h(
      'div',
      { class: 'add-sheet' },
      h('div', { class: 'add-hero' }, cardImg(card, true), h('div', null, h('h3', null, card.name), cardMeta(card), priceEl, priceNote(card), details(card))),
      h('div', { class: 'field-label' }, 'Finish'),
      finishChips(card.variants, variant, pick),
      others.length > 0 && h('details', { class: 'more-finishes' }, h('summary', null, 'Other finish…'), finishChips(others, '', pick)),
      h(
        'div',
        { class: 'form-grid' },
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
            learn(card, variant, opts.shimmer);
            const { entry, undo } = await addCard(card, { variant, condition, language, quantity });
            sheet.close();
            addedToast(entry, undo);
            opts.onAdded?.(entry);
          },
        },
        'Add to collection',
      ),
    ),
  );
}

/** "View on TCGplayer ↗", named after where the link actually goes. */
function linkLabel(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL: generic label.
  }
  const site = [['tcgplayer', 'TCGplayer'], ['scryfall', 'Scryfall'], ['ygoprodeck', 'YGOPRODeck'], ['tcgdex', 'TCGdex'], ['lorcast', 'Lorcast'], ['pokemontcg', 'pokemontcg.io']].find(([k]) => host.includes(k!));
  return site ? `View on ${site[1]} ↗` : 'View online ↗';
}

export function priceNote(card: CardPrinting): HTMLElement | false {
  if (!card.priceSource) return false;
  const when = card.pricesUpdatedAt ? new Date(card.pricesUpdatedAt) : undefined;
  return h('div', { class: 'muted small' }, card.priceSource, when && !Number.isNaN(when.getTime()) ? ` · ${when.toLocaleDateString()}` : '');
}

/**
 * "Added" toast with Undo and, when the printing exists in more than one finish, one-tap finish
 * buttons, so a wrong foil guess is fixed without leaving the camera.
 */
export function addedToast(
  entry: CollectionEntry,
  undo: () => Promise<void>,
  opts: { confidence?: number; shimmer?: number; onChange?: (prevId: string, next: CollectionEntry) => void } = {},
): void {
  let current = entry;
  const label = h('span', null, h('b', null, entry.card.name), ` ${entry.card.number} · now ×${entry.quantity}`);
  const options = entry.card.variants;
  const ask = options.length > 1;
  const unsure = ask && (opts.confidence ?? 1) < 0.7;
  const chips =
    ask &&
    finishChips(options, entry.variant, (v) => {
      learn(current.card, v, opts.shimmer);
      if (v === current.variant) return;
      const prevId = current.id;
      // Move the one copy just scanned, not the whole row.
      void (async () => {
        if (current.quantity > 1) await updateEntry(current, { quantity: current.quantity - 1 });
        else await deleteEntry(current.id);
        const { entry: moved } = await addCard(current.card, { variant: v, condition: current.condition, language: current.language });
        current = moved;
        opts.onChange?.(prevId, moved);
      })();
    });
  toast(h('div', null, label, unsure && h('div', { class: 'small warn' }, 'Which finish is it?'), chips), {
    action: 'Undo',
    onAction: () =>
      void (async () => {
        if (current.id === entry.id) await undo();
        else if (current.quantity > 1) await updateEntry(current, { quantity: current.quantity - 1 });
        else await deleteEntry(current.id);
        toast('Removed');
      })(),
    tone: unsure ? 'warn' : 'ok',
    ms: ask ? 9000 : 5000,
  });
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
              void openAddSheet(c.card, { hints, shimmer: rec.shimmer, onAdded });
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
      hints.raw &&
        h(
          'details',
          { class: 'raw' },
          h('summary', null, 'What the scanner saw'),
          h('pre', null, Object.entries(hints.raw).map(([k, v]) => `[${k}]\n${v}\n`).join('\n')),
          h('button', { type: 'button', class: 'wide', onclick: () => void shareScanReport() }, 'Share scan report'),
          h('p', { class: 'muted small' }, 'Your last scans with their photos, to send to whoever maintains the app so misreads can be fixed.'),
        ),
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
          priceNote(card),
          details(card),
          card.url && h('a', { href: card.url, target: '_blank', rel: 'noopener', class: 'ext' }, linkLabel(card.url)),
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
