# MorphSpec — a declarative agent‑UI language

> An agent communicates by continuously **reshaping a living dashboard**, not by
> appending paragraphs to a transcript. Because the UI is a flat list of
> stable‑ID components, element identity survives every change — which is exactly
> what the browser's View Transitions API needs to **animate the diff for free.**

This document is the normative contract. The browser runtime, the Python server,
the scripted scenario, and the live Claude agent all speak exactly this format.
The shared helpers live in [`web/js/protocol.js`](web/js/protocol.js).

---

## 1. The model: Surface + Data + adjacency list

A **Surface** is one dashboard:

```jsonc
{
  "root": "root",                 // id of the root component
  "components": {                 // FLAT map id -> node (adjacency list, not a tree)
    "root":  { "id": "root",  "type": "surface", "children": ["hero", "grid"] },
    "hero":  { "id": "hero",  "type": "heading", "props": { "text": "Research Agent" } },
    "grid":  { "id": "grid",  "type": "grid", "props": { "cols": 3 }, "children": ["m1"] },
    "m1":    { "id": "m1",    "type": "metric",
               "props": { "label": "Sources", "value": { "$bind": "/metrics/sources", "tween": true } } }
  },
  "data": { "metrics": { "sources": 0 } },   // the separated data model
  "props": { "title": "Research", "accent": "violet", "theme": "dark" }
}
```

Three deliberate choices, all from the 2026 state of the art:

1. **Adjacency list, not nested tree.** Every node is addressable by a stable
   `id`; parents reference children by id in `children`. Streaming/diffing a flat
   map is trivial and identity is explicit. (This is A2UI's core representation.)
2. **Structure is separated from data.** Components *bind* into a JSON `data`
   model via JSON Pointer paths. Structural churn (new cards) and value churn (a
   number ticking up) are different message types — so a counter animating up is a
   tiny `updateDataModel`, never a component rebuild.
3. **Stable IDs are load‑bearing.** They are how the renderer matches a component
   across two states, and therefore how it knows a thing *moved* vs. *was
   replaced* — the foundation of automatic animated transitions.

---

## 2. The wire protocol (messages)

The agent → client channel is a stream of JSON messages (one per SSE `data:`
line). The client keeps the authoritative surface, applies each message, then
animates the resulting diff.

| `type`             | Payload                                          | Meaning |
|--------------------|--------------------------------------------------|---------|
| `createSurface`    | `{ surface: {root, components, data, props} }`   | Instantiate / replace the whole surface in one message. |
| `updateComponents` | `{ components: { id: node, … }, remove: [id] }`  | Upsert structural nodes; delete listed ids. Changing a parent's `children` is how you reparent/reorder. |
| `updateDataModel`  | `{ patch: { "/json/pointer": value, … } }`       | Patch the data model. `undefined`/absent leaf deletes. Drives bound re‑render + number tweens. |
| `setSurfaceProps`  | `{ props: { title?, accent?, theme? } }`         | Decoupled branding (no theme colors hardcoded in components). |
| `narrate`          | `{ text: "Reading 12 sources…" }`                | One line of agent "voice", shown in a thin ticker. This is the *only* vestige of chat — a status line, not a transcript. |
| `action`           | `{ action, componentId, value }`                 | **client → server.** Emitted by interactive components (buttons). |
| `ping`             | `{}`                                             | Keep‑alive; ignored by the renderer. |

A typical session: one `createSurface`, then a long tail of `updateComponents` /
`updateDataModel` / `narrate` as the agent works.

---

## 3. Bindings

Any prop value may be a literal **or** a binding object:

```jsonc
"value": { "$bind": "/metrics/sources", "format": "int", "tween": true }
"label": { "$tpl": "Found {/metrics/sources} of {/metrics/total}" }
```

- **`$bind`** reads a single JSON Pointer. `format` ∈ `int | number | percent |
  percent1 | usd | compact | duration`. `tween: true` ⇒ numeric changes count up
  smoothly instead of swapping.
- **`$tpl`** interpolates `{/pointer}` occurrences into a string.

Resolution and formatting are implemented once in `protocol.js`
(`resolve`, `rawBound`, `isTweenBind`, `formatValue`).

---

## 4. Component catalog (the "Basic" catalog)

Every node is `{ id, type, props?, children?, layout? }`. `children` is an
**ordered** list of ids (order matters — reordering animates). `layout` carries
per‑node hints to the parent (e.g. `{ "span": 2 }` in a grid).

### Containers / layout
| type      | key props | children | notes |
|-----------|-----------|----------|-------|
| `surface` | —         | yes      | root frame; exactly one per surface. |
| `grid`    | `cols` (1–4), `gap` | yes | responsive grid; child `layout.span` widens a cell. |
| `row`     | `gap`, `align`, `wrap` | yes | horizontal flex. |
| `stack`   | `gap`, `align` | yes | vertical flex. |
| `section` | `title`, `subtitle`, `icon` | yes | titled region. |
| `board`   | —         | `column`s | kanban board (horizontal). |
| `column`  | `title`, `accent`, `count` | `card`s | kanban column; cards move *between* columns. |

### Display
| type        | key props | notes |
|-------------|-----------|-------|
| `card`      | `title`, `subtitle`, `icon`, `accent`, `footer`, `elevated` | titled container; holds children. |
| `heading`   | `text`, `level` (1–3), `kicker` | |
| `text`      | `text`, `muted`, `size` | plain prose. |
| `markdown`  | `text` | minimal markdown (bold/italic/code/lists/links). |
| `metric`    | `label`, `value`, `delta`, `deltaDir` (up/down), `spark` (number[]), `accent` | big number; `value` honors `tween`. |
| `stat-group`| —        | row of `metric`s (children). |
| `progress`  | `value` (0–1), `label`, `accent` | animated bar width. |
| `kpi-ring`  | `value` (0–1), `label`, `accent` | donut progress ring. |
| `badge`     | `text`, `tone` (`info\|success\|warn\|danger\|neutral`) | tone color transitions when it changes. |
| `list`      | `dense` | vertical list of `listitem`s; reorder animates. |
| `listitem`  | `title`, `subtitle`, `icon`, `trailing`, `tone` | |
| `timeline`  | —        | vertical timeline of `event`s; new events slide in at top. |
| `event`     | `title`, `time`, `tone`, `icon` | |
| `chart`     | `variant` (`line\|area\|bar\|donut\|sparkline`), `series`/`data`, `labels`, `accent`, `height` | SVG, animates on data change. `series` may be `$bind`. |
| `kv`        | `pairs` ([{k,v}]) | key/value table. |
| `note`      | `text`, `tone`, `icon` | callout. |
| `divider`   | `label` | |
| `spacer`    | `size` | |
| `spinner`   | `label` | loading; commonly *morphs* into a result card (same id, new type). |

### Interactive
| type     | key props | emits |
|----------|-----------|-------|
| `button` | `text`, `action`, `value`, `tone`, `icon` | `action` message `{action, componentId, value}` |

> The catalog is the renderer's **trusted** allow‑list. The agent never ships
> executable code — only data naming these components. That is the safety
> property that code‑gen approaches give up.

---

## 5. Animated transitions — the staging policy (the novel bit)

The protocol carries **no** motion primitives (deliberately — like A2UI). Motion
is *derived* by the client from the diff between two stable‑ID states. Given the
previous and next surface, the **stager** ([`web/js/stager.js`](web/js/stager.js))
classifies every id and emits a transition plan:

| class        | trigger | how it animates |
|--------------|---------|-----------------|
| `entered`    | id in next only | CSS slide+fade+scale‑in on `::view-transition-new`, **staggered** by sibling order. |
| `exited`     | id in prev only | fade+scale‑out on `::view-transition-old`. |
| `moved`      | id persists, parent or sibling‑index changed | View Transitions FLIPs position automatically (the kanban‑card‑flies‑between‑columns effect). |
| `resized`    | id persists, same parent, box will change (layout reflow) | VT tweens size/position. |
| `morphed`    | id persists, `type` changed | content cross‑fades while the box morphs (spinner → result card). |
| `valueTween` | a `tween` binding's number changed | **not** a view transition — a JS count‑up, because cross‑fading digits looks bad. |

Two policies make this fast and correct, addressing the documented View
Transitions gotchas:

1. **Name only what changed.** `view-transition-name: vt-<id>` is assigned *only*
   to elements in the plan, then cleared after the transition. Unchanged elements
   stay nameless and the root crossfade is disabled, so steady state has zero VT
   cost and there is no "every element must be unique" explosion. Names derive
   from stable ids, guaranteeing uniqueness.
2. **Cap the animated set.** If a single diff would animate more than
   `MAX_NAMED` (50) elements (e.g. a giant reflow), the overflow falls back to an
   instant swap and the cap is logged — never a silent truncation.

`prefers-reduced-motion` short‑circuits the whole path: the DOM updates directly,
tweens jump to their final value.

See [`web/js/stager.js`](web/js/stager.js) for the implementation and
[`tests/stager.test.mjs`](tests/stager.test.mjs) for the behavioral spec.

---

## 6. Example: the smallest useful surface

```json
{ "type": "createSurface", "surface": {
  "root": "root",
  "components": {
    "root": { "id": "root", "type": "surface", "children": ["h", "s"] },
    "h":    { "id": "h", "type": "heading", "props": { "text": "Hello", "kicker": "Morph" } },
    "s":    { "id": "s", "type": "metric",
              "props": { "label": "Progress", "value": { "$bind": "/p", "format": "percent", "tween": true } } }
  },
  "data": { "p": 0 },
  "props": { "title": "Demo", "accent": "violet" }
}}
```

Then `{ "type": "updateDataModel", "patch": { "/p": 0.75 } }` makes the metric
count up to 75% with no rebuild.

---

## 7. How an agent should "speak Morph"

A live agent is given this spec and a single tool, `emit(messages[])`. Guidance
that the runtime's system prompt encodes:

- **Open with a `createSurface`** that lays out the frame for the whole task.
- **Prefer `updateDataModel`** for anything numeric/textual that lives in `data`;
  reserve `updateComponents` for genuine structural change.
- **Reuse ids.** Keep a card's id stable across updates so it animates instead of
  flashing. To turn a loader into a result, send the same id with a new `type`
  (a morph).
- **Move, don't recreate.** To advance a task across a kanban board, change its
  parent column's `children`, keeping the card id — it will fly across.
- **Narrate sparingly.** One short `narrate` per meaningful step; the dashboard,
  not the prose, is the message.
