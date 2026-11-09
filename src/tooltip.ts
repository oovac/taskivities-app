// A small tooltip in the app's own style, for text that's cut short (long task titles). The browser's own `title`
// tooltip waits about a second, looks different in every browser and ignores the theme, so this replaces it.
// One element for the whole app, shown and placed by hand: hovering rows never re-renders anything.
import type { MouseEvent } from 'react';

/** How long the pointer rests on something before its tooltip shows. */
const DELAY = 300;
/** Moving to the next one within this long after a tooltip hides shows it at once (no second wait). */
const WARM = 400;

let tip: HTMLDivElement | null = null;
let timer = 0;
let shownFor: HTMLElement | null = null;
let hiddenAt = 0;

const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

function el(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('aria-hidden', 'true'); // the text is already in the row's own label
  document.body.appendChild(tip);
  // Anything that changes what's under the pointer puts it away.
  for (const ev of ['scroll', 'mousedown', 'keydown', 'dragstart', 'blur'] as const) addEventListener(ev, hideTip, true);
  return tip;
}

function show(target: HTMLElement, text: string) {
  if (!target.isConnected) return;
  const t = el();
  t.textContent = text;
  t.classList.add('on');
  // Below the text, lined up with it; above it if there's no room below. Kept inside the window.
  const r = target.getBoundingClientRect();
  const w = t.offsetWidth, h = t.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = r.top - h - 6;
  t.style.left = `${Math.max(8, Math.min(r.left - 8, innerWidth - w - 8))}px`;
  t.style.top = `${Math.max(8, top)}px`;
  shownFor = target;
}

export function hideTip() {
  clearTimeout(timer);
  if (shownFor) hiddenAt = Date.now();
  shownFor = null;
  tip?.classList.remove('on');
}

/**
 * Hover handlers that show `text` in a tooltip, but only while the element's content is cut short (an ellipsis, or a
 * line clamp). Spread them onto the element: `<span {...truncatedTip(title)}>`.
 */
export const truncatedTip = (text: string) => ({
  onMouseEnter: (e: MouseEvent<HTMLElement>) => {
    const target = e.currentTarget;
    clearTimeout(timer);
    if (!canHover() || (target.scrollWidth <= target.clientWidth + 1 && target.scrollHeight <= target.clientHeight + 1)) return;
    if (Date.now() - hiddenAt < WARM) show(target, text);
    else timer = window.setTimeout(() => show(target, text), DELAY);
  },
  onMouseLeave: hideTip,
});
