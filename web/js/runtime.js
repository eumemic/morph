// runtime.js — transport-agnostic dispatch core.
// Folds incoming MorphSpec messages into the authoritative surface, asks the
// stager for a plan, and drives the renderer. Shared by app.js (live SSE) and
// preview.html (offline stepping / screenshots), neither of which should depend
// on the other's transport.

import {
  MSG, emptySurface, applyMessage, resolve as resolveBinding, getPointer, isBind,
} from './protocol.js';
import { stage } from './stager.js';
import { Renderer } from './renderer.js';
import { prefersReducedMotion } from './tween.js';

export class Runtime {
  constructor(mount, { onChrome, onNarrate, onAction } = {}) {
    this.renderer = new Renderer(mount);
    this.state = { surface: emptySurface() };
    this.onChrome = onChrome || (() => {});
    this.onNarrate = onNarrate || (() => {});
    this.onAction = onAction || null;
    this._pending = [];
    this._timer = null;
  }

  /** Handle one wire message (coalesced into the next animation frame). */
  handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case MSG.NARRATE: this.onNarrate(msg.text); return;
      case MSG.PING: return;
      case MSG.ACTION: return; // inbound actions not expected
      default:
        this._pending.push(msg);
        if (this._timer == null) this._timer = setTimeout(() => this.flushNow(), 16);
    }
  }

  /** Apply all coalesced messages now, as a single transition. */
  flushNow() {
    if (this._timer != null) { clearTimeout(this._timer); this._timer = null; }
    const msgs = this._pending;
    this._pending = [];
    if (msgs.length) this.applyMessages(msgs);
  }

  /** Fold render-affecting messages into one transition immediately. */
  applyMessages(msgs) {
    const prev = this.state.surface;
    let next = prev;
    for (const m of msgs) {
      if (m.type === MSG.NARRATE) { this.onNarrate(m.text); continue; }
      if (m.type === MSG.PING || m.type === MSG.ACTION) continue;
      next = applyMessage(next, m);
    }
    if (next === prev) return;
    const plan = stage(prev, next);
    this.state.surface = next;
    this.onChrome(next);
    this.renderer.apply(next, plan, this._buildCtx(next, plan));
  }

  reset() {
    this.state.surface = emptySurface();
    this.renderer.prevEls = new Map();
    this.renderer.state = new Map();
    this.renderer.mount.replaceChildren();
  }

  emit(action, value, componentId) {
    this.onNarrate(`▸ ${action}${value != null ? ` (${value})` : ''}`);
    if (this.onAction) this.onAction({ type: MSG.ACTION, action, value, componentId });
  }

  _buildCtx(surface, plan) {
    const data = surface.data || {};
    const tweenMap = new Map();
    for (const t of plan.valueTweens) tweenMap.set(`${t.id}::${t.prop}`, t);
    const _after = [];
    return {
      data,
      surface,
      reduced: prefersReducedMotion(),
      _after,
      afterTransition: (fn) => _after.push(fn),
      resolve: (v) => resolveBinding(v, data),
      raw: (v) => (isBind(v) ? getPointer(data, v.$bind) : v),
      tweenFor: (id, prop) => tweenMap.get(`${id}::${prop}`) || null,
      emit: (a, v, id) => this.emit(a, v, id),
    };
  }
}
