// protocol.test.mjs — unit tests for the MorphSpec shared contract.
// Exercises the real web/js/protocol.js (imported by relative path) under the
// built-in node:test runner. Run: `node --test tests/` from the repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MSG,
  TYPES,
  pointerTokens,
  getPointer,
  setPointer,
  applyDataPatch,
  isBind,
  isTpl,
  isBinding,
  bindingPaths,
  formatValue,
  resolve,
  rawBound,
  isTweenBind,
  emptySurface,
  applyMessage,
} from '../web/js/protocol.js';

// ---------------------------------------------------------------------------
// JSON Pointer: tokens
// ---------------------------------------------------------------------------

test('pointerTokens: empty/null -> []', () => {
  assert.deepEqual(pointerTokens(''), []);
  assert.deepEqual(pointerTokens(null), []);
  assert.deepEqual(pointerTokens(undefined), []);
});

test('pointerTokens: simple split and leniency for missing leading slash', () => {
  assert.deepEqual(pointerTokens('/a/b'), ['a', 'b']);
  assert.deepEqual(pointerTokens('a/b'), ['a', 'b']); // lenient: prepends "/"
});

test('pointerTokens: RFC 6901 escapes (~1 -> "/", ~0 -> "~")', () => {
  assert.deepEqual(pointerTokens('/a~1b'), ['a/b']);
  assert.deepEqual(pointerTokens('/a~0b'), ['a~b']);
  // ~01 decodes to "~1" (unescape order: ~1 first then ~0 — verify literal)
  assert.deepEqual(pointerTokens('/m~0n~1o'), ['m~n/o']);
});

// ---------------------------------------------------------------------------
// JSON Pointer: get / set round-trips
// ---------------------------------------------------------------------------

test('getPointer: reads nested values, returns undefined for absent paths', () => {
  const doc = { a: { b: { c: 7 } }, list: [10, 20, 30] };
  assert.equal(getPointer(doc, '/a/b/c'), 7);
  assert.equal(getPointer(doc, '/list/1'), 20);
  assert.equal(getPointer(doc, ''), doc); // empty pointer -> whole doc
  assert.equal(getPointer(doc, '/a/x/y'), undefined);
  assert.equal(getPointer(doc, '/missing'), undefined);
});

test('getPointer: short-circuits on null intermediates', () => {
  const doc = { a: null };
  assert.equal(getPointer(doc, '/a/b/c'), undefined);
});

test('setPointer/getPointer: round-trip on existing leaf', () => {
  const doc = { a: { b: 1 } };
  const next = setPointer(doc, '/a/b', 42);
  assert.equal(getPointer(next, '/a/b'), 42);
});

test('setPointer: empty pointer returns the value itself (replaces root)', () => {
  assert.equal(setPointer({ a: 1 }, '', 'whole'), 'whole');
  assert.deepEqual(setPointer(undefined, '', { x: 1 }), { x: 1 });
});

test('setPointer: creates nested objects as needed', () => {
  const next = setPointer({}, '/a/b/c', 9);
  assert.deepEqual(next, { a: { b: { c: 9 } } });
});

test('setPointer: numeric tokens create/index arrays', () => {
  const next = setPointer({}, '/list/0', 'first');
  assert.ok(Array.isArray(next.list), 'numeric next-token -> array container');
  assert.deepEqual(next.list, ['first']);

  const doc = { list: [10, 20, 30] };
  const updated = setPointer(doc, '/list/1', 99);
  assert.deepEqual(updated.list, [10, 99, 30]);
});

test('setPointer: is immutable — original document is not mutated', () => {
  const doc = { a: { b: 1 }, keep: [1, 2] };
  const snapshot = JSON.parse(JSON.stringify(doc));
  const next = setPointer(doc, '/a/b', 2);
  assert.deepEqual(doc, snapshot, 'original untouched');
  assert.notEqual(next, doc, 'returns a new root');
  assert.notEqual(next.a, doc.a, 'mutated branch is cloned');
  assert.equal(next.keep, doc.keep, 'untouched branch is shared (shallow clone)');
});

test('setPointer: undefined deletes an object leaf', () => {
  const doc = { a: { b: 1, c: 2 } };
  const next = setPointer(doc, '/a/b', undefined);
  assert.deepEqual(next, { a: { c: 2 } });
  assert.equal(getPointer(next, '/a/b'), undefined);
  assert.deepEqual(doc, { a: { b: 1, c: 2 } }, 'original untouched');
});

test('setPointer: undefined splices an array leaf (not leaves a hole)', () => {
  const doc = { list: [10, 20, 30] };
  const next = setPointer(doc, '/list/1', undefined);
  assert.deepEqual(next.list, [10, 30]);
  assert.equal(next.list.length, 2);
});

// ---------------------------------------------------------------------------
// applyDataPatch
// ---------------------------------------------------------------------------

test('applyDataPatch: applies multiple pointers and is immutable', () => {
  const data = { metrics: { sources: 0, total: 0 }, status: 'idle' };
  const snapshot = JSON.parse(JSON.stringify(data));
  const next = applyDataPatch(data, {
    '/metrics/sources': 12,
    '/metrics/total': 50,
    '/status': 'reading',
  });
  assert.equal(getPointer(next, '/metrics/sources'), 12);
  assert.equal(getPointer(next, '/metrics/total'), 50);
  assert.equal(getPointer(next, '/status'), 'reading');
  assert.deepEqual(data, snapshot, 'original data model NOT mutated');
  assert.notEqual(next, data);
});

test('applyDataPatch: undefined value deletes; empty/absent patch is a no-op clone', () => {
  const data = { a: 1, b: 2 };
  const next = applyDataPatch(data, { '/b': undefined });
  assert.deepEqual(next, { a: 1 });

  const same = applyDataPatch(data, {});
  assert.deepEqual(same, data);

  const fromNull = applyDataPatch(undefined, { '/x': 1 });
  assert.deepEqual(fromNull, { x: 1 });
});

// ---------------------------------------------------------------------------
// Binding predicates
// ---------------------------------------------------------------------------

test('isBind/isTpl/isBinding: classify literals, binds, and templates', () => {
  assert.equal(isBind({ $bind: '/x' }), true);
  assert.equal(isBind({ $tpl: 'x' }), false);
  assert.equal(isBind('hello'), false);
  assert.equal(isBind(null), false);
  assert.equal(isBind({ $bind: 123 }), false, '$bind must be a string');

  assert.equal(isTpl({ $tpl: 'hi {/x}' }), true);
  assert.equal(isTpl({ $bind: '/x' }), false);
  assert.equal(isTpl({ $tpl: 5 }), false, '$tpl must be a string');

  assert.equal(isBinding({ $bind: '/x' }), true);
  assert.equal(isBinding({ $tpl: 'x' }), true);
  assert.equal(isBinding('plain'), false);
  assert.equal(isBinding(42), false);
});

// ---------------------------------------------------------------------------
// bindingPaths
// ---------------------------------------------------------------------------

test('bindingPaths: extracts the single path from a $bind', () => {
  assert.deepEqual(bindingPaths({ $bind: '/metrics/sources' }), ['/metrics/sources']);
});

test('bindingPaths: extracts every {/ptr} from a $tpl (multiple)', () => {
  assert.deepEqual(
    bindingPaths({ $tpl: 'Found {/metrics/sources} of {/metrics/total}' }),
    ['/metrics/sources', '/metrics/total'],
  );
});

test('bindingPaths: literals and empty templates yield []', () => {
  assert.deepEqual(bindingPaths('plain'), []);
  assert.deepEqual(bindingPaths(42), []);
  assert.deepEqual(bindingPaths({ $tpl: 'no pointers here' }), []);
});

// ---------------------------------------------------------------------------
// formatValue
// ---------------------------------------------------------------------------

test('formatValue: null/undefined -> empty string', () => {
  assert.equal(formatValue(null, 'int'), '');
  assert.equal(formatValue(undefined, 'usd'), '');
});

test('formatValue: int rounds and groups (locale-parity)', () => {
  assert.equal(formatValue(1234.6, 'int'), (1235).toLocaleString());
  assert.equal(formatValue(1234.4, 'int'), (1234).toLocaleString());
});

test('formatValue: number keeps up to 2 fraction digits', () => {
  assert.equal(
    formatValue(1234.567, 'number'),
    (1234.567).toLocaleString(undefined, { maximumFractionDigits: 2 }),
  );
});

test('formatValue: percent and percent1', () => {
  assert.equal(formatValue(0.1234, 'percent'), '12%');
  assert.equal(formatValue(0.5, 'percent'), '50%');
  assert.equal(formatValue(0.1234, 'percent1'), '12.3%');
  assert.equal(formatValue(1, 'percent1'), '100.0%');
});

test('formatValue: usd as USD currency (locale-parity)', () => {
  assert.equal(
    formatValue(1234.5, 'usd'),
    (1234.5).toLocaleString(undefined, { style: 'currency', currency: 'USD' }),
  );
});

test('formatValue: compact notation (locale-parity)', () => {
  assert.equal(
    formatValue(1234567, 'compact'),
    (1234567).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 }),
  );
});

test('formatValue: duration sub-minute and minute+seconds', () => {
  assert.equal(formatValue(45, 'duration'), '45s');
  assert.equal(formatValue(59.4, 'duration'), '59s');
  assert.equal(formatValue(135, 'duration'), '2m 15s');
  assert.equal(formatValue(60, 'duration'), '1m 0s');
});

test('formatValue: unknown/absent format -> String(value)', () => {
  assert.equal(formatValue('hello', undefined), 'hello');
  assert.equal(formatValue(7, 'nope'), '7');
  assert.equal(formatValue(true, undefined), 'true');
});

// ---------------------------------------------------------------------------
// resolve / rawBound
// ---------------------------------------------------------------------------

test('resolve: $bind reads the pointer and applies the format', () => {
  const data = { metrics: { sources: 1234.6 }, p: 0.5 };
  assert.equal(resolve({ $bind: '/metrics/sources', format: 'int' }, data), (1235).toLocaleString());
  assert.equal(resolve({ $bind: '/p', format: 'percent' }, data), '50%');
});

test('resolve: $tpl interpolates every {/ptr}; missing -> empty', () => {
  const data = { metrics: { sources: 12, total: 50 } };
  assert.equal(
    resolve({ $tpl: 'Found {/metrics/sources} of {/metrics/total}' }, data),
    'Found 12 of 50',
  );
  assert.equal(resolve({ $tpl: 'x={/missing}!' }, data), 'x=!');
});

test('resolve: literal values pass through untouched', () => {
  assert.equal(resolve('plain', {}), 'plain');
  assert.equal(resolve(42, {}), 42);
});

test('rawBound: returns unformatted value for a $bind, undefined otherwise', () => {
  const data = { metrics: { sources: 12 } };
  assert.equal(rawBound({ $bind: '/metrics/sources', format: 'int' }, data), 12);
  assert.equal(rawBound({ $tpl: 'x {/y}' }, data), undefined);
  assert.equal(rawBound('literal', data), undefined);
  assert.equal(rawBound({ $bind: '/missing' }, data), undefined);
});

// ---------------------------------------------------------------------------
// isTweenBind
// ---------------------------------------------------------------------------

test('isTweenBind: true only for numeric, finite, tween:true binds', () => {
  const data = { n: 42, big: 1e9, str: 'nope', nan: NaN, inf: Infinity };
  assert.equal(isTweenBind({ $bind: '/n', tween: true }, data), true);
  assert.equal(isTweenBind({ $bind: '/big', tween: true }, data), true);
});

test('isTweenBind: false when tween flag missing/falsey', () => {
  const data = { n: 42 };
  assert.equal(isTweenBind({ $bind: '/n' }, data), false);
  assert.equal(isTweenBind({ $bind: '/n', tween: false }, data), false);
  assert.equal(isTweenBind({ $bind: '/n', tween: 1 }, data), false, 'must be === true');
});

test('isTweenBind: false for non-numeric / non-finite / non-bind values', () => {
  const data = { str: 'nope', nan: NaN, inf: Infinity, n: 5 };
  assert.equal(isTweenBind({ $bind: '/str', tween: true }, data), false);
  assert.equal(isTweenBind({ $bind: '/nan', tween: true }, data), false);
  assert.equal(isTweenBind({ $bind: '/inf', tween: true }, data), false);
  assert.equal(isTweenBind({ $bind: '/missing', tween: true }, data), false);
  assert.equal(isTweenBind({ $tpl: '{/n}', tween: true }, data), false, '$tpl is never a tween bind');
  assert.equal(isTweenBind('literal', data), false);
});

// ---------------------------------------------------------------------------
// applyMessage
// ---------------------------------------------------------------------------

test('applyMessage: createSurface replaces the whole surface', () => {
  const prev = {
    root: 'old',
    components: { old: { id: 'old', type: 'surface' } },
    data: { a: 1 },
    props: { title: 'Old' },
  };
  const next = applyMessage(prev, {
    type: MSG.CREATE_SURFACE,
    surface: {
      root: 'root',
      components: { root: { id: 'root', type: 'surface', children: ['h'] }, h: { id: 'h', type: 'heading' } },
      data: { metrics: { sources: 0 } },
      props: { title: 'New', accent: 'violet' },
    },
  });
  assert.equal(next.root, 'root');
  assert.deepEqual(Object.keys(next.components).sort(), ['h', 'root']);
  assert.equal(getPointer(next.data, '/metrics/sources'), 0);
  assert.equal(next.props.title, 'New');
  assert.ok(!('old' in next.components), 'old components dropped');
});

test('applyMessage: createSurface fills defaults from a minimal payload', () => {
  const next = applyMessage(emptySurface(), { type: MSG.CREATE_SURFACE, surface: {} });
  assert.equal(next.root, 'root');
  assert.deepEqual(next.components, {});
  assert.deepEqual(next.data, {});
  assert.deepEqual(next.props, {});
});

test('applyMessage: createSurface clones data (later patch does not bleed back)', () => {
  const srcData = { metrics: { sources: 0 } };
  const next = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: { root: 'root', components: {}, data: srcData, props: {} },
  });
  const patched = applyMessage(next, { type: MSG.UPDATE_DATA, patch: { '/metrics/sources': 99 } });
  assert.equal(getPointer(patched.data, '/metrics/sources'), 99);
  assert.equal(srcData.metrics.sources, 0, 'source data object not mutated by downstream patch');
});

test('applyMessage: updateComponents upserts and forces node.id to the map key', () => {
  const base = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: { root: 'root', components: { root: { id: 'root', type: 'surface', children: [] } } },
  });
  const next = applyMessage(base, {
    type: MSG.UPDATE_COMPONENTS,
    components: {
      card1: { id: 'WRONG', type: 'card', props: { title: 'Hi' } }, // id deliberately mismatched
    },
  });
  assert.ok('card1' in next.components);
  assert.equal(next.components.card1.id, 'card1', 'node.id is forced to the key');
  assert.equal(next.components.card1.type, 'card');
});

test('applyMessage: updateComponents removes listed ids', () => {
  const base = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: {
      root: 'root',
      components: {
        root: { id: 'root', type: 'surface', children: ['a', 'b'] },
        a: { id: 'a', type: 'card' },
        b: { id: 'b', type: 'card' },
      },
    },
  });
  const next = applyMessage(base, { type: MSG.UPDATE_COMPONENTS, remove: ['b'] });
  assert.ok('a' in next.components);
  assert.ok(!('b' in next.components), 'b removed');
});

test('applyMessage: updateComponents — an id both removed and upserted is upserted (remove first)', () => {
  const base = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: { root: 'root', components: { x: { id: 'x', type: 'spinner' } } },
  });
  const next = applyMessage(base, {
    type: MSG.UPDATE_COMPONENTS,
    remove: ['x'],
    components: { x: { id: 'x', type: 'card', props: { title: 'done' } } },
  });
  assert.ok('x' in next.components, 'upsert applied after the remove');
  assert.equal(next.components.x.type, 'card');
});

test('applyMessage: updateComponents is immutable wrt input surface', () => {
  const base = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: { root: 'root', components: { root: { id: 'root', type: 'surface' } } },
  });
  const before = JSON.parse(JSON.stringify(base.components));
  const next = applyMessage(base, { type: MSG.UPDATE_COMPONENTS, components: { y: { id: 'y', type: 'card' } } });
  assert.deepEqual(base.components, before, 'input components map not mutated');
  assert.notEqual(next.components, base.components);
});

test('applyMessage: updateDataModel patches the data model', () => {
  const base = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: { root: 'root', components: {}, data: { p: 0 } },
  });
  const next = applyMessage(base, { type: MSG.UPDATE_DATA, patch: { '/p': 0.75 } });
  assert.equal(getPointer(next.data, '/p'), 0.75);
  assert.equal(getPointer(base.data, '/p'), 0, 'input surface data unchanged');
});

test('applyMessage: setSurfaceProps merges (does not replace) props', () => {
  const base = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: { root: 'root', components: {}, props: { title: 'A', accent: 'violet' } },
  });
  const next = applyMessage(base, { type: MSG.SET_SURFACE_PROPS, props: { accent: 'amber', theme: 'dark' } });
  assert.deepEqual(next.props, { title: 'A', accent: 'amber', theme: 'dark' });
  assert.deepEqual(base.props, { title: 'A', accent: 'violet' }, 'input props unchanged');
});

test('applyMessage: narrate / ping / action / unknown leave the surface unchanged and unmutated', () => {
  const base = applyMessage(emptySurface(), {
    type: MSG.CREATE_SURFACE,
    surface: { root: 'root', components: { root: { id: 'root', type: 'surface' } }, data: { a: 1 }, props: { title: 'T' } },
  });
  const snapshot = JSON.parse(JSON.stringify(base));
  for (const msg of [
    { type: MSG.NARRATE, text: 'Reading sources…' },
    { type: MSG.PING },
    { type: MSG.ACTION, action: 'expand', componentId: 'card1', value: null },
    { type: 'totally-unknown' },
  ]) {
    const next = applyMessage(base, msg);
    assert.deepEqual(next, base, `${msg.type}: surface content unchanged`);
  }
  assert.deepEqual(base, snapshot, 'input surface never mutated by control messages');
});

// ---------------------------------------------------------------------------
// Catalog sanity (the trusted allow-list)
// ---------------------------------------------------------------------------

test('TYPES: is a frozen, non-empty allow-list including core types', () => {
  assert.ok(Array.isArray(TYPES) && TYPES.length > 0);
  assert.ok(Object.isFrozen(TYPES));
  for (const t of ['surface', 'card', 'metric', 'grid', 'button', 'spinner']) {
    assert.ok(TYPES.includes(t), `catalog includes ${t}`);
  }
});

// --- regression: review finding #8 (setPointer delete hygiene) ---------------
test('setPointer: deleting a non-existent path is a no-op (no phantom containers)', () => {
  const doc = { a: 1 };
  const out = setPointer(doc, '/x/y/z', undefined);
  assert.deepEqual(out, { a: 1 }, 'must not materialize empty x/y intermediates');
  // deleting an existing leaf still works
  const doc2 = { a: { b: 2, c: 3 } };
  assert.deepEqual(setPointer(doc2, '/a/b', undefined), { a: { c: 3 } });
  assert.deepEqual(doc2, { a: { b: 2, c: 3 } }, 'original not mutated');
});
