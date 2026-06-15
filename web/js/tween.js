// tween.js — requestAnimationFrame number/value tweening.
// Used for count-ups (metrics) and chart morphs — the motions that the View
// Transitions API does NOT handle well (cross-fading digits looks terrible, so
// we interpolate the underlying numbers instead).

import { formatValue } from './protocol.js';

let _reducedOverride = null; // tests can force this
export function setReducedMotion(v) { _reducedOverride = v; }

export function prefersReducedMotion() {
  if (_reducedOverride != null) return _reducedOverride;
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Drive `onFrame(progress 0..1, easedValue)` over `duration` ms.
 * Honors reduced motion (jumps straight to 1). Returns a cancel function.
 */
export function animate(duration, onFrame, { ease = easeOutCubic, onDone } = {}) {
  if (prefersReducedMotion() || duration <= 0 || typeof requestAnimationFrame !== 'function') {
    onFrame(1, ease(1));
    onDone && onDone();
    return () => {};
  }
  const start = now();
  let raf = 0;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    const t = Math.min(1, (now() - start) / duration);
    onFrame(t, ease(t));
    if (t < 1) raf = requestAnimationFrame(tick);
    else onDone && onDone();
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(raf); };
}

/** Count `el.textContent` from `from` to `to`, formatted per `format`. */
export function tweenNumber(el, from, to, { duration = 750, format = null, ease = easeOutCubic } = {}) {
  return animate(duration, (_t, e) => {
    const v = from + (to - from) * e;
    el.textContent = formatValue(v, format);
  }, { ease });
}

/** Linear interpolation between two equal-length numeric arrays. */
export function lerpArray(a, b, e) {
  const n = Math.max(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const av = a[i] != null ? a[i] : (a.length ? a[a.length - 1] : 0);
    const bv = b[i] != null ? b[i] : (b.length ? b[b.length - 1] : 0);
    out[i] = av + (bv - av) * e;
  }
  return out;
}
