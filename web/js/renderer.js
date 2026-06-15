// renderer.js — MorphSpec surface -> DOM, with View Transitions orchestration.
//
// Each apply() rebuilds the component tree (cheap at dashboard scale) and tags
// every element with data-mid=<id>. The stager's plan tells us which ids changed;
// we assign `view-transition-name: vt-<id>` to JUST those — on both the outgoing
// and incoming elements — so the browser FLIPs/cross-fades only what moved, and
// the unchanged remainder swaps instantly under a frozen root. Names are cleared
// after each transition, so steady state carries zero view-transition cost.

import { renderComponent } from './components.js';
import { vtName } from './stager.js';
import { prefersReducedMotion } from './tween.js';
import { clamp } from './protocol.js';

const ENTER_STAGGER_MS = 45;
const ENTER_STAGGER_CAP = 12; // don't let a big cascade run absurdly long

// Display props that are plain text and may be bound ($bind/$tpl). We resolve
// these once here so EVERY component shows resolved strings — without touching
// value/spark/series/count/pairs/data, which components handle specially (tween,
// arrays) and must receive raw.
const TEXT_PROPS = ['title', 'subtitle', 'kicker', 'label', 'text', 'footer', 'trailing', 'time'];

function resolveTextProps(node, ctx) {
  const props = node.props;
  if (!props) return node;
  let copy = null;
  for (const k of TEXT_PROPS) {
    const v = props[k];
    if (v != null && typeof v === 'object') { // a binding or stray object
      copy = copy || { ...node, props: { ...props } };
      copy.props[k] = ctx.resolve(v);
    }
  }
  return copy || node;
}

export class Renderer {
  constructor(mount) {
    this.mount = mount;
    this.prevEls = new Map(); // id -> element from the last committed render
    this.state = new Map();   // id -> ephemeral per-node state (e.g. chart series)
    this._chain = Promise.resolve(); // serialize overlapping transitions
  }

  apply(surface, plan, ctx) {
    this._chain = this._chain.then(() => this._apply(surface, plan, ctx)).catch((e) => {
      console.error('[morph] render error', e);
    });
    return this._chain;
  }

  _apply(surface, plan, ctx) {
    const built = this._build(surface, ctx);
    const after = ctx._after || [];
    const reduced = prefersReducedMotion();
    const canVT = typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
    const structural = plan && plan.named && plan.named.size > 0;

    // Fast path: no structural motion (or motion unsupported/disabled) -> swap
    // and run any number tweens immediately (they animate the live DOM).
    if (!structural || !canVT || reduced) {
      this.mount.replaceChildren(built.root);
      this.prevEls = built.els;
      runAll(after);
      return Promise.resolve();
    }

    if (plan.capped > 0) {
      console.warn(`[morph] transition capped: ${plan.capped} change(s) over MAX_NAMED fell back to a root crossfade`);
    }

    const oldEls = this.prevEls || new Map();
    const names = [...plan.named];

    // Name the OUTGOING elements that persist/exit, so VT keeps an "old" snapshot.
    for (const id of names) {
      const el = oldEls.get(id);
      if (el) el.style.viewTransitionName = vtName(id);
    }

    const styleEl = this._injectDynamicCss(plan);
    // The ::view-transition-* pseudo-elements originate from the document root,
    // so the root-crossfade fallback toggle must live on <html>, not the mount.
    document.documentElement.classList.toggle('m-rootfade', !!plan.rootFade);

    const vt = document.startViewTransition(() => {
      // Name the INCOMING elements; matching names across snapshots = animation.
      for (const id of names) {
        const el = built.els.get(id);
        if (el) el.style.viewTransitionName = vtName(id);
      }
      this.mount.replaceChildren(built.root);
    });

    const cleanup = () => {
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      for (const id of names) {
        const el = built.els.get(id);
        if (el) el.style.viewTransitionName = '';
      }
      document.documentElement.classList.remove('m-rootfade');
    };

    this.prevEls = built.els;

    // During a view transition the live DOM is hidden behind snapshot pseudo-
    // elements, so number tweens must start only AFTER it finishes to be seen.
    return vt.finished
      .catch(() => {})
      .finally(() => { cleanup(); runAll(after); });
  }

  // Build a detached tree for `surface`; returns { root, els: Map<id,el> }.
  _build(surface, ctx) {
    const els = new Map();
    const built = new Set();
    const components = surface.components || {};

    const build = (id) => {
      const node = components[id];
      if (!node || built.has(id)) return null; // missing or already placed (cycle/dupe guard)
      built.add(id);

      // Per-id ephemeral state (e.g. chart series). Reset it when the component
      // morphs to a different type, so a stale stash can't bleed across types.
      let st = this.state.get(id);
      if (!st || st.__type !== node.type) {
        st = { __type: node.type };
        this.state.set(id, st);
      }
      // Isolate per-component failures: one malformed widget from the agent must
      // never blank the whole dashboard. On a throw, render a small error chip and
      // keep going so the other 64 widgets still appear.
      let el;
      try {
        el = renderComponent(resolveTextProps(node, ctx), ctx, st);
      } catch (e) {
        console.error(`[morph] component ${id} (${node.type}) failed to render:`, e);
        el = document.createElement('div');
        el.className = 'm-unknown';
        el.textContent = `⚠ ${node.type} (${id})`;
      }
      el.dataset.mid = id;

      // Tolerate raw color accents (agents emit hex/rgb as well as named tokens):
      // the named tokens are CSS classes, but a hex won't match one, so apply it
      // inline. --accent + color drive every accent-colored bit (charts use
      // currentColor; the m-accent-* CSS uses var(--accent)).
      const acc = node.props && node.props.accent;
      if (typeof acc === 'string' && /^(#|rgb|hsl)/i.test(acc)) {
        el.style.setProperty('--accent', acc);
        el.style.color = acc;
      }
      els.set(id, el);

      if (node.layout && node.layout.span) {
        el.style.gridColumn = `span ${clamp(node.layout.span, 1, 4)}`;
      }

      const kids = node.children || [];
      if (kids.length) {
        const slotEl = (el.matches('[data-slot]') ? el : el.querySelector('[data-slot]')) || el;
        for (const cid of kids) {
          const child = build(cid);
          if (child) slotEl.appendChild(child);
        }
      }
      return el;
    };

    const root = build(surface.root || 'root') || document.createComment('empty');
    // Drop ephemeral state for ids no longer present.
    for (const id of [...this.state.keys()]) if (!els.has(id)) this.state.delete(id);
    return { root, els };
  }

  // Generate per-transition CSS keyframe assignments keyed by view-transition-name.
  _injectDynamicCss(plan) {
    const rules = [];
    const enteredSet = new Set(plan.entered);
    const exitedSet = new Set(plan.exited);
    const morphedSet = new Set(plan.morphed);

    for (const id of plan.named) {
      const name = vtName(id);
      if (enteredSet.has(id)) {
        const i = Math.min(plan.stagger.get(id) || 0, ENTER_STAGGER_CAP);
        rules.push(
          `::view-transition-new(${name}){animation:m-enter var(--m-dur) var(--m-ease) both;animation-delay:${i * ENTER_STAGGER_MS}ms;}`,
          `::view-transition-old(${name}){animation:none;}`,
        );
      } else if (exitedSet.has(id)) {
        rules.push(
          `::view-transition-old(${name}){animation:m-exit calc(var(--m-dur)*0.8) ease-in both;}`,
          `::view-transition-new(${name}){animation:none;}`,
        );
      } else if (morphedSet.has(id)) {
        rules.push(
          `::view-transition-group(${name}){animation-duration:var(--m-dur);animation-timing-function:var(--m-ease);}`,
          `::view-transition-old(${name}){animation:m-fade-out calc(var(--m-dur)*0.7) both;}`,
          `::view-transition-new(${name}){animation:m-fade-in var(--m-dur) both;}`,
        );
      } else {
        // moved / reflowed: let the group transform FLIP position; suppress the
        // default content cross-fade so same-content moves read as a clean slide.
        rules.push(
          `::view-transition-group(${name}){animation-duration:var(--m-dur);animation-timing-function:var(--m-ease);}`,
          `::view-transition-old(${name}),::view-transition-new(${name}){animation:none;}`,
        );
      }
    }

    const styleEl = document.createElement('style');
    styleEl.id = 'm-vt-dyn';
    styleEl.textContent = rules.join('\n');
    document.head.appendChild(styleEl);
    return styleEl;
  }
}

function runAll(fns) {
  for (const fn of fns) {
    try { fn(); } catch (e) { console.error('[morph] tween error', e); }
  }
  fns.length = 0;
}
