#!/usr/bin/env python3
"""
Morph relay server — a stdlib-only HTTP + SSE backend for the MorphSpec runtime.

Morph is a declarative agent-UI runtime: an agent communicates by reshaping a
live, animated dashboard ("Surface") instead of appending to a chat transcript.
This server is a *dumb, language-agnostic relay*. It owns no render semantics —
the browser does. The server only:

  * serves the static web/ app,
  * holds a small message_log (the replayable state of the current surface),
  * fans messages out to every connected browser over Server-Sent Events,
  * accepts new messages (POST /emit) and user interactions (POST /action),
  * and, optionally, plays a scripted scenario or drives a live agent.

The wire format is defined by SPEC.md and web/js/protocol.js — this file does
not parse or validate message contents beyond peeking at `type` for log
compaction. Anything that is valid JSON gets relayed verbatim.

------------------------------------------------------------------------------
USAGE
------------------------------------------------------------------------------
  python3 server.py                       # scenario mode, ./scenario.json, :8765
  python3 server.py --port 9000           # different port
  python3 server.py --scenario demo.json  # a different scenario file
  python3 server.py --mode idle           # just serve, broadcast nothing
  python3 server.py --mode agent --goal "Research the 2026 GPU market"

Then open the printed URL (http://localhost:PORT) in a browser.

ENDPOINTS
  GET  /          -> web/index.html
  GET  /<path>    -> static file under web/ (path-traversal-safe)
  GET  /events    -> text/event-stream; replays message_log, then streams live
  POST /emit      -> append + broadcast a message (or array of messages)
  POST /action    -> record a client interaction; broadcast a narrate ack

Modes:
  scenario  (default) play scenario.json once the first browser connects
  idle                 serve only; emit nothing on its own
  agent                run agent/agent.py's entrypoint with --goal, relaying
                       everything it emits through the same broadcast path
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------- #
# Paths & constants
# --------------------------------------------------------------------------- #

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT_DIR, "web")

PING_INTERVAL_S = 15.0          # SSE keep-alive cadence
SSE_QUEUE_GET_TIMEOUT_S = 1.0   # how often the SSE loop wakes to check pings
LOG_CAP = 4000                  # bound message_log growth within a single surface
CLIENT_QUEUE_MAXSIZE = 8192     # per-client backlog (>= LOG_CAP so prefill never trims)
MAX_BODY_BYTES = 4 * 1024 * 1024  # reject oversized POST bodies (DoS guard)

# Map file extension -> Content-Type. .js MUST be text/javascript so the browser
# accepts it as an ES module.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


# --------------------------------------------------------------------------- #
# Broadcast hub: the shared, thread-safe state of the relay
# --------------------------------------------------------------------------- #


def _fit(log, cap: int) -> list:
    """Return at most `cap` log entries, always preserving the head createSurface
    (the keystone every later message depends on) plus the newest entries."""
    log = list(log)
    if len(log) <= cap:
        return log
    if cap >= 1 and log and isinstance(log[0], dict) and log[0].get("type") == "createSurface":
        return [log[0]] + log[-(cap - 1):] if cap > 1 else [log[0]]
    return log[-cap:]


class Hub:
    """Holds the replayable message log and the set of connected SSE clients.

    A single instance is shared by every request handler thread. All mutation
    of `message_log` and `clients` is guarded by `lock`. Each connected browser
    owns a `queue.Queue`; `broadcast` pushes onto every queue, and each
    /events handler drains its own queue to the socket.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.message_log: list[dict] = []
        self.clients: set[queue.Queue] = set()
        # Optional callable(text) wired by the aios bridge to forward the human's
        # composer input to the live session. Unset => /input just acks.
        self.input_sink = None

    # -- client registration -------------------------------------------------

    def subscribe(self) -> queue.Queue:
        """Register a new client. Returns a queue prefilled with the current
        log so a late joiner reconstructs the full state with zero delay.

        Prefill is bounded by the queue size and never raises: `_fit` keeps the
        head `createSurface` (the keystone every later message depends on) plus
        the newest entries that fit. Prefill + registration happen under one lock
        so no broadcast can slip between them and be missed."""
        q: queue.Queue = queue.Queue(maxsize=CLIENT_QUEUE_MAXSIZE)
        with self.lock:
            for msg in _fit(self.message_log, CLIENT_QUEUE_MAXSIZE):
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    break
            self.clients.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(q)

    def client_count(self) -> int:
        with self.lock:
            return len(self.clients)

    def snapshot(self) -> list:
        """A copy of the current message log (for GET /log inspection)."""
        with self.lock:
            return list(self.message_log)

    # -- broadcasting --------------------------------------------------------

    def broadcast(self, msg: dict) -> None:
        """Append `msg` to the log (compacting on createSurface) and enqueue it
        for every connected client."""
        with self.lock:
            # Compaction: a fresh surface invalidates all prior history, so the
            # log never grows without bound across a long session.
            if isinstance(msg, dict) and msg.get("type") == "createSurface":
                self.message_log.clear()
            self.message_log.append(msg)
            # Cap within a single surface too, so a long tail of updates can't grow
            # unbounded. Always preserve the head createSurface; drop the OLDEST
            # updates (latest patch/upsert for a given id/pointer wins anyway).
            self._cap_log_locked()
            targets = list(self.clients)

        for q in targets:
            self._offer(q, msg)

    def _cap_log_locked(self) -> None:
        log = self.message_log
        if len(log) <= LOG_CAP:
            return
        head_is_surface = bool(log) and isinstance(log[0], dict) and log[0].get("type") == "createSurface"
        if head_is_surface:
            # keep log[0], drop oldest updates after it
            del log[1:len(log) - LOG_CAP + 1]
        else:
            del log[0:len(log) - LOG_CAP]

    def push_live(self, msg: dict) -> None:
        """Enqueue `msg` to live clients WITHOUT logging it. Used for transient
        control frames (e.g. keep-alive pings) that late joiners shouldn't replay."""
        with self.lock:
            targets = list(self.clients)
        for q in targets:
            self._offer(q, msg)

    def _offer(self, q: queue.Queue, msg: dict) -> None:
        """Enqueue without blocking the broadcaster. If a slow client's queue is
        full, the client has fallen behind: rather than surgically drop one frame
        (which would evict the keystone createSurface and leave the client applying
        updates against an empty surface), drain and re-seed from a consistent base
        — the current log, which begins with the createSurface."""
        try:
            q.put_nowait(msg)
        except queue.Full:
            self._reseed_locked_safe(q)
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass

    def _reseed_locked_safe(self, q: queue.Queue) -> None:
        try:
            while True:
                q.get_nowait()
        except queue.Empty:
            pass
        with self.lock:
            seed = _fit(self.message_log, CLIENT_QUEUE_MAXSIZE - 1)
        for m in seed:
            try:
                q.put_nowait(m)
            except queue.Full:
                break


# --------------------------------------------------------------------------- #
# Request handler
# --------------------------------------------------------------------------- #


class MorphHandler(BaseHTTPRequestHandler):
    # Injected on the server instance in main(); typed here for clarity.
    hub: Hub
    server_version = "MorphRelay/1.0"
    protocol_version = "HTTP/1.1"  # enables keep-alive; required for clean SSE

    # ---- low-noise logging -------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:
        # Quiet the default per-request stderr spam; we log the interesting bits
        # ourselves (actions, errors, scenario steps).
        return

    @property
    def hub(self) -> Hub:  # type: ignore[override]
        return self.server.hub  # type: ignore[attr-defined]

    # ---- dispatch ----------------------------------------------------------

    def do_GET(self) -> None:
        try:
            path = self.path.split("?", 1)[0].split("#", 1)[0]
            if path == "/events":
                self.handle_events()
            elif path == "/log":
                # Debug/inspection: the current message log as a JSON array. Lets
                # tools reconstruct the latest surface without consuming SSE.
                self.send_json(HTTPStatus.OK, self.hub.snapshot())
            elif path == "/scenario.json":
                # The scenario lives at the project root, not under web/; expose it
                # so the offline preview (web/preview.html) can fetch it directly.
                self.serve_scenario()
            elif path == "/" or path == "":
                self.serve_static("index.html")
            else:
                self.serve_static(path.lstrip("/"))
        except (BrokenPipeError, ConnectionResetError):
            pass  # client went away mid-response; nothing to do
        except Exception:
            self.report_error("GET", self.path)

    def do_POST(self) -> None:
        try:
            path = self.path.split("?", 1)[0]
            if path == "/emit":
                self.handle_emit()
            elif path == "/action":
                self.handle_action()
            elif path == "/input":
                self.handle_input()
            else:
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.report_error("POST", self.path)

    # ---- scenario ----------------------------------------------------------

    def serve_scenario(self) -> None:
        """Serve the configured scenario file (lives at the project root)."""
        path = getattr(self.server, "scenario_path", None) or os.path.join(ROOT_DIR, "scenario.json")
        if not os.path.isfile(path):
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "no scenario"})
            return
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "no scenario"})
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ---- static files ------------------------------------------------------

    def serve_static(self, rel_path: str) -> None:
        """Serve a file from WEB_DIR. Resolves and confirms the real path stays
        inside WEB_DIR to defeat path traversal (e.g. ../../etc/passwd)."""
        # Normalize and reject anything that escapes the web root.
        candidate = os.path.normpath(os.path.join(WEB_DIR, rel_path))
        web_root = os.path.realpath(WEB_DIR)
        real = os.path.realpath(candidate)
        if real != web_root and not real.startswith(web_root + os.sep):
            self.send_text(HTTPStatus.FORBIDDEN, "Forbidden")
            return

        if os.path.isdir(real):
            real = os.path.join(real, "index.html")

        if not os.path.isfile(real):
            # index.html (and other web assets) may be authored by sibling
            # agents after this server starts — fail soft with a clear message.
            if os.path.basename(real) == "index.html":
                self.send_text(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "web/index.html not found yet. The renderer app has not been "
                    "created. The relay is running; reload once web/index.html exists.",
                )
            else:
                self.send_text(HTTPStatus.NOT_FOUND, "Not found")
            return

        try:
            with open(real, "rb") as f:
                body = f.read()
        except OSError:
            self.send_text(HTTPStatus.NOT_FOUND, "Not found")
            return

        ext = os.path.splitext(real)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ---- SSE stream --------------------------------------------------------

    def handle_events(self) -> None:
        """Open an SSE stream: replay the log (already prefilled into the queue
        by subscribe()), then stream live frames, with a periodic ping."""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")  # disable proxy buffering
        self.end_headers()

        q = self.hub.subscribe()
        # Nudge the player: the scenario starts when the first client connects.
        self.server.on_client_connected()  # type: ignore[attr-defined]

        last_ping = time.monotonic()
        try:
            while True:
                try:
                    msg = q.get(timeout=SSE_QUEUE_GET_TIMEOUT_S)
                    self._write_sse(msg)
                except queue.Empty:
                    pass

                now = time.monotonic()
                if now - last_ping >= PING_INTERVAL_S:
                    self._write_sse({"type": "ping"})
                    last_ping = now
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client disconnected — normal
        finally:
            self.hub.unsubscribe(q)

    def _write_sse(self, msg: dict) -> None:
        """Write one SSE frame and flush. Raises on a dead socket so the caller
        can clean up the client."""
        frame = "data: " + json.dumps(msg, separators=(",", ":")) + "\n\n"
        self.wfile.write(frame.encode("utf-8"))
        self.wfile.flush()

    # ---- POST /emit --------------------------------------------------------

    def _origin_ok(self) -> bool:
        """Reject cross-origin browser writes (CSRF guard). Non-browser clients
        (the agent, curl) send no Origin and are allowed; a browser's Origin must
        match the Host it connected to."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        origin_host = origin.split("://", 1)[-1].split("/", 1)[0]
        return origin_host == self.headers.get("Host", "")

    def handle_emit(self) -> None:
        if not self._origin_ok():
            self.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "cross-origin"})
            return
        payload = self.read_json_body()
        if payload is None:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid JSON"})
            return

        # Accept three shapes: a bare wire message {type:…}, a bare array of them,
        # or an {"messages":[…]} envelope (what the live agent's emit tool sends).
        if isinstance(payload, dict) and isinstance(payload.get("messages"), list):
            messages = payload["messages"]
        elif isinstance(payload, list):
            messages = payload
        else:
            messages = [payload]
        count = 0
        for msg in messages:
            if isinstance(msg, dict):
                self.hub.broadcast(msg)
                count += 1
        self.send_json(HTTPStatus.OK, {"ok": True, "broadcast": count})

    # ---- POST /action ------------------------------------------------------

    def handle_action(self) -> None:
        if not self._origin_ok():
            self.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "cross-origin"})
            return
        payload = self.read_json_body()
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid JSON"})
            return

        action = payload.get("action")
        component_id = payload.get("componentId")
        value = payload.get("value")
        print(
            f"[action] action={action!r} componentId={component_id!r} value={value!r}",
            flush=True,
        )

        # Secondary channel: forward the widget click to the live session if one
        # is wired (phrased so the agent understands it). Otherwise just echo a
        # narrate ack so the UI shows feedback in standalone/demo mode.
        sink = getattr(self.hub, "input_sink", None)
        if callable(sink):
            parts = [f"[widget] {action or 'click'}"]
            if component_id:
                parts.append(f"on {component_id}")
            if value is not None:
                parts.append(f"= {value}")
            sink(" ".join(parts))
        else:
            ack = f"Received: {action}" if action else "Received interaction"
            self.hub.broadcast({"type": "narrate", "text": ack})
        self.send_json(HTTPStatus.OK, {"ok": True})

    # ---- POST /input -------------------------------------------------------

    def handle_input(self) -> None:
        """The always-available primary human→agent text channel.

        SEAM: when backed by a live aios session this forwards `text` to the
        session as a user-channel message; the agent then drives the dashboard.
        The hub exposes an optional `input_sink` callable for that wiring; until
        it's set we just acknowledge so the channel is demonstrably live."""
        if not self._origin_ok():
            self.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "cross-origin"})
            return
        payload = self.read_json_body()
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid JSON"})
            return
        text = (payload.get("text") or "").strip()
        if not text:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "empty text"})
            return
        print(f"[input] {text!r}", flush=True)
        sink = getattr(self.hub, "input_sink", None)
        if callable(sink):
            sink(text)  # forward to the live aios session
        else:
            self.hub.broadcast({"type": "narrate", "text": f"received: {text}"})
        self.send_json(HTTPStatus.OK, {"ok": True})

    # ---- helpers -----------------------------------------------------------

    def read_json_body(self):
        """Read and parse the request body as JSON. Returns the parsed value, or
        None on a missing/oversized/invalid body."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except (TypeError, ValueError):
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def send_json(self, status: HTTPStatus, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, status: HTTPStatus, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def report_error(self, method: str, path: str) -> None:
        """Log a per-connection error without bringing the server down, and try
        to send a 500 if the response hasn't started yet."""
        print(f"[error] {method} {path}\n{traceback.format_exc()}", flush=True)
        try:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "server error"}
            )
        except Exception:
            pass  # headers already sent or socket dead — give up quietly


# --------------------------------------------------------------------------- #
# Server with scenario/agent player wiring
# --------------------------------------------------------------------------- #


class MorphServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, hub: Hub, on_first_client, scenario_path=None) -> None:
        super().__init__(addr, handler)
        self.hub = hub
        self.scenario_path = scenario_path
        self._on_first_client = on_first_client
        self._first_client_fired = False
        self._first_client_lock = threading.Lock()

    def on_client_connected(self) -> None:
        """Called by each /events handler on connect. Fires the first-client
        callback exactly once (used to lazily start the scenario player)."""
        with self._first_client_lock:
            if self._first_client_fired:
                return
            self._first_client_fired = True
        if self._on_first_client is not None:
            self._on_first_client()


# --------------------------------------------------------------------------- #
# Scenario player
# --------------------------------------------------------------------------- #


def play_scenario(hub: Hub, scenario_path: str) -> None:
    """Play a scenario file once: for each step, wait delayMs, then broadcast the
    step's messages plus an optional narrate convenience message."""
    try:
        with open(scenario_path, "r", encoding="utf-8") as f:
            scenario = json.load(f)
    except FileNotFoundError:
        print(
            f"[scenario] {scenario_path} not found — nothing to play. "
            f"Relay is still serving; create the file and restart to play it.",
            flush=True,
        )
        return
    except (OSError, json.JSONDecodeError) as e:
        print(f"[scenario] failed to load {scenario_path}: {e}", flush=True)
        return

    title = scenario.get("title", "(untitled)")
    steps = scenario.get("steps", [])
    print(f"[scenario] playing {title!r} ({len(steps)} steps)", flush=True)

    for i, step in enumerate(steps):
        delay_ms = step.get("delayMs", 0) or 0
        if delay_ms:
            time.sleep(delay_ms / 1000.0)

        narrate = step.get("narrate")
        if narrate:
            hub.broadcast({"type": "narrate", "text": narrate})

        for msg in step.get("messages", []):
            if isinstance(msg, dict):
                hub.broadcast(msg)

        print(f"[scenario] step {i + 1}/{len(steps)} done", flush=True)

    print("[scenario] finished", flush=True)


# --------------------------------------------------------------------------- #
# Agent player
# --------------------------------------------------------------------------- #


def run_agent(hub: Hub, goal: str) -> None:
    """Import agent/agent.py and run its entrypoint, relaying every message it
    emits through the broadcast path. The agent calls an injected `emit(...)`.

    The agent module is expected to expose a `run(goal, emit)` callable, where
    `emit` accepts a single message dict or a list of message dicts. We tolerate
    a couple of common entrypoint names so the agent author has latitude."""

    def emit(messages) -> None:
        items = messages if isinstance(messages, list) else [messages]
        for msg in items:
            if isinstance(msg, dict):
                hub.broadcast(msg)

    agent_dir = os.path.join(ROOT_DIR, "agent")
    if agent_dir not in sys.path:
        sys.path.insert(0, agent_dir)

    try:
        import agent as agent_module  # type: ignore  # agent/agent.py
    except Exception as e:
        print(
            f"[agent] could not import agent/agent.py: {e}\n"
            f"        Relay is still serving; emit messages manually via POST /emit.",
            flush=True,
        )
        return

    entry = None
    for name in ("run", "main", "agent"):
        fn = getattr(agent_module, name, None)
        if callable(fn):
            entry = fn
            break
    if entry is None:
        print(
            "[agent] agent/agent.py exposes no callable run()/main()/agent() entrypoint.",
            flush=True,
        )
        return

    print(f"[agent] running entrypoint {entry.__name__}() with goal: {goal!r}", flush=True)
    try:
        entry(goal=goal, emit=emit)
    except TypeError:
        # Fall back to positional args if the signature differs.
        try:
            entry(goal, emit)
        except Exception:
            print(f"[agent] entrypoint raised:\n{traceback.format_exc()}", flush=True)
    except Exception:
        print(f"[agent] entrypoint raised:\n{traceback.format_exc()}", flush=True)


# --------------------------------------------------------------------------- #
# Banner & main
# --------------------------------------------------------------------------- #


def print_banner(port: int, mode: str, scenario_path: str, goal: str | None) -> None:
    url = f"http://localhost:{port}"
    line = "=" * 60
    print(line, flush=True)
    print("  Morph relay server", flush=True)
    print(f"  URL:      {url}", flush=True)
    print(f"  Mode:     {mode}", flush=True)
    if mode == "scenario":
        print(f"  Scenario: {scenario_path}", flush=True)
        print("  (scenario starts when the first browser connects)", flush=True)
    elif mode == "agent":
        print(f"  Goal:     {goal!r}", flush=True)
    print(f"  Open {url} in your browser.", flush=True)
    print(line, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Morph relay server (stdlib-only).")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on")
    parser.add_argument(
        "--host", default="127.0.0.1",
        help="interface to bind (default loopback; pass 0.0.0.0 to expose on the LAN)",
    )
    parser.add_argument(
        "--scenario",
        default=os.path.join(ROOT_DIR, "scenario.json"),
        help="path to the scenario file (scenario mode)",
    )
    parser.add_argument(
        "--mode",
        choices=["scenario", "idle", "agent", "aios"],
        default="scenario",
        help="scenario: play a script; idle: serve only; agent: run agent/agent.py; "
             "aios: bridge to a live aios session",
    )
    parser.add_argument("--goal", default=None, help="goal text for --mode agent")
    parser.add_argument("--aios-url", default=os.environ.get("AIOS_URL"),
                        help="aios base URL (--mode aios); defaults to $AIOS_URL")
    parser.add_argument("--aios-key", default=os.environ.get("AIOS_API_KEY"),
                        help="aios API key (--mode aios); defaults to $AIOS_API_KEY")
    parser.add_argument("--aios-session", default=os.environ.get("MORPH_AIOS_SESSION"),
                        help="aios session id (--mode aios); defaults to $MORPH_AIOS_SESSION")
    args = parser.parse_args()

    hub = Hub()

    # In scenario/agent mode, the player starts lazily on the first client so the
    # browser is connected (and ready to receive the createSurface) before step 1.
    def on_first_client() -> None:
        if args.mode == "scenario":
            t = threading.Thread(
                target=play_scenario, args=(hub, args.scenario), daemon=True
            )
            t.start()
        elif args.mode == "agent":
            if not args.goal:
                print("[agent] --mode agent requires --goal; nothing to run.", flush=True)
                return
            t = threading.Thread(target=run_agent, args=(hub, args.goal), daemon=True)
            t.start()
        # idle: do nothing.

    on_first = on_first_client if args.mode in ("scenario", "agent") else None
    server = MorphServer((args.host, args.port), MorphHandler, hub, on_first, args.scenario)

    bridge = None
    if args.mode == "aios":
        missing = [n for n, v in (("--aios-url", args.aios_url), ("--aios-key", args.aios_key),
                                  ("--aios-session", args.aios_session)) if not v]
        if missing:
            print(f"[server] --mode aios requires {', '.join(missing)} "
                  f"(or $AIOS_URL/$AIOS_API_KEY/$MORPH_AIOS_SESSION)", flush=True)
            raise SystemExit(2)
        from aios_bridge import AiosBridge
        bridge = AiosBridge(hub, args.aios_url, args.aios_key, args.aios_session)
        bridge.start()

    print_banner(args.port, args.mode, args.scenario, args.goal)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] shutting down.", flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
