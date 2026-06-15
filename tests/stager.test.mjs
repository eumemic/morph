// Behavioral spec for the transition-staging engine.
// Run: node --test tests/   (or: node --test tests/stager.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stage, indexSurface, vtName, hasMotion, MAX_NAMED } from '../web/js/stager.js';
import { emptySurface } from '../web/js/protocol.js';

// --- tiny surface builder -------------------------------------------------
function surf(components, data = {}, root = 'root') {
  // components: { id: {type, children?, props?} }  -> fills in id
  const out = {};
  for (const [id, n] of Object.entries(components)) out[id] = { id, ...n };
  return { root, components: out, data, props: {} };
}

test('vtName produces valid, stable, unique custom-idents', () => {
  assert.equal(vtName('card-1'), 'vt-card-1');  // simple ids pass through unchanged
  assert.equal(vtName('123'), 'vt-123');        // prefix guarantees valid leading char
  assert.match(vtName('m/1'), /^vt-[A-Za-z0-9_-]+$/); // slashes hex-encoded, still valid
  assert.notEqual(vtName('card-1'), vtName('card-2')); // distinct simple ids -> distinct names
  // The mapping is injective: even exotic ids that share a sanitized shape get
  // DISTINCT names (hex-encoded), so VT can never hit a duplicate-name collision.
  assert.notEqual(vtName('a.b'), vtName('a/b'));
  // result is a valid custom-ident (letters/digits/_/-, non-digit leading char)
  assert.match(vtName('a.b/c'), /^vt-[A-Za-z0-9_-]+$/);
});

test('indexSurface records parent, child index, and type; ignores orphans; guards cycles', () => {
  const s = surf({
    root: { type: 'surface', children: ['a', 'b'] },
    a: { type: 'card', children: ['a1'] },
    a1: { type: 'text' },
    b: { type: 'metric' },
    orphan: { type: 'text' },          // not reachable from root
    cyc: { type: 'card', children: ['cyc'] }, // self-cycle, also orphaned
  });
  const idx = indexSurface(s);
  assert.equal(idx.root.parentId, null);
  assert.equal(idx.a.parentId, 'root');
  assert.equal(idx.a.childIndex, 0);
  assert.equal(idx.b.childIndex, 1);
  assert.equal(idx.a1.parentId, 'a');
  assert.equal(idx.a1.type, 'text');
  assert.ok(!('orphan' in idx), 'orphans are not indexed');
});

test('first mount: every node enters, staggered in reading order', () => {
  const next = surf({
    root: { type: 'surface', children: ['h', 'list'] },
    h: { type: 'heading', props: { text: 'Hi' } },
    list: { type: 'list', children: ['i0', 'i1', 'i2'] },
    i0: { type: 'listitem' }, i1: { type: 'listitem' }, i2: { type: 'listitem' },
  });
  const plan = stage(emptySurface(), next);
  assert.equal(plan.exited.length, 0);
  assert.equal(plan.moved.length, 0);
  assert.equal(plan.morphed.length, 0);
  assert.deepEqual(new Set(plan.entered), new Set(['root', 'h', 'list', 'i0', 'i1', 'i2']));
  // list's children stagger in index order
  assert.ok(plan.stagger.get('i0') < plan.stagger.get('i1'));
  assert.ok(plan.stagger.get('i1') < plan.stagger.get('i2'));
  assert.ok(hasMotion(plan));
});

test('moved: a card that changes parent column is classified moved (the kanban fly)', () => {
  const base = (aKids, bKids) => surf({
    root: { type: 'surface', children: ['board'] },
    board: { type: 'board', children: ['colA', 'colB'] },
    colA: { type: 'column', children: aKids },
    colB: { type: 'column', children: bKids },
    card1: { type: 'card' },
  });
  const prev = base(['card1'], []);
  const next = base([], ['card1']);
  const plan = stage(prev, next);
  assert.ok(plan.moved.includes('card1'), 'card1 moved across columns');
  assert.ok(!plan.entered.includes('card1') && !plan.exited.includes('card1'));
  assert.ok(plan.named.has('card1'), 'moved element is named so VT can FLIP it');
});

test('moved: reorder within a list shifts siblings (reflow neighbors named too)', () => {
  const mk = (kids) => surf({
    root: { type: 'surface', children: ['list'] },
    list: { type: 'list', children: kids },
    a: { type: 'listitem' }, b: { type: 'listitem' }, c: { type: 'listitem' },
  });
  const plan = stage(mk(['a', 'b', 'c']), mk(['b', 'a', 'c']));
  assert.ok(plan.moved.includes('a') && plan.moved.includes('b'),
    'reordered items are moved');
  assert.ok(plan.moved.includes('c'),
    'a sibling that kept its index still reflows when the list changed');
});

test('morphed: same id, new type (spinner -> card) is a morph, not enter/exit', () => {
  const prev = surf({
    root: { type: 'surface', children: ['x'] },
    x: { type: 'spinner', props: { label: 'Loading' } },
  });
  const next = surf({
    root: { type: 'surface', children: ['x'] },
    x: { type: 'card', props: { title: 'Result' } },
  });
  const plan = stage(prev, next);
  assert.deepEqual(plan.morphed, ['x']);
  assert.ok(!plan.entered.includes('x') && !plan.exited.includes('x'));
  assert.ok(plan.named.has('x'));
});

test('exited: a removed id is classified exited and named (so it can animate out)', () => {
  const prev = surf({
    root: { type: 'surface', children: ['keep', 'gone'] },
    keep: { type: 'card' }, gone: { type: 'card' },
  });
  const next = surf({
    root: { type: 'surface', children: ['keep'] },
    keep: { type: 'card' },
  });
  const plan = stage(prev, next);
  assert.deepEqual(plan.exited, ['gone']);
  assert.ok(plan.named.has('gone'));
});

test('valueTween: persisted metric counts from its previous bound value', () => {
  const node = {
    root: { type: 'surface', children: ['m'] },
    m: { type: 'metric', props: { label: 'Sources', value: { $bind: '/m/sources', tween: true, format: 'int' } } },
  };
  const prev = surf(node, { m: { sources: 2 } });
  const next = surf(node, { m: { sources: 7 } });
  const plan = stage(prev, next);
  assert.equal(plan.valueTweens.length, 1);
  const t = plan.valueTweens[0];
  assert.equal(t.id, 'm');
  assert.equal(t.from, 2);
  assert.equal(t.to, 7);
  assert.equal(t.format, 'int');
});

test('valueTween: a newly entered metric counts up from 0', () => {
  const next = surf({
    root: { type: 'surface', children: ['m'] },
    m: { type: 'metric', props: { value: { $bind: '/v', tween: true } } },
  }, { v: 42 });
  const plan = stage(emptySurface(), next);
  const t = plan.valueTweens.find((x) => x.id === 'm');
  assert.ok(t);
  assert.equal(t.from, 0);
  assert.equal(t.to, 42);
});

test('valueTween: no entry when the number did not change', () => {
  const node = {
    root: { type: 'surface', children: ['m'] },
    m: { type: 'metric', props: { value: { $bind: '/v', tween: true } } },
  };
  const plan = stage(surf(node, { v: 5 }), surf(node, { v: 5 }));
  assert.equal(plan.valueTweens.length, 0);
  assert.ok(!hasMotion(plan), 'identical surfaces produce no motion');
});

test('cap: more than MAX_NAMED changes caps the named set and triggers root fade', () => {
  const components = { root: { type: 'surface', children: [] } };
  const kids = [];
  for (let i = 0; i < MAX_NAMED + 10; i++) {
    const id = 'k' + i;
    kids.push(id);
    components[id] = { type: 'card' };
  }
  components.root.children = kids;
  const plan = stage(emptySurface(), surf(components));
  assert.equal(plan.named.size, MAX_NAMED, 'named set is capped');
  assert.ok(plan.capped >= 10, 'overflow is counted, not silently dropped');
  assert.equal(plan.rootFade, true, 'capped transitions fall back to a root crossfade');
});

test('stage does not mutate its inputs', () => {
  const prev = surf({ root: { type: 'surface', children: ['a'] }, a: { type: 'card' } }, { x: 1 });
  const next = surf({ root: { type: 'surface', children: ['a', 'b'] }, a: { type: 'card' }, b: { type: 'card' } }, { x: 2 });
  const prevCopy = JSON.parse(JSON.stringify(prev));
  const nextCopy = JSON.parse(JSON.stringify(next));
  stage(prev, next);
  assert.deepEqual(prev, prevCopy);
  assert.deepEqual(next, nextCopy);
});
