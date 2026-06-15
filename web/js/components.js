// components.js — the trusted component catalog.
// Each renderer maps a MorphSpec node to DOM. Containers expose a child slot via
// a `data-slot` element; the renderer fills it with child shells. Agent-supplied
// strings are ALWAYS inserted as text nodes (never innerHTML) — this is the
// safety property a data-only catalog buys over code generation.

import { h, s, icon } from './dom.js';
import { tweenNumber, animate, easeOutCubic } from './tween.js';
import { seriesChart, sparkline, ring, donut } from './charts.js';
import { formatValue, clamp } from './protocol.js';

const REG = Object.create(null);
export function register(type, fn) { REG[type] = fn; }
export function hasComponent(type) { return type in REG; }

/** Render a node's content into a (fresh) element; renderer handles the shell. */
export function renderComponent(node, ctx, shell) {
  const fn = REG[node.type] || REG.__unknown;
  return fn(node, ctx, shell);
}

const accent = (node) => (node.props && node.props.accent ? ` m-accent-${node.props.accent}` : '');
const slot = (el) => { el.setAttribute('data-slot', ''); return el; };

// --- containers -----------------------------------------------------------

register('surface', (n) => slot(h('div', { class: 'm-surface-inner' })));

register('grid', (n) => {
  const p = n.props || {};
  return slot(h('div', { class: `m-grid cols-${clamp(p.cols || 2, 1, 4)} gap-${p.gap || 'md'}` }));
});

register('row', (n) => slot(h('div', { class: `m-row ${n.props?.wrap ? 'wrap' : ''}`, style: gapStyle(n) })));
register('stack', (n) => slot(h('div', { class: 'm-stack', style: gapStyle(n) })));
register('board', () => slot(h('div', { class: 'm-board' })));
register('timeline', () => slot(h('div', { class: 'm-timeline' })));
register('list', (n) => slot(h('div', { class: `m-list ${n.props?.dense ? 'dense' : ''}` })));

register('section', (n) => {
  const p = n.props || {};
  return h('section', { class: 'm-section' },
    (p.title || p.icon) && h('header', { class: 'm-section-head' },
      p.icon && h('span', { class: 'm-section-icon' }, icon(p.icon)),
      h('div', {},
        p.title && h('div', { class: 'm-section-title' }, p.title),
        p.subtitle && h('div', { class: 'm-section-sub' }, p.subtitle))),
    slot(h('div', { class: 'm-section-body' })));
});

register('column', (n, ctx) => {
  const p = n.props || {};
  return h('div', { class: `m-column${accent(n)}` },
    h('header', { class: 'm-col-head' },
      h('span', { class: 'm-col-title' }, p.title || ''),
      p.count != null && h('span', { class: 'm-col-count' }, ctx.resolve(p.count))),
    slot(h('div', { class: 'm-col-body' })));
});

register('card', (n, ctx) => {
  const p = n.props || {};
  const head = (p.title || p.icon || p.subtitle) && h('header', { class: 'm-card-head' },
    p.icon && h('span', { class: 'm-card-icon' }, icon(p.icon)),
    h('div', { class: 'm-card-heads' },
      p.title && h('div', { class: 'm-card-title' }, p.title),
      p.subtitle && h('div', { class: 'm-card-sub' }, p.subtitle)));
  return h('div', { class: `m-card${accent(n)}${p.elevated ? ' elevated' : ''}` },
    head,
    slot(h('div', { class: 'm-card-body' })),
    p.footer && h('div', { class: 'm-card-foot' }, p.footer));
});

// --- display --------------------------------------------------------------

register('heading', (n) => {
  const p = n.props || {};
  const lvl = clamp(p.level || 1, 1, 3);
  return h('div', { class: 'm-heading' },
    p.kicker && h('div', { class: 'm-kicker' }, p.kicker),
    h('h' + lvl, { class: `m-h lvl-${lvl}` }, p.text || ''));
});

register('text', (n) => {
  const p = n.props || {};
  return h('p', { class: `m-text ${p.muted ? 'muted' : ''} ${p.size ? 'size-' + p.size : ''}` }, p.text || '');
});

register('note', (n) => {
  const p = n.props || {};
  return h('div', { class: `m-note m-tone-${p.tone || 'info'}` },
    p.icon && h('span', { class: 'm-note-icon' }, icon(p.icon)),
    h('span', {}, p.text || ''));
});

register('badge', (n) => {
  const p = n.props || {};
  return h('span', { class: `m-badge m-tone-${p.tone || 'neutral'}` }, p.text || '');
});

register('listitem', (n) => {
  const p = n.props || {};
  return h('div', { class: `m-listitem m-tone-${p.tone || 'neutral'}` },
    p.icon && h('span', { class: 'm-li-icon' }, icon(p.icon)),
    h('div', { class: 'm-li-text' },
      h('div', { class: 'm-li-title' }, p.title || ''),
      p.subtitle && h('div', { class: 'm-li-sub' }, p.subtitle)),
    p.trailing != null && h('div', { class: 'm-li-trail' }, String(p.trailing)));
});

register('event', (n) => {
  const p = n.props || {};
  return h('div', { class: `m-event m-tone-${p.tone || 'neutral'}` },
    h('span', { class: 'm-event-dot' }),
    h('div', { class: 'm-event-body' },
      h('div', { class: 'm-event-title' }, p.title || ''),
      p.time && h('div', { class: 'm-event-time' }, p.time)));
});

register('kv', (n) => {
  const pairs = (n.props && n.props.pairs) || [];
  return h('div', { class: 'm-kv' },
    ...pairs.map((kv) => h('div', { class: 'm-kv-row' },
      h('span', { class: 'm-kv-k' }, kv.k ?? ''),
      h('span', { class: 'm-kv-v' }, kv.v ?? ''))));
});

register('divider', (n) => {
  const label = n.props && n.props.label;
  return h('div', { class: `m-divider ${label ? 'labeled' : ''}` }, label && h('span', {}, label));
});

register('spacer', (n) => h('div', { class: 'm-spacer', style: { height: (n.props?.size || 16) + 'px' } }));

register('spinner', (n) => {
  const p = n.props || {};
  return h('div', { class: 'm-spinner' },
    h('div', { class: 'm-spinner-ring' }),
    p.label && h('div', { class: 'm-spinner-label' }, p.label));
});

register('markdown', (n) => renderMarkdown((n.props && n.props.text) || ''));

// --- numeric / animated ---------------------------------------------------

register('metric', (n, ctx, shell) => {
  const p = n.props || {};
  const valEl = h('div', { class: 'm-metric-value m-num' });
  const tw = ctx.tweenFor(n.id, 'value');
  if (tw) {
    valEl.textContent = formatValue(tw.from, tw.format);
    ctx.afterTransition(() => tweenNumber(valEl, tw.from, tw.to, { format: tw.format, duration: 850 }));
  } else {
    valEl.textContent = ctx.resolve(p.value);
  }
  const delta = p.delta != null && h('span', { class: `m-delta dir-${p.deltaDir || 'up'}` },
    icon(p.deltaDir === 'down' ? 'trending-up' : 'trending-up'), String(p.delta));
  const rawSpark = p.spark != null ? ctx.raw(p.spark) : null;
  const sparkVals = Array.isArray(rawSpark) ? rawSpark : null; // tolerate non-array agent values
  return h('div', { class: `m-metric${accent(n)}` },
    h('div', { class: 'm-metric-top' },
      h('span', { class: 'm-metric-label' }, p.label || ''),
      delta),
    valEl,
    sparkVals && sparkVals.length ? sparkline(sparkVals.map(Number), { accent: p.accent || 'violet' }) : null);
});

register('stat-group', () => slot(h('div', { class: 'm-stats' })));

register('progress', (n, ctx) => {
  const p = n.props || {};
  const fill = h('div', { class: 'm-progress-fill' });
  const pct = h('span', { class: 'm-num' });
  const tw = ctx.tweenFor(n.id, 'value');
  const to = tw ? tw.to : Number(ctx.raw(p.value)) || 0;
  const from = tw ? tw.from : to;
  const apply = (v) => { fill.style.width = (clamp(v, 0, 1) * 100).toFixed(1) + '%'; pct.textContent = formatValue(v, 'percent'); };
  apply(from);
  if (tw) ctx.afterTransition(() => animate(850, (_t, e) => apply(from + (to - from) * e)));
  return h('div', { class: `m-progress${accent(n)}` },
    h('div', { class: 'm-progress-head' },
      h('span', { class: 'm-progress-label' }, p.label || ''), pct),
    h('div', { class: 'm-progress-track' }, fill));
});

register('kpi-ring', (n, ctx) => {
  const p = n.props || {};
  const r = ring({ accent: p.accent || 'violet' });
  const center = h('div', { class: 'm-num m-ring-center' });
  const tw = ctx.tweenFor(n.id, 'value');
  const to = tw ? tw.to : Number(ctx.raw(p.value)) || 0;
  const from = tw ? tw.from : to;
  const apply = (v) => { r.set(v); center.textContent = formatValue(v, 'percent'); };
  apply(from);
  if (tw) ctx.afterTransition(() => animate(900, (_t, e) => apply(from + (to - from) * e)));
  return h('div', { class: `m-kpiring${accent(n)}` },
    h('div', { class: 'm-ring-wrap' }, r.svg, center),
    p.label && h('div', { class: 'm-ring-label' }, p.label));
});

register('chart', (n, ctx, shell) => {
  const p = n.props || {};
  // series OR data may be a binding or a literal; resolve both and guard to an
  // array so a scalar/object value can never throw on .map().
  let raw = ctx.raw(p.series);
  if (raw == null) raw = ctx.raw(p.data);
  const cur = (Array.isArray(raw) ? raw : []).map(Number).filter(Number.isFinite);
  if ((p.variant || 'area') === 'donut') {
    if (shell) shell.__chartSeries = cur.slice();
    return h('div', { class: 'm-chart-wrap m-donut-wrap' }, donut(cur, { accent: p.accent || 'violet', size: p.height || 132 }));
  }
  const { svg, draw } = seriesChart({ variant: p.variant || 'area', height: p.height || 120, accent: p.accent || 'violet' });
  const prevStored = shell && shell.__chartSeries;
  const prev = Array.isArray(prevStored) && prevStored.length ? prevStored : cur.map(() => 0);
  draw(prev);
  ctx.afterTransition(() => animate(700, (_t, e) => draw(lerpSeries(prev, cur, e)), { ease: easeOutCubic }));
  if (shell) shell.__chartSeries = cur.slice();
  return h('div', { class: 'm-chart-wrap' }, svg);
});

// --- interactive ----------------------------------------------------------

register('button', (n, ctx) => {
  const p = n.props || {};
  return h('button', {
    class: `m-btn m-tone-${p.tone || 'violet'}`,
    onclick: () => ctx.emit(p.action || 'click', p.value, n.id),
  }, p.icon && icon(p.icon), h('span', {}, p.text || 'Button'));
});

// --- fallback -------------------------------------------------------------

register('__unknown', (n) => h('div', { class: 'm-unknown' }, `⟨${n.type}⟩`));

// --- helpers --------------------------------------------------------------

function gapStyle(n) {
  const g = { sm: '6px', md: '12px', lg: '20px' }[n.props?.gap] || (n.props?.gap ? n.props.gap + 'px' : null);
  return g ? { gap: g } : null;
}

function lerpSeries(a, b, e) {
  // Grow/shrink toward b's length while interpolating overlapping values, so a
  // chart that gains a point animates the new point in from the prior baseline.
  const n = b.length;
  const out = new Array(n);
  const baseline = a.length ? a[a.length - 1] : 0;
  for (let i = 0; i < n; i++) {
    const av = i < a.length ? a[i] : baseline;
    out[i] = av + (b[i] - av) * e;
  }
  return out;
}

function renderMarkdown(text) {
  const root = h('div', { class: 'm-markdown' });
  let list = null;
  for (const line of String(text).split(/\n/)) {
    if (/^\s*[-*]\s+/.test(line)) {
      if (!list) { list = h('ul', { class: 'm-md-ul' }); root.appendChild(list); }
      list.appendChild(h('li', {}, ...mdInline(line.replace(/^\s*[-*]\s+/, ''))));
    } else {
      list = null;
      if (line.trim() === '') continue;
      root.appendChild(h('p', {}, ...mdInline(line)));
    }
  }
  return root;
}

function mdInline(text) {
  const nodes = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let m, last = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    if (m[2] != null) nodes.push(h('strong', {}, m[2]));
    else if (m[3] != null) nodes.push(h('em', {}, m[3]));
    else if (m[4] != null) nodes.push(h('code', {}, m[4]));
    else if (m[5] != null) nodes.push(h('a', { href: safeUrl(m[6]), target: '_blank', rel: 'noopener noreferrer' }, m[5]));
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function safeUrl(u) {
  u = String(u).trim();
  return /^(https?:\/\/|\/|#|mailto:)/i.test(u) ? u : '#';
}
