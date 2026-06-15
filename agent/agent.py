#!/usr/bin/env python3
"""agent.py — an OPTIONAL live Claude agent that drives a Morph dashboard.

Morph replaces the chat transcript with a living, animated dashboard. Instead of
writing paragraphs, the agent "speaks Morph": it streams small wire messages
(SPEC.md §2) that reshape a flat, stable-ID surface, and the browser animates
every diff for free. This script turns a natural-language goal into that stream
using the Anthropic Messages API and a single tool, `emit(messages[])`.

It is STDLIB ONLY — it talks to the API over urllib.request and implements the
tool_use / tool_result agentic loop by hand, so there is no dependency on the
`anthropic` package. It is entirely optional: the scripted scenario drives the
same dashboard with no API key at all.

Run example
-----------
    python3 server.py --mode idle                                              # terminal 1
    python3 agent/agent.py --goal "Compare Postgres vs SQLite for a small SaaS"  # terminal 2

Configuration (environment)
---------------------------
    ANTHROPIC_API_KEY    required — your Anthropic API key.
    ANTHROPIC_BASE_URL   optional — defaults to https://api.anthropic.com.
                         Honored as-is (here it points at a proxy).
    ANTHROPIC_MODEL      optional — defaults to "claude-opus-4-8".

Degradation
-----------
    No ANTHROPIC_API_KEY (or an API failure) prints a friendly explanation —
    how to set the key, and that the scripted scenario works with no key —
    instead of a raw traceback. The missing-key case never crashes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

DEFAULT_BASE_URL = "https://api.anthropic.com"
DEFAULT_MODEL = "claude-opus-4-8"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_SERVER = "http://localhost:8765"
DEFAULT_MAX_TURNS = 12

# How long to wait on network calls (seconds). The Messages API can think for a
# while; the emit POST to the local server is fast.
API_TIMEOUT = 600
EMIT_TIMEOUT = 30


# --------------------------------------------------------------------------- #
# System prompt — teaches the model to "speak Morph"
# --------------------------------------------------------------------------- #

SYSTEM_PROMPT = """\
You drive a live, animated DASHBOARD called Morph. There is no chat transcript:
the dashboard IS your reply to the user. You communicate by continuously
reshaping a flat list of stable-ID components, and the browser animates every
change for free. Speak through the dashboard, not through prose.

THE MODEL
A Surface is one dashboard: { root, components, data, props }.
- components is a FLAT map id -> node (an adjacency list, NOT a nested tree).
  A node is { id, type, props?, children?, layout? }. children is an ORDERED
  list of child ids (order matters — reordering animates). layout carries
  per-node hints to the parent, e.g. { "span": 2 } inside a grid.
- data is a separate JSON model. Components BIND into it by JSON Pointer, so a
  number ticking up is a tiny data patch, never a component rebuild.
- props is decoupled branding: { title?, accent?, theme? }.

BINDINGS (any prop value may be a literal OR a binding object)
- { "$bind": "/ptr", "format": "int|number|percent|percent1|usd|compact|duration", "tween": true }
  reads one JSON Pointer. tween:true makes numeric changes count up smoothly.
- { "$tpl": "Found {/a} of {/b}" } interpolates pointers into a string.

THE 6 WIRE MESSAGE TYPES (you emit these as JSON objects)
1. createSurface    { "type":"createSurface", "surface": { root, components, data, props } }
                    Instantiate or replace the WHOLE surface in one message.
2. updateComponents { "type":"updateComponents", "components": { id: node, ... }, "remove": [ids] }
                    Upsert structural nodes; delete listed ids. Change a parent's
                    children to reparent/reorder/move a node.
3. updateDataModel  { "type":"updateDataModel", "patch": { "/json/pointer": value, ... } }
                    Patch the data model. Drives bound re-render + number tweens.
                    An absent/undefined leaf deletes it.
4. setSurfaceProps  { "type":"setSurfaceProps", "props": { "title?":..., "accent?":..., "theme?":... } }
5. narrate          { "type":"narrate", "text": "Reading 12 sources..." }
                    ONE short line of agent "voice" in a thin ticker — the only
                    vestige of chat. A status line, not a paragraph.
6. (ping is keep-alive; you never need it.)

COMPONENT CATALOG (the trusted allow-list — use ONLY these types and props)
Containers/layout:
  surface(root frame, one only) | grid(cols 1-4, gap; child layout.span widens)
  | row(gap, align, wrap) | stack(gap, align) | section(title, subtitle, icon)
  | board(holds columns) | column(title, accent, count; holds cards — cards move
  BETWEEN columns).
Display:
  card(title, subtitle, icon, accent, footer, elevated) | heading(text, level 1-3, kicker)
  | text(text, muted, size) | markdown(text) | metric(label, value, delta,
  deltaDir up|down, spark number[], accent; value honors tween)
  | stat-group(row of metrics) | progress(value 0-1, label, accent)
  | kpi-ring(value 0-1, label, accent) | badge(text, tone info|success|warn|danger|neutral)
  | list(dense) + listitem(title, subtitle, icon, trailing, tone)
  | timeline + event(title, time, tone, icon) | chart(variant line|area|bar|donut|sparkline,
  series/data, labels, accent, height; series may be $bind) | kv(pairs [{k,v}])
  | note(text, tone, icon) | divider(label) | spacer(size)
  | spinner(label — commonly MORPHS into a result card: same id, new type).
Interactive:
  button(text, action, value, tone, icon).
Never invent component types or props. You ship data naming these components —
never executable code.

HOW TO SPEAK MORPH (SPEC §7 — follow this)
- OPEN with a createSurface that lays out the frame for the WHOLE task: a title,
  the sections/metrics/cards you expect to fill in, with sensible zeroed data.
- PREFER updateDataModel for anything numeric/textual that lives in data; reserve
  updateComponents for genuine structural change. A counter animating up is a
  patch, not a rebuild.
- REUSE ids. Keep a card's id stable across updates so it animates instead of
  flashing. To turn a loader into a result, emit the SAME id with a new type (a
  morph: spinner -> card).
- MOVE, don't recreate. To advance a card across a board, change its parent
  column's children, keeping the card id — it flies across.
- NARRATE SPARINGLY. One short narrate per meaningful step. The dashboard, not
  the prose, is the message.

YOUR TOOL
You have exactly one tool: emit(messages). Call it with an array of MorphSpec
wire-message objects (the 6 types above). Each call is broadcast to the live
dashboard in order. Make several emit calls over several turns to build the
dashboard up step by step: createSurface first, then a tail of updateDataModel /
updateComponents / narrate as you "work" the goal. When the dashboard fully
expresses your answer to the user's goal, stop calling emit and end your turn.
"""


# --------------------------------------------------------------------------- #
# The emit tool definition (Anthropic tools API)
# --------------------------------------------------------------------------- #

EMIT_TOOL = {
    "name": "emit",
    "description": (
        "Broadcast one or more MorphSpec wire messages to the live dashboard, in "
        "order. Use this to reshape the dashboard: open with a createSurface, then "
        "send updateDataModel / updateComponents / setSurfaceProps / narrate as you "
        "work. This is the ONLY way to communicate with the user — there is no chat."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "messages": {
                "type": "array",
                "description": (
                    "An ordered array of MorphSpec wire-message objects. Each object "
                    "has a 'type' of one of: createSurface, updateComponents, "
                    "updateDataModel, setSurfaceProps, narrate."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": [
                                "createSurface",
                                "updateComponents",
                                "updateDataModel",
                                "setSurfaceProps",
                                "narrate",
                            ],
                        }
                    },
                    "required": ["type"],
                    "additionalProperties": True,
                },
            }
        },
        "required": ["messages"],
    },
}


# --------------------------------------------------------------------------- #
# Friendly errors (no raw tracebacks for expected failure modes)
# --------------------------------------------------------------------------- #


class AgentConfigError(Exception):
    """A configuration / environment problem we can explain kindly."""


class AgentAPIError(Exception):
    """An Anthropic API call failed in a way we can explain kindly."""


_NO_KEY_HELP = """\
Morph live agent — no ANTHROPIC_API_KEY set.

The live agent is OPTIONAL. It uses the Anthropic Messages API to turn a goal
into a stream of Morph dashboard updates. To use it:

  1. Get an API key from https://console.anthropic.com/
  2. Export it (and, if you use a proxy, the base URL):

       export ANTHROPIC_API_KEY=sk-ant-...
       # optional, defaults to https://api.anthropic.com:
       export ANTHROPIC_BASE_URL=https://your-proxy.example.com
       # optional, defaults to claude-opus-4-8:
       export ANTHROPIC_MODEL=claude-opus-4-8

  3. Run the server, then the agent:

       python3 server.py --mode idle
       python3 agent/agent.py --goal "Compare Postgres vs SQLite for a small SaaS"

No key? No problem — the scripted scenario drives the same dashboard with NO API
key. Just run the server in its scripted mode (see server.py / SPEC.md).
"""


# --------------------------------------------------------------------------- #
# HTTP helpers (stdlib only)
# --------------------------------------------------------------------------- #


def _post_json(url, payload, headers, timeout):
    """POST a JSON body and return the decoded JSON response.

    Raises urllib.error.* on transport/HTTP failures so callers can map them to
    friendly messages.
    """
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("content-type", "application/json")
    for key, value in headers.items():
        req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body) if body else {}


def call_messages_api(base_url, api_key, model, messages):
    """One call to POST /v1/messages with the emit tool. Returns the raw response dict."""
    url = base_url.rstrip("/") + "/v1/messages"
    payload = {
        "model": model,
        "max_tokens": 8000,
        "system": SYSTEM_PROMPT,
        "tools": [EMIT_TOOL],
        "messages": messages,
    }
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
    }
    try:
        return _post_json(url, payload, headers, API_TIMEOUT)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            pass
        hint = ""
        if exc.code in (401, 403):
            hint = " — check that ANTHROPIC_API_KEY is valid and has access to the model."
        elif exc.code == 404:
            hint = f" — check ANTHROPIC_MODEL ({model!r}) and ANTHROPIC_BASE_URL ({base_url!r})."
        elif exc.code == 429:
            hint = " — rate limited; wait a moment and try again."
        raise AgentAPIError(
            f"Anthropic API returned HTTP {exc.code}{hint}\n{detail}".rstrip()
        ) from exc
    except urllib.error.URLError as exc:
        raise AgentAPIError(
            f"Could not reach the Anthropic API at {base_url!r}: {exc.reason}.\n"
            "Check your network connection and ANTHROPIC_BASE_URL."
        ) from exc


def post_emit(server, wire_messages):
    """POST emitted wire messages to {server}/emit so the dashboard updates.

    Returns a short human-readable status string for the tool_result. Never
    raises — an emit failure is reported back to the model so it can continue.
    """
    url = server.rstrip("/") + "/emit"
    try:
        # Send a bare array — the wire shape /emit expects. (The server also
        # tolerates a {"messages":[…]} envelope, but the array is the contract.)
        _post_json(url, wire_messages, {}, EMIT_TIMEOUT)
        return f"Broadcast {len(wire_messages)} message(s) to the dashboard."
    except urllib.error.HTTPError as exc:
        return f"Error: dashboard server returned HTTP {exc.code} from {url}."
    except urllib.error.URLError as exc:
        return (
            f"Error: could not reach the dashboard server at {url} ({exc.reason}). "
            "Is `python3 server.py` running?"
        )
    except Exception as exc:  # pragma: no cover - defensive
        return f"Error broadcasting to the dashboard: {exc}"


# --------------------------------------------------------------------------- #
# The agentic loop
# --------------------------------------------------------------------------- #


def run(goal, server=DEFAULT_SERVER, max_turns=DEFAULT_MAX_TURNS):
    """Drive the Morph dashboard toward `goal`. Importable entrypoint for server.py.

    Loops: call the Messages API; whenever the model calls emit, POST those
    messages to {server}/emit and feed a tool_result back so it continues; stop
    when the model stops calling emit (end_turn) or max_turns is reached.

    Raises AgentConfigError if ANTHROPIC_API_KEY is missing, and AgentAPIError on
    API failure. The CLI (main) turns these into friendly messages; callers that
    import run() can catch them.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise AgentConfigError(_NO_KEY_HELP)

    base_url = os.environ.get("ANTHROPIC_BASE_URL", "").strip() or DEFAULT_BASE_URL
    model = os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_MODEL

    print(f"[morph-agent] goal: {goal}")
    print(f"[morph-agent] model={model} base_url={base_url} server={server}")
    print(f"[morph-agent] driving the dashboard (max {max_turns} turns)...\n")

    messages = [
        {
            "role": "user",
            "content": (
                f"The user's goal: {goal}\n\n"
                "Build and progressively reshape the Morph dashboard to express your "
                "answer. Open with a createSurface, then emit updates as you work. "
                "When the dashboard fully conveys the answer, stop."
            ),
        }
    ]

    total_emitted = 0

    for turn in range(1, max_turns + 1):
        response = call_messages_api(base_url, api_key, model, messages)

        content = response.get("content", []) or []
        stop_reason = response.get("stop_reason")

        # Surface any narration text the model wrote alongside tool calls.
        for block in content:
            if block.get("type") == "text":
                text = (block.get("text") or "").strip()
                if text:
                    print(f"[morph-agent] (turn {turn}) {text}")

        tool_uses = [b for b in content if b.get("type") == "tool_use" and b.get("name") == "emit"]

        # The model stopped calling emit — it considers the dashboard complete.
        if not tool_uses:
            print(f"\n[morph-agent] done (stop_reason={stop_reason}). "
                  f"Emitted {total_emitted} wire message(s) across {turn} turn(s).")
            return total_emitted

        # Echo the assistant turn (full content, including tool_use blocks) back.
        messages.append({"role": "assistant", "content": content})

        # Execute every emit call and collect a tool_result for each.
        tool_results = []
        for tool_use in tool_uses:
            tool_input = tool_use.get("input") or {}
            wire_messages = tool_input.get("messages") or []
            status = post_emit(server, wire_messages)
            total_emitted += len(wire_messages)

            kinds = ", ".join(m.get("type", "?") for m in wire_messages) or "(none)"
            print(f"[morph-agent] (turn {turn}) emit -> {len(wire_messages)} msg [{kinds}] :: {status}")

            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use.get("id"),
                    "content": status,
                    "is_error": status.startswith("Error"),
                }
            )

        messages.append({"role": "user", "content": tool_results})

    print(f"\n[morph-agent] reached max_turns ({max_turns}). "
          f"Emitted {total_emitted} wire message(s).")
    return total_emitted


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="agent.py",
        description="Drive a live Morph dashboard from a natural-language goal.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--goal",
        required=True,
        help='The natural-language goal, e.g. "Compare Postgres vs SQLite for a small SaaS".',
    )
    parser.add_argument(
        "--server",
        default=DEFAULT_SERVER,
        help=f"Morph dashboard server base URL (default: {DEFAULT_SERVER}).",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=DEFAULT_MAX_TURNS,
        help=f"Maximum agentic turns before stopping (default: {DEFAULT_MAX_TURNS}).",
    )
    args = parser.parse_args(argv)

    try:
        run(args.goal, server=args.server, max_turns=args.max_turns)
    except AgentConfigError as exc:
        # Missing-key (and similar) case: friendly help, clean exit, no traceback.
        print(str(exc), file=sys.stderr)
        return 2
    except AgentAPIError as exc:
        print(f"[morph-agent] the live agent could not run:\n{exc}\n", file=sys.stderr)
        print(
            "Tip: the scripted scenario drives the same dashboard with NO API key.",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        print("\n[morph-agent] interrupted.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
