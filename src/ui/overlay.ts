import { h, type Child } from './dom';

// ---------------------------------------------------------------------------------------------
// Toasts

const toastRoot = (): HTMLElement => document.getElementById('toasts')!;

export function toast(message: Child, opts: { action?: string; onAction?: () => void; ms?: number; tone?: 'ok' | 'warn' } = {}): void {
  const el = h(
    'div',
    { class: `toast ${opts.tone ?? ''}`, role: 'status' },
    h('div', { class: 'toast-msg' }, message),
    opts.action &&
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            opts.onAction?.();
            dismiss();
          },
        },
        opts.action,
      ),
  );
  const dismiss = (): void => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  };
  toastRoot().append(el);
  // Keep at most three on screen.
  while (toastRoot().children.length > 3) toastRoot().firstElementChild!.remove();
  setTimeout(dismiss, opts.ms ?? 5000);
}

// ---------------------------------------------------------------------------------------------
// Bottom sheets

export interface Sheet {
  el: HTMLElement;
  body: HTMLElement;
  close: () => void;
}

let openSheets: Sheet[] = [];

export function openSheet(title: Child, content: Child, onClose?: () => void): Sheet {
  const body = h('div', { class: 'sheet-body' }, content);
  const panel = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    h('header', { class: 'sheet-head' }, h('h2', null, title), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    body,
  );
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e: Event) => e.target === backdrop && close() }, panel);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && openSheets.at(-1) === sheet) close();
  };
  const close = (): void => {
    if (!backdrop.isConnected) return;
    document.removeEventListener('keydown', onKey);
    backdrop.classList.add('out');
    setTimeout(() => backdrop.remove(), 200);
    openSheets = openSheets.filter((s) => s !== sheet);
    onClose?.();
  };
  const sheet: Sheet = { el: panel, body, close };
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  openSheets.push(sheet);
  return sheet;
}

export function closeAllSheets(): void {
  for (const s of [...openSheets]) s.close();
}

export function sheetOpen(): boolean {
  return openSheets.length > 0;
}
