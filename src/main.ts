import './style.css';
import { addView } from './ui/addView';
import { collectionView } from './ui/collectionView';
import { h } from './ui/dom';
import { closeAllSheets } from './ui/overlay';
import { scanView } from './ui/scanView';
import { settingsView } from './ui/settingsView';
import type { View } from './ui/view';

type Tab = 'scan' | 'collection' | 'add' | 'settings';

const app = document.getElementById('app')!;
const countEl = h('span', { class: 'count' });

const add = addView();
const views: Record<Tab, View> = {
  scan: scanView({
    search: (q, game) => {
      show('add');
      add.search(q, game);
    },
  }),
  collection: collectionView((n) => (countEl.textContent = n ? `${n.toLocaleString()} ${n === 1 ? 'card' : 'cards'}` : '')),
  add,
  settings: settingsView(),
};

const TABS: Array<[Tab, string, string]> = [
  ['scan', 'Scan', 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M9 7h6v10H9z'],
  ['collection', 'Collection', 'M4 6h7v7H4zM13 6h7v7h-7zM4 15h7v4H4zM13 15h7v4h-7z'],
  ['add', 'Add', 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'],
  ['settings', 'Settings', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4'],
];

const nav = h(
  'nav',
  { class: 'tabs' },
  TABS.map(([id, label, d]) =>
    h(
      'button',
      { type: 'button', 'data-tab': id, onclick: () => show(id) },
      h('span', {
        class: 'tab-icon',
        'aria-hidden': 'true',
        innerHTML: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`,
      }),
      h('span', null, label),
    ),
  ),
);

const main = h('main', null, Object.values(views).map((v) => v.el));
app.append(h('header', { class: 'top' }, h('h1', null, 'Card Vault'), countEl), main, nav, h('div', { id: 'toasts' }));

let current: Tab | null = null;
function show(tab: Tab): void {
  if (tab === current) return;
  closeAllSheets();
  if (current) views[current].onHide?.();
  current = tab;
  for (const [id, v] of Object.entries(views)) v.el.hidden = id !== tab;
  for (const b of nav.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.tab === tab);
  window.scrollTo(0, 0);
  void views[tab].onShow?.();
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
}

// Release the camera when the app is backgrounded; pick it back up on return.
document.addEventListener('visibilitychange', () => {
  if (current !== 'scan') return;
  if (document.hidden) views.scan.onHide?.();
  else void views.scan.onShow?.();
});

const initial = location.hash.slice(1) as Tab;
show(initial in views ? initial : 'scan');

