// charts.js — dependency-free animated SVG chart primitives.
// Each builder returns a `draw(values)` (or `set(v)`) closure so a component can
// drive animation frame-by-frame with interpolated data (see components.js).

import { s } from './dom.js';
import { clamp } from './protocol.js';

const W = 100; // internal coordinate width; svg stretches to its container

function points(values, h, padY = 6) {
  const n = values.length;
  if (n === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = (max - min) || 1;
  const stepX = n > 1 ? W / (n - 1) : 0;
  return values.map((v, i) => {
    const x = n > 1 ? i * stepX : W / 2;
    const y = padY + (1 - (v - min) / span) * (h - 2 * padY);
    return [x, y];
  });
}

function linePath(pts) {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
}

function areaPath(pts, h) {
  if (!pts.length) return '';
  const last = pts[pts.length - 1][0].toFixed(2);
  const first = pts[0][0].toFixed(2);
  return `${linePath(pts)} L ${last} ${h} L ${first} ${h} Z`;
}

/**
 * A line / area / bar chart. Returns { svg, draw(values) }.
 * The container CSS supplies the accent color via `color` on .m-accent-*.
 */
export function seriesChart({ variant = 'area', height = 120, accent = 'violet' } = {}) {
  const H = height;
  const svg = s('svg', {
    viewBox: `0 0 ${W} ${H}`, class: `m-chart m-accent-${accent}`,
    preserveAspectRatio: 'none', width: '100%', height: H, role: 'img',
  });
  // Gradient fill that fades the accent color (uses currentColor via stop-color).
  const gradId = `g-${Math.abs(hashStr(accent + height + variant))}`;
  const grad = s('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 },
    s('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': '0.35' }),
    s('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': '0' }));
  const defs = s('defs', {}, grad);
  const areaEl = s('path', { class: 'm-chart-area', fill: `url(#${gradId})`, stroke: 'none' });
  const barsG = s('g', { class: 'm-chart-bars' });
  const lineEl = s('path', { class: 'm-chart-line', fill: 'none', stroke: 'currentColor', 'vector-effect': 'non-scaling-stroke' });
  svg.append(defs, areaEl, barsG, lineEl);

  function draw(values) {
    const vals = (values || []).map(Number).filter(Number.isFinite);
    if (variant === 'bar') {
      areaEl.removeAttribute('d');
      lineEl.removeAttribute('d');
      const n = vals.length || 1;
      const max = Math.max(...vals, 0) || 1;
      const bw = (W / n) * 0.62;
      const gap = (W / n);
      barsG.replaceChildren(...vals.map((v, i) => {
        // Clamp to a non-negative height and derive y from the clamped height, so
        // negative/zero values sit on the baseline instead of overshooting it.
        const bh = Math.max(0, (v / max) * (H - 8));
        return s('rect', {
          x: (i * gap + (gap - bw) / 2).toFixed(2), y: (H - bh).toFixed(2),
          width: bw.toFixed(2), height: bh.toFixed(2),
          rx: 1.5, fill: 'currentColor',
        });
      }));
      return;
    }
    barsG.replaceChildren();
    const pts = points(vals, H);
    lineEl.setAttribute('d', linePath(pts));
    areaEl.setAttribute('d', variant === 'area' ? areaPath(pts, H) : '');
  }

  return { svg, draw };
}

/** A small inline sparkline (no axes). Returns an <svg>. */
export function sparkline(values, { height = 28, accent = 'violet' } = {}) {
  const { svg, draw } = seriesChart({ variant: 'line', height, accent });
  svg.setAttribute('class', `m-spark m-accent-${accent}`);
  draw(values);
  return svg;
}

/**
 * A donut progress ring. Returns { svg, set(value0to1) }.
 */
export function ring({ size = 132, stroke = 12, accent = 'violet' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: `m-ring m-accent-${accent}`, width: size, height: size });
  const bg = s('circle', { cx: mid, cy: mid, r, class: 'm-ring-bg', 'stroke-width': stroke, fill: 'none' });
  const fg = s('circle', {
    cx: mid, cy: mid, r, class: 'm-ring-fg', 'stroke-width': stroke, fill: 'none',
    'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': c.toFixed(2),
    'stroke-linecap': 'round', transform: `rotate(-90 ${mid} ${mid})`,
  });
  svg.append(bg, fg);
  function set(v) { fg.setAttribute('stroke-dashoffset', (c * (1 - clamp(Number(v) || 0, 0, 1))).toFixed(2)); }
  return { svg, set };
}

/** A segmented donut/pie from an array of values (shades of the accent). */
export function donut(values, { size = 120, stroke = 18, accent = 'violet' } = {}) {
  const vals = (values || []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: `m-donut m-accent-${accent}`, width: size, height: size });
  svg.append(s('circle', { cx: mid, cy: mid, r, fill: 'none', 'stroke-width': stroke, class: 'm-ring-bg' }));
  let offset = 0;
  vals.forEach((v, i) => {
    const len = (v / total) * c;
    svg.append(s('circle', {
      cx: mid, cy: mid, r, fill: 'none', stroke: 'currentColor', 'stroke-width': stroke,
      'stroke-dasharray': `${len.toFixed(2)} ${(c - len).toFixed(2)}`,
      'stroke-dashoffset': (-offset).toFixed(2),
      transform: `rotate(-90 ${mid} ${mid})`,
      opacity: Math.max(0.25, 1 - i * 0.18).toFixed(2),
    }));
    offset += len;
  });
  return svg;
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}
