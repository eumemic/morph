// stager.js — the transition-staging engine (the novel core)
// ---------------------------------------------------------------------------
// Given two MorphSpec surfaces that share stable component IDs, classify every
// id's change and produce a *transition plan*: which elements should get a
// `view-transition-name`, in what stagger order entrants appear, which numbers
// should count up, and whether we had to fall back to a root crossfade.
//
// This is the piece the 2026 research landscape flagged as the unclaimed gap:
// the View Transitions API gives you the *mechanism* to animate between two DOM
// states, but nobody had a *policy* for deciding HOW to animate the diff of two
// declarative agent-UI states. That policy lives here.
//
// Pure module: no DOM access, fully unit-testable. The renderer consumes the
// plan and does the imperative VT orchestration.
// ---------------------------------------------------------------------------

import {
  isTweenBind, rawBound, bindingPaths, getPointer,
} from './protocol.js';

/** Cap on simultaneously-named (animated) elements per transition. */
export const MAX_NAMED = 50;

/** A stable, CSS-`<custom-ident>`-safe view-transition-name for a component id. */
export function vtName(id) {
  // Custom idents can't start with a digit and must avoid most punctuation. The
  // "vt-" prefix guarantees a valid leading char; disallowed chars are hex-encoded
  // (not collapsed to "_") so the mapping is INJECTIVE — distinct ids never alias
  // to the same name, which would otherwise cause a duplicate-name VT error.
  return 'vt-' + String(id).replace(/[^A-Za-z0-9_-]/g, (c) => `-x${c.charCodeAt(0).toString(16)}-`);
}

/**
 * Index a surface into id -> { id, type, parentId, childIndex, node }.
 * Walks the *rendered tree* from `root` (orphaned components are ignored),
 * with a cycle guard so malformed agent output can't hang the renderer.
 */
export function indexSurface(surface) {
  const components = (surface && surface.components) || {};
  const root = (surface && surface.root) || 'root';
  const index = Object.create(null);
  const seen = new Set();
  const stack = [{ id: root, parentId: null, childIndex: 0 }];
  while (stack.length) {
    const { id, parentId, childIndex } = stack.shift();
    const node = components[id];
    if (!node || seen.has(id)) continue;
    seen.add(id);
    index[id] = { id, type: node.type, parentId, childIndex, node };
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) {
      stack.push({ id: kids[i], parentId: id, childIndex: i });
    }
  }
  return index;
}

// Did a node's ordered children list change (membership or order)?
function childrenChanged(a, b) {
  const ka = (a && a.children) || [];
  const kb = (b && b.children) || [];
  if (ka.length !== kb.length) return true;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return true;
  return false;
}

// Collect the tween-eligible props of a node whose bound value changed.
function tweenChangesForNode(id, prevNode, nextNode, prevData, nextData, entered) {
  const out = [];
  const props = (nextNode && nextNode.props) || {};
  for (const [prop, val] of Object.entries(props)) {
    if (!isTweenBind(val, nextData)) continue;
    const path = bindingPaths(val)[0];
    const to = Number(rawBound(val, nextData));
    if (!Number.isFinite(to)) continue;
    // Entrants count up from 0 for a satisfying first appearance; persisted
    // elements count from their previous bound value.
    let from;
    if (entered) {
      from = 0;
    } else {
      const prevVal = prevNode && prevNode.props ? prevNode.props[prop] : undefined;
      const prevRaw = prevVal !== undefined ? Number(rawBound(prevVal, prevData)) : Number(getPointer(prevData, path));
      from = Number.isFinite(prevRaw) ? prevRaw : 0;
    }
    if (from === to) continue; // nothing to animate
    out.push({ id, prop, path, from, to, format: val.format || null });
  }
  return out;
}

/**
 * Classify the diff between two surfaces.
 *
 * Returns a plan:
 *   {
 *     entered:  [id…]            // ordered for stagger (parent-major, child order)
 *     exited:   [id…]
 *     moved:    [id…]            // persisted; parent/index changed, or reflowed
 *     morphed:  [id…]            // persisted; component `type` changed
 *     named:    Set<id>          // ids that should receive a view-transition-name
 *     stagger:  Map<id, number>  // 0-based enter order, for stagger delays
 *     valueTweens: [{id, prop, path, from, to, format}…]
 *     rootFade: boolean          // true => DON'T freeze root (crossfade fallback)
 *     capped:   number           // count of changes dropped past MAX_NAMED
 *     counts:   {…}              // summary, for telemetry/debug
 *   }
 */
export function stage(prev, next) {
  const prevIdx = indexSurface(prev);
  const nextIdx = indexSurface(next);
  const prevData = (prev && prev.data) || {};
  const nextData = (next && next.data) || {};

  const prevIds = new Set(Object.keys(prevIdx));
  const nextIds = new Set(Object.keys(nextIdx));

  const entered = [];
  const exited = [];
  const moved = [];
  const morphed = [];
  const valueTweens = [];

  // Containers whose ordered children changed — their persistent children may
  // reflow (shift position), so those children should be named for a FLIP.
  const reflowParents = new Set();
  for (const id of nextIds) {
    if (!prevIds.has(id)) continue;
    if (childrenChanged(prevIdx[id].node, nextIdx[id].node)) reflowParents.add(id);
  }

  // Exits.
  for (const id of prevIds) {
    if (!nextIds.has(id)) exited.push(id);
  }

  // Entrants + persisted classification.
  for (const id of nextIds) {
    const n = nextIdx[id];
    if (!prevIds.has(id)) {
      entered.push(id);
      valueTweens.push(...tweenChangesForNode(id, undefined, n.node, prevData, nextData, true));
      continue;
    }
    const p = prevIdx[id];
    if (p.type !== n.type) {
      morphed.push(id);
    } else if (p.parentId !== n.parentId || p.childIndex !== n.childIndex) {
      moved.push(id); // crossed containers or reordered within a container
    } else if (reflowParents.has(n.parentId)) {
      moved.push(id); // sibling churn will shift this element — FLIP it
    }
    valueTweens.push(...tweenChangesForNode(id, p.node, n.node, prevData, nextData, false));
  }

  // Stagger order for entrants: parent-major, then child index — so a freshly
  // populated list/grid cascades in reading order rather than all at once.
  entered.sort((a, b) => {
    const A = nextIdx[a], B = nextIdx[b];
    if (A.parentId !== B.parentId) return String(A.parentId).localeCompare(String(B.parentId));
    return A.childIndex - B.childIndex;
  });
  const stagger = new Map();
  entered.forEach((id, i) => stagger.set(id, i));

  // Build the named set, prioritizing the changes whose motion carries the most
  // meaning if we have to cap: morph > move > exit > enter.
  const ordered = [...morphed, ...moved, ...exited, ...entered];
  const named = new Set();
  let capped = 0;
  for (const id of ordered) {
    if (named.size < MAX_NAMED) named.add(id);
    else capped++;
  }

  return {
    entered, exited, moved, morphed, valueTweens,
    named, stagger,
    rootFade: capped > 0, // only fall back to a root crossfade when we capped
    capped,
    counts: {
      entered: entered.length,
      exited: exited.length,
      moved: moved.length,
      morphed: morphed.length,
      tweens: valueTweens.length,
      named: named.size,
    },
  };
}

/** Convenience: does this plan call for any visible motion at all? */
export function hasMotion(plan) {
  return (
    plan.named.size > 0 || plan.valueTweens.length > 0 || plan.rootFade
  );
}
