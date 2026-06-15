// protocol.js — MorphSpec shared contract
// ---------------------------------------------------------------------------
// The single source of truth for the wire format and binding semantics.
// Imported by the browser runtime (app/renderer/components/stager) AND by the
// Node test suite, so it must be dependency-free, isomorphic ES module code.
//
// MorphSpec models a *Surface* (a dashboard) as a flat adjacency list of
// stable-ID components plus a separated JSON data model that components bind
// into. An agent communicates by streaming small messages that mutate the
// surface; element identity is preserved across mutations, which is the
// precondition that lets the renderer animate every change for free.
// ---------------------------------------------------------------------------

/** Wire message types (one JSON object per SSE `data:` line). */
export const MSG = Object.freeze({
  CREATE_SURFACE: 'createSurface',     // full (re)instantiation of the surface
  UPDATE_COMPONENTS: 'updateComponents', // upsert/remove structural nodes
  UPDATE_DATA: 'updateDataModel',      // path-patch the data model (drives binds)
  SET_SURFACE_PROPS: 'setSurfaceProps', // title / accent / theme (decoupled brand)
  NARRATE: 'narrate',                  // a single line of agent "voice" (ticker)
  ACTION: 'action',                    // client -> server: user interaction
  PING: 'ping',                        // keep-alive, ignored by the renderer
});

/** All component types in the "Basic" catalog. */
export const TYPES = Object.freeze([
  // containers / layout
  'surface', 'grid', 'row', 'stack', 'section', 'board', 'column',
  // display
  'card', 'text', 'markdown', 'heading', 'metric', 'stat-group', 'progress',
  'badge', 'list', 'listitem', 'timeline', 'event', 'chart', 'kpi-ring',
  'divider', 'spacer', 'spinner', 'note', 'kv',
  // interactive
  'button',
]);

// ---------------------------------------------------------------------------
// JSON Pointer (RFC 6901) — used by data bindings and updateDataModel patches.
// ---------------------------------------------------------------------------

/** Decode a single JSON Pointer reference token. */
function unescapeToken(t) {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Split a JSON Pointer into reference tokens. "" -> [], "/a/b" -> ["a","b"]. */
export function pointerTokens(pointer) {
  if (pointer === '' || pointer == null) return [];
  if (pointer[0] !== '/') pointer = '/' + pointer; // be lenient with authors
  return pointer.split('/').slice(1).map(unescapeToken);
}

/** Read the value at `pointer` within `doc`, or `undefined` if absent. */
export function getPointer(doc, pointer) {
  let cur = doc;
  for (const tok of pointerTokens(pointer)) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(tok)] : cur[tok];
  }
  return cur;
}

/**
 * Immutably set the value at `pointer` within `doc`, returning a new doc.
 * Intermediate objects/arrays are created as needed. A value of `undefined`
 * deletes the leaf. Arrays are detected by numeric tokens.
 */
export function setPointer(doc, pointer, value) {
  const tokens = pointerTokens(pointer);
  if (tokens.length === 0) return value;
  // Deleting a path whose parent doesn't exist is a no-op — don't materialize
  // empty intermediate containers just to remove a leaf that was never there.
  if (value === undefined) {
    let cur = doc;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (cur == null || typeof cur !== 'object') return doc;
      cur = Array.isArray(cur) ? cur[Number(tokens[i])] : cur[tokens[i]];
    }
    if (cur == null || typeof cur !== 'object') return doc;
  }
  const root = cloneShallow(doc, tokens[0]);
  let cur = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    const nextTok = tokens[i + 1];
    const existing = cur[tok];
    cur[tok] = cloneShallow(existing, nextTok);
    cur = cur[tok];
  }
  const leaf = tokens[tokens.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur)) cur.splice(Number(leaf), 1);
    else delete cur[leaf];
  } else {
    cur[leaf] = value;
  }
  return root;
}

// Shallow-clone a container, choosing array vs object based on the *next* token.
function cloneShallow(value, nextToken) {
  const wantArray = nextToken !== undefined && /^\d+$/.test(nextToken);
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') return { ...value };
  return wantArray ? [] : {};
}

/** Apply a flat {pointer: value} patch immutably. undefined values delete. */
export function applyDataPatch(data, patch) {
  let next = data ?? {};
  for (const [pointer, value] of Object.entries(patch || {})) {
    next = setPointer(next, pointer, value);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Bindings — how component props reference the data model.
//
//   literal:   "Hello"  | 42 | true
//   bind:      { "$bind": "/metrics/sources", "format": "int", "tween": true }
//   template:  { "$tpl": "Found {/metrics/sources} of {/metrics/total}" }
//
// `tween: true` is a hint that numeric changes to this value should be
// animated by a JS count-up rather than swapped instantly.
// ---------------------------------------------------------------------------

export function isBind(v) {
  return v != null && typeof v === 'object' && typeof v.$bind === 'string';
}
export function isTpl(v) {
  return v != null && typeof v === 'object' && typeof v.$tpl === 'string';
}
export function isBinding(v) {
  return isBind(v) || isTpl(v);
}

/** Does resolving this prop depend on `data`? (used by the stager) */
export function bindingPaths(v) {
  if (isBind(v)) return [v.$bind];
  if (isTpl(v)) return [...v.$tpl.matchAll(/\{(\/[^}]*)\}/g)].map((m) => m[1]);
  return [];
}

/** Format a raw value for display per a format hint. */
export function formatValue(value, format) {
  if (value == null) return '';
  switch (format) {
    case 'int':
      return Math.round(Number(value)).toLocaleString();
    case 'number':
      return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
    case 'percent':
      return `${Math.round(Number(value) * 100)}%`;
    case 'percent1':
      return `${(Number(value) * 100).toFixed(1)}%`;
    case 'usd':
      return Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    case 'compact':
      return Number(value).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    case 'duration': {
      const s = Math.round(Number(value));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      return `${m}m ${s % 60}s`;
    }
    default:
      return String(value);
  }
}

/**
 * Resolve a (possibly bound) prop value against the data model.
 * Returns the *display* value (formatted for $bind/$tpl). For numeric tween
 * decisions, callers also use rawBound() below to get the unformatted number.
 */
export function resolve(v, data) {
  if (isBind(v)) {
    const raw = getPointer(data, v.$bind);
    return formatValue(raw, v.format);
  }
  if (isTpl(v)) {
    return v.$tpl.replace(/\{(\/[^}]*)\}/g, (_, ptr) => {
      const raw = getPointer(data, ptr);
      return raw == null ? '' : String(raw);
    });
  }
  return v;
}

/** Raw (unformatted) value of a single $bind, else undefined. */
export function rawBound(v, data) {
  if (isBind(v)) return getPointer(data, v.$bind);
  return undefined;
}

/** Is this prop a numeric, tween-enabled binding? */
export function isTweenBind(v, data) {
  if (!isBind(v) || v.tween !== true) return false;
  const raw = getPointer(data, v.$bind);
  return typeof raw === 'number' && Number.isFinite(raw);
}

// ---------------------------------------------------------------------------
// Surface helpers
// ---------------------------------------------------------------------------

/** A fresh, empty surface. */
export function emptySurface() {
  return { root: 'root', components: {}, data: {}, props: {} };
}

/** Deep-ish clone of a surface (structuredClone where available). */
export function cloneSurface(s) {
  if (typeof structuredClone === 'function') return structuredClone(s);
  return JSON.parse(JSON.stringify(s));
}

/**
 * Apply one wire message to a surface, returning a NEW surface (immutably).
 * Unknown / control messages (narrate, ping, action) return the surface
 * unchanged — those are handled out-of-band by the app, not by the model.
 */
export function applyMessage(surface, msg) {
  switch (msg.type) {
    case MSG.CREATE_SURFACE: {
      const s = msg.surface || {};
      return {
        root: s.root || 'root',
        components: { ...(s.components || {}) },
        data: s.data ? cloneSurface(s.data) : {},
        props: { ...(s.props || {}) },
      };
    }
    case MSG.UPDATE_COMPONENTS: {
      const components = { ...surface.components };
      for (const id of msg.remove || []) delete components[id];
      for (const [id, node] of Object.entries(msg.components || {})) {
        components[id] = { ...node, id };
      }
      return { ...surface, components };
    }
    case MSG.UPDATE_DATA:
      return { ...surface, data: applyDataPatch(surface.data, msg.patch || {}) };
    case MSG.SET_SURFACE_PROPS:
      return { ...surface, props: { ...surface.props, ...(msg.props || {}) } };
    default:
      return surface; // narrate / ping / action: no surface change
  }
}

/** Escape text for safe insertion as HTML text content. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
