export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

/** Tiny hyperscript: h('button', { class: 'x', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function money(v: number | undefined): string {
  return v === undefined ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function select<T extends string>(value: T, options: Array<T | [T, string]>, onchange: (v: T) => void, label?: string): HTMLSelectElement {
  return h(
    'select',
    { 'aria-label': label, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value as T) },
    options.map((o) => {
      const [v, text] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: v === value }, text);
    }),
  );
}

export function stepper(value: number, onchange: (v: number) => void, min = 0): HTMLElement {
  const out = h('output', null, String(value));
  const set = (v: number): void => {
    value = Math.max(min, v);
    out.textContent = String(value);
    onchange(value);
  };
  return h(
    'div',
    { class: 'stepper' },
    h('button', { type: 'button', 'aria-label': 'Fewer', onclick: () => set(value - 1) }, '−'),
    out,
    h('button', { type: 'button', 'aria-label': 'More', onclick: () => set(value + 1) }, '+'),
  );
}

export const LANGUAGES = ['EN', 'JP', 'DE', 'FR', 'IT', 'ES', 'PT', 'KR', 'ZH'];
