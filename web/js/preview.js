// preview.js — offline scenario player (no server required).
// Query params:
//   ?static       render the final (or ?step=N) state instantly, no motion
//                 (deterministic — used for headless screenshots)
//   ?step=N       apply only the first N scenario steps
//   ?speed=2      speed up animated playback (default 1)
// With no params it auto-plays scenario.json with animation. Arrow keys step.

import { Runtime } from './runtime.js';
import { setReducedMotion } from './tween.js';

const appEl = document.getElementById('app');
const titleEl = document.getElementById('title');
const tickerEl = document.getElementById('ticker');
const statusEl = document.getElementById('status');
const counterEl = document.getElementById('counter');

const qp = new URLSearchParams(location.search);
const isStatic = qp.has('static');
const isSelftest = qp.has('selftest'); // play full scenario WITH motion, trap errors
const speed = isSelftest ? 8 : (parseFloat(qp.get('speed') || '1') || 1);

// Self-test: surface any runtime/renderer/View-Transition error to headless tooling.
let _errors = 0;
if (isSelftest) {
  window.addEventListener('error', (e) => { _errors++; console.error('[selftest]', e.message); });
  window.addEventListener('unhandledrejection', (e) => { _errors++; console.error('[selftest]', e.reason); });
}
function finishSelftest() {
  document.body.dataset.selftest = 'done';
  document.body.dataset.errors = String(_errors);
}

function applyChrome(surface) {
  const p = surface.props || {};
  if (p.title) { titleEl.textContent = p.title; document.title = `Morph · ${p.title}`; }
  if (p.accent) appEl.dataset.accent = p.accent;
  if (p.theme) appEl.dataset.theme = p.theme;
}
function narrate(text) {
  if (!text) return;
  const line = document.createElement('span');
  line.className = 'm-ticker-line';
  line.textContent = text;
  tickerEl.replaceChildren(line);
  void line.offsetWidth;
  line.classList.add('in');
}

const runtime = new Runtime(document.getElementById('stage'), { onChrome: applyChrome, onNarrate: narrate });

function stepMessages(step) {
  const msgs = [];
  if (step.narrate) msgs.push({ type: 'narrate', text: step.narrate });
  for (const m of step.messages || []) msgs.push(m);
  return msgs;
}

// Source defaults to the scripted scenario, but ?src=<url> can point at any
// MorphSpec source: a {steps:[…]} scenario, or a flat array of wire messages
// (e.g. a captured live-agent run) which is treated as a single step.
const src = qp.get('src') || 'scenario.json';
const raw = await (await fetch(src)).json();
const steps = Array.isArray(raw) ? [{ messages: raw }] : (raw.steps || []);
const upto = qp.has('step') ? Math.max(0, Math.min(parseInt(qp.get('step'), 10) || 0, steps.length)) : steps.length;

// 'preview' has no ::after label rule, so the step counter shows cleanly.
if (statusEl) statusEl.dataset.state = 'preview';

if (isStatic) {
  setReducedMotion(true);
  const msgs = [];
  for (let i = 0; i < upto; i++) msgs.push(...stepMessages(steps[i]));
  runtime.applyMessages(msgs);
  setCounter(upto);
  document.body.dataset.ready = '1'; // signal for screenshot tooling
} else {
  let i = 0;
  const playNext = () => {
    if (i >= upto) { setCounter(upto); if (isSelftest) setTimeout(finishSelftest, 400); return; }
    const step = steps[i++];
    runtime.applyMessages(stepMessages(step));
    setCounter(i);
    setTimeout(playNext, Math.max(isSelftest ? 60 : 120, (step.delayMs || 1000) / speed));
  };
  setTimeout(playNext, 350);

  // manual stepping with arrow keys (pauses autoplay implicitly by racing it)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && i < steps.length) {
      runtime.applyMessages(stepMessages(steps[i++])); setCounter(i);
    } else if (e.key === 'r') {
      location.reload();
    }
  });
}

function setCounter(n) { if (counterEl) counterEl.textContent = `step ${n} / ${steps.length}`; }

// Offline composer: no server to forward to, so just echo the human's line into
// the ticker (demonstrates the always-available input affordance).
const composerEl = document.getElementById('composer');
const composerInput = document.getElementById('composer-input');
if (composerEl) {
  composerEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = composerInput.value.trim();
    if (!text) return;
    composerInput.value = '';
    const line = document.createElement('span');
    line.className = 'm-ticker-line you in';
    line.textContent = `you: ${text}`;
    tickerEl.replaceChildren(line);
  });
}
