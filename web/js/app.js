// app.js — live transport: wires the SSE stream + page chrome to the Runtime.
// The two pieces of UI that live OUTSIDE the surface are owned here: the title
// bar and the one-line "agent voice" ticker (the sole vestige of chat — a status
// line, never a transcript).

import { Runtime } from './runtime.js';

const appEl = document.getElementById('app');
const titleEl = document.getElementById('title');
const tickerEl = document.getElementById('ticker');
const statusEl = document.getElementById('status');

const runtime = new Runtime(document.getElementById('stage'), {
  onChrome: applyChrome,
  onNarrate: narrate,
  onAction: sendAction,
});

function applyChrome(surface) {
  const p = surface.props || {};
  if (p.title) { titleEl.textContent = p.title; document.title = `Morph · ${p.title}`; }
  if (p.accent) {
    if (/^(#|rgb|hsl)/i.test(p.accent)) appEl.style.setProperty('--app-accent', p.accent);
    else { appEl.style.removeProperty('--app-accent'); appEl.dataset.accent = p.accent; }
  }
  if (p.theme) appEl.dataset.theme = p.theme;
}

function narrate(text) {
  if (!text) return;
  const line = document.createElement('span');
  line.className = 'm-ticker-line';
  line.textContent = text;
  tickerEl.replaceChildren(line);
  void line.offsetWidth; // restart entrance animation
  line.classList.add('in');
}

function sendAction(payload) {
  fetch('/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => { /* static preview / offline: ignore */ });
}

// --- composer: the always-available primary human→agent channel -----------
const composerEl = document.getElementById('composer');
const composerInput = document.getElementById('composer-input');

function echoUser(text) {
  // The human's own line gets a brief, distinct flash in the ticker — enough
  // feedback that it was sent, without resurrecting a scrolling transcript.
  const line = document.createElement('span');
  line.className = 'm-ticker-line you in';
  line.textContent = `you: ${text}`;
  tickerEl.replaceChildren(line);
}

function sendUserMessage(text) {
  echoUser(text);
  // Transport seam: today this hits the Morph relay's /input; once wired to
  // aios, /input forwards the text to the live session as a user-channel message.
  fetch('/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'input', text }),
  }).catch(() => { /* offline: ignore */ });
}

if (composerEl) {
  composerEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = composerInput.value.trim();
    if (!text) return;
    composerInput.value = '';
    sendUserMessage(text);
  });
}

function setStatus(s) { if (statusEl) statusEl.dataset.state = s; }

function connect() {
  setStatus('connecting');
  const es = new EventSource('/events');
  es.onopen = () => setStatus('live');
  es.onerror = () => setStatus('reconnecting'); // EventSource auto-reconnects
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    runtime.handle(msg);
  };
}

// Escape hatch for offline/headless use.
window.MORPH = {
  runtime,
  play(messages) { for (const m of messages) runtime.handle(m); },
  reset() { runtime.reset(); },
  get surface() { return runtime.state.surface; },
};

connect();
