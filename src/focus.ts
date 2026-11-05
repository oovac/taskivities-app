// Keyboard focus that survives re-renders: one Tab stop for the task list (roving tabindex),
// focus put back where it belongs after menus and panels close, and a neighbour picked
// when the focused task leaves the view.

let pending: string | null = null;
let lastNav: { el: HTMLElement; key: string; idx: number } | null = null;

export const navEls = () => [...document.querySelectorAll<HTMLElement>('#root [data-nav]')];

/** Focus this selector after the next render. */
export const focusLater = (sel: string | null) => {
  pending = sel;
};

export function focusNav(el: HTMLElement | null | undefined) {
  if (!el) return;
  navEls().forEach((n) => (n.tabIndex = n === el ? 0 : -1));
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function onFocusIn(e: FocusEvent) {
  const n = (e.target as HTMLElement | null)?.closest?.('[data-nav]') as HTMLElement | null;
  if (!n) return;
  const all = navEls();
  lastNav = { el: n, key: n.dataset.nav!, idx: all.indexOf(n) };
  all.forEach((x) => (x.tabIndex = x === n ? 0 : -1));
}

export const curNav = (): HTMLElement | null => {
  const a = (document.activeElement as HTMLElement | null)?.closest?.('[data-nav]') as HTMLElement | null;
  if (a) return a;
  return lastNav && lastNav.el.isConnected ? lastNav.el : null;
};

const placeCaretAtEnd = (el: HTMLElement) => {
  if (!el.isContentEditable) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
};

/** Called after every render. */
export function afterRender() {
  const navs = navEls();
  const neighbour = () =>
    lastNav ? navs.find((n) => n.dataset.nav === lastNav!.key) || navs[Math.min(Math.max(lastNav.idx, 0), navs.length - 1)] : undefined;
  if (pending) {
    const sel = pending;
    pending = null;
    let el = document.querySelector<HTMLElement>(sel);
    if (!el && sel.startsWith('[data-nav')) el = neighbour() ?? null;
    if (el) {
      el.focus({ preventScroll: true });
      if (el.matches('[data-nav]')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      placeCaretAtEnd(el);
    }
  } else if (lastNav && !lastNav.el.isConnected && (!document.activeElement || document.activeElement === document.body)) {
    // The focused task moved (e.g. to another day) or left the view: follow it, or take its neighbour.
    const el = neighbour();
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  if (navs.length && !navs.some((n) => n.tabIndex === 0)) navs[0].tabIndex = 0;
}

/** A selector that finds this control again after a re-render. */
export function selFor(el: HTMLElement | null): string | null {
  if (!el) return null;
  const act = el.dataset.act;
  if (el.closest('.drawer')) return act ? `.drawer [data-act="${act}"]` : '.drawer';
  const nav = el.closest('[data-nav]') as HTMLElement | null;
  if (nav) return `[data-nav="${nav.dataset.nav}"]`;
  if (el.id) return `#${el.id}`;
  if (!act) return null;
  const extra = ['m', 'dir', 's', 'u', 'p', 'pg', 'k', 'd', 'c']
    .map((x) => (el.dataset[x] != null ? `[data-${x}="${el.dataset[x]}"]` : ''))
    .join('');
  return `[data-act="${act}"]${extra}`;
}

export function activeSelector(): string | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return null;
  return selFor(a);
}

export function trapTab(e: KeyboardEvent, box: Element | null) {
  if (!box) return;
  const f = [...box.querySelectorAll<HTMLElement>('button:not(:disabled),[contenteditable="true"],textarea,input,select')].filter(
    (x) => x.offsetParent !== null,
  );
  if (!f.length) return;
  e.preventDefault();
  const i = f.indexOf(document.activeElement as HTMLElement);
  f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
}
