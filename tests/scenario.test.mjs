// scenario.test.mjs — validates ./scenario.json against the MorphSpec contract.
// Reads the file via node:fs (NOT import-assert) so a malformed or missing file
// produces a clear, actionable failure instead of crashing the module loader.
// Replays the scenario through the real protocol.applyMessage and asserts the
// structural + transition invariants the renderer relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MSG, TYPES, emptySurface, applyMessage } from '../web/js/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(__dirname, '..', 'scenario.json');

// ---------------------------------------------------------------------------
// Load. If the file is absent we still register the suite, but skip the body —
// this keeps the test file valid (per the task) before scenario.json exists.
// ---------------------------------------------------------------------------

const present = existsSync(SCENARIO_PATH);
const skip = present ? false : `scenario.json not found at ${SCENARIO_PATH}`;

let scenario = null;
let parseError = null;
if (present) {
  try {
    scenario = JSON.parse(readFileSync(SCENARIO_PATH, 'utf8'));
  } catch (e) {
    parseError = e;
  }
}

// Iterate the wire messages of a step, expanding the `narrate` convenience field
// into an actual narrate message (matching the server's playback semantics).
function* stepMessages(step) {
  if (typeof step.narrate === 'string') {
    yield { type: MSG.NARRATE, text: step.narrate };
  }
  for (const m of step.messages || []) yield m;
}

// Every wire message across the whole scenario, in playback order.
function* allMessages(sc) {
  for (const step of sc.steps || []) yield* stepMessages(step);
}

// ---------------------------------------------------------------------------
// Parse + top-level shape
// ---------------------------------------------------------------------------

test('scenario.json: parses as JSON', { skip }, () => {
  assert.equal(parseError, null, parseError ? `JSON parse failed: ${parseError.message}` : '');
  assert.ok(scenario && typeof scenario === 'object', 'parsed to an object');
});

test('scenario.json: has title and a non-empty steps[]', { skip }, () => {
  assert.equal(typeof scenario.title, 'string');
  assert.ok(scenario.title.length > 0, 'title is non-empty');
  assert.ok(Array.isArray(scenario.steps), 'steps is an array');
  assert.ok(scenario.steps.length > 0, 'at least one step');
});

test('scenario.json: every step has numeric delayMs and a messages[] array', { skip }, () => {
  scenario.steps.forEach((step, i) => {
    assert.equal(typeof step.delayMs, 'number', `step[${i}].delayMs is a number`);
    assert.ok(Number.isFinite(step.delayMs) && step.delayMs >= 0, `step[${i}].delayMs is finite & >= 0`);
    assert.ok(Array.isArray(step.messages), `step[${i}].messages is an array`);
    if (step.narrate !== undefined) {
      assert.equal(typeof step.narrate, 'string', `step[${i}].narrate (if present) is a string`);
    }
  });
});

test('scenario.json: opens with a createSurface (first structural message)', { skip }, () => {
  // A leading `narrate` convenience is allowed; the first *structural* message
  // must instantiate the surface, and it must live in the very first step.
  const msgs = [...allMessages(scenario)];
  assert.ok(msgs.length > 0, 'has at least one message');
  const firstStructural = msgs.find((m) => m.type !== MSG.NARRATE);
  assert.ok(firstStructural, 'has a non-narrate message');
  assert.equal(firstStructural.type, MSG.CREATE_SURFACE, 'first structural message instantiates the surface');

  const firstStepHasCreate = [...stepMessages(scenario.steps[0])].some((m) => m.type === MSG.CREATE_SURFACE);
  assert.ok(firstStepHasCreate, 'the opening step contains the createSurface');
});

// ---------------------------------------------------------------------------
// Replay invariants
// ---------------------------------------------------------------------------

test('scenario.json: replaying every message never throws', { skip }, () => {
  let surface = emptySurface();
  let idx = 0;
  for (const msg of allMessages(scenario)) {
    assert.doesNotThrow(() => {
      surface = applyMessage(surface, msg);
    }, `applyMessage threw at message index ${idx} (type=${msg && msg.type})`);
    idx++;
  }
});

test('scenario.json: final surface root exists in components', { skip }, () => {
  let surface = emptySurface();
  for (const msg of allMessages(scenario)) surface = applyMessage(surface, msg);
  assert.ok(surface.root, 'final surface has a root id');
  assert.ok(surface.components[surface.root], `root "${surface.root}" resolves to a component`);
  assert.equal(surface.components[surface.root].id, surface.root, 'root node id matches');
});

test('scenario.json: every component type used (over all steps) is in TYPES', { skip }, () => {
  const seen = new Set();
  const offenders = [];
  for (const msg of allMessages(scenario)) {
    if (msg.type === MSG.CREATE_SURFACE) {
      for (const node of Object.values(msg.surface?.components || {})) {
        if (node && node.type) seen.add(node.type);
      }
    } else if (msg.type === MSG.UPDATE_COMPONENTS) {
      for (const node of Object.values(msg.components || {})) {
        if (node && node.type) seen.add(node.type);
      }
    }
  }
  for (const t of seen) if (!TYPES.includes(t)) offenders.push(t);
  assert.deepEqual(offenders, [], `unknown component types: ${offenders.join(', ')}`);
  assert.ok(seen.size > 0, 'scenario actually uses some components');
});

test('scenario.json: final surface has no dangling children (every child id resolves)', { skip }, () => {
  let surface = emptySurface();
  for (const msg of allMessages(scenario)) surface = applyMessage(surface, msg);

  const dangling = [];
  for (const node of Object.values(surface.components)) {
    for (const childId of node.children || []) {
      if (!surface.components[childId]) dangling.push(`${node.id} -> ${childId}`);
    }
  }
  assert.deepEqual(dangling, [], `dangling child references: ${dangling.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Showcase transitions — each must be exercised somewhere in the scenario.
// Implemented as scans over the per-step messages.
// ---------------------------------------------------------------------------

// Helper: for each step (in order), compute the {childId -> parentId} mapping
// declared by that step's createSurface / updateComponents messages, plus the
// {id -> type} mapping, and the set of removed ids.
function perStepStructure(sc) {
  return sc.steps.map((step) => {
    const childToParent = new Map();
    const idToType = new Map();
    const removed = new Set();
    const tweenProps = []; // [{id, prop}]

    const ingestNode = (node) => {
      if (!node || !node.id) return;
      if (node.type) idToType.set(node.id, node.type);
      for (const childId of node.children || []) childToParent.set(childId, node.id);
      for (const [prop, val] of Object.entries(node.props || {})) {
        if (val && typeof val === 'object' && typeof val.$bind === 'string' && val.tween === true) {
          tweenProps.push({ id: node.id, prop });
        }
      }
    };

    for (const msg of stepMessages(step)) {
      if (msg.type === MSG.CREATE_SURFACE) {
        for (const node of Object.values(msg.surface?.components || {})) ingestNode(node);
      } else if (msg.type === MSG.UPDATE_COMPONENTS) {
        for (const id of msg.remove || []) removed.add(id);
        for (const [id, node] of Object.entries(msg.components || {})) {
          ingestNode({ ...node, id });
        }
      }
    }
    return { childToParent, idToType, removed, tweenProps };
  });
}

test('scenario.json showcase: a card MOVES (same id under different parents across steps)', { skip }, () => {
  const steps = perStepStructure(scenario);
  // Track last-known parent per id; a move is the same id appearing under a
  // different parent in a later step.
  const lastParent = new Map();
  let moved = null;
  outer: for (const { childToParent } of steps) {
    for (const [childId, parentId] of childToParent) {
      if (lastParent.has(childId) && lastParent.get(childId) !== parentId) {
        moved = { childId, from: lastParent.get(childId), to: parentId };
        break outer;
      }
    }
    for (const [childId, parentId] of childToParent) lastParent.set(childId, parentId);
  }
  assert.ok(moved, 'expected at least one id to be reparented across steps (a move)');
});

test('scenario.json showcase: a node MORPHS (same id, type changes across steps)', { skip }, () => {
  const steps = perStepStructure(scenario);
  const lastType = new Map();
  let morphed = null;
  outer: for (const { idToType } of steps) {
    for (const [id, type] of idToType) {
      if (lastType.has(id) && lastType.get(id) !== type) {
        morphed = { id, from: lastType.get(id), to: type };
        break outer;
      }
    }
    for (const [id, type] of idToType) lastType.set(id, type);
  }
  assert.ok(morphed, 'expected at least one id to change type across steps (a morph)');
});

test('scenario.json showcase: a node EXITS (present, then removed via remove[])', { skip }, () => {
  const steps = perStepStructure(scenario);
  const known = new Set();
  let exited = null;
  for (const { idToType, removed } of steps) {
    for (const id of removed) {
      if (known.has(id)) {
        exited = id;
        break;
      }
    }
    if (exited) break;
    for (const id of idToType.keys()) known.add(id);
  }
  assert.ok(exited, 'expected an id that was present earlier to be removed via remove[] (an exit)');
});

test('scenario.json showcase: at least one TWEEN binding (a prop with tween:true)', { skip }, () => {
  const steps = perStepStructure(scenario);
  const found = steps.some((s) => s.tweenProps.length > 0);
  assert.ok(found, 'expected at least one component prop with a { $bind, tween:true } binding');
});

test('scenario.json showcase: at least one value TWEEN is actually driven by an updateDataModel', { skip }, () => {
  // The tween only animates if its bound pointer is later patched. Verify the
  // scenario both declares a tween bind and patches a pointer the bind reads.
  const tweenPointers = new Set();
  const patchedPointers = new Set();
  for (const msg of allMessages(scenario)) {
    if (msg.type === MSG.CREATE_SURFACE) {
      for (const node of Object.values(msg.surface?.components || {})) collectTweenPtrs(node, tweenPointers);
    } else if (msg.type === MSG.UPDATE_COMPONENTS) {
      for (const node of Object.values(msg.components || {})) collectTweenPtrs(node, tweenPointers);
    } else if (msg.type === MSG.UPDATE_DATA) {
      for (const ptr of Object.keys(msg.patch || {})) patchedPointers.add(ptr);
    }
  }
  // A patch drives a tween if a patched pointer equals or is a prefix-ancestor
  // of a tween's bound pointer (patching /metrics drives /metrics/sources too).
  const driven = [...tweenPointers].some((tp) =>
    [...patchedPointers].some((pp) => tp === pp || tp.startsWith(pp + '/') || pp.startsWith(tp + '/')),
  );
  assert.ok(driven, 'expected a tween-bound pointer to be moved by an updateDataModel patch');
});

function collectTweenPtrs(node, out) {
  for (const val of Object.values(node?.props || {})) {
    if (val && typeof val === 'object' && typeof val.$bind === 'string' && val.tween === true) {
      out.add(val.$bind);
    }
  }
}
