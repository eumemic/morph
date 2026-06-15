"""aios_bridge.py — bind the Morph relay to a live aios session.

Seam B from the integration recon. Zero aios code changes: the agent runs in a
normal aios session with one custom tool, `present(messages[])`, whose arguments
ARE the MorphSpec wire messages. The bridge:

  * forwards the human's composer text (and widget actions) to the session as
    user-channel messages   -> POST /v1/sessions/{id}/messages
  * tails the session's event stream                -> GET  /v1/sessions/{id}/stream?after_seq=N
  * for every `present` tool-call, broadcasts each MorphSpec message to the
    browser via the Morph Hub, then acks the call   -> POST /v1/sessions/{id}/tool-results
    (custom tools end the turn idle; the ack re-wakes the loop so the agent can
    keep presenting).
  * surfaces the assistant's prose as a thin narrate line.

Stdlib only (urllib) so the Morph relay stays dependency-free.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request


class AiosBridge:
    def __init__(self, hub, base_url: str, api_key: str, session_id: str):
        self.hub = hub
        self.base = base_url.rstrip("/")
        self.key = api_key
        self.session = session_id
        self.last_seq = 0
        self._acked: set[str] = set()  # tool_call_ids we've already resolved
        self._rendered: set[str] = set()  # tool_call_ids whose MorphSpec we've broadcast
        self._stop = False

    # -- HTTP helpers --------------------------------------------------------

    def _headers(self, sse: bool = False) -> dict:
        h = {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if sse:
            h["Accept"] = "text/event-stream"
        return h

    def _post(self, path: str, body: dict) -> None:
        req = urllib.request.Request(
            f"{self.base}{path}", data=json.dumps(body).encode("utf-8"),
            headers=self._headers(), method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()

    # -- inbound: human -> session ------------------------------------------

    def forward_text(self, text: str) -> None:
        """Wired as hub.input_sink: the composer's primary text channel."""
        try:
            self._post(f"/v1/sessions/{self.session}/messages", {"content": text})
        except Exception as e:  # noqa: BLE001 — surface, never crash the relay
            print(f"[bridge] forward_text error: {e}", flush=True)
            self.hub.broadcast({"type": "narrate", "text": f"(could not reach the agent: {e})"})

    def forward_action(self, action: str, component_id: str, value) -> None:
        """Secondary channel: a widget click, phrased so the agent understands it."""
        parts = [f"[widget] {action or 'click'}"]
        if component_id:
            parts.append(f"on {component_id}")
        if value is not None:
            parts.append(f"= {value}")
        self.forward_text(" ".join(parts))

    # -- outbound: session -> browser ---------------------------------------

    def _ack(self, tool_call_id: str) -> None:
        if tool_call_id in self._acked:
            return
        self._acked.add(tool_call_id)
        try:
            self._post(
                f"/v1/sessions/{self.session}/tool-results",
                {"tool_call_id": tool_call_id, "content": "ok"},
            )
        except Exception as e:  # noqa: BLE001
            print(f"[bridge] tool-result error: {e}", flush=True)

    def _render_present(self, tool_call_id: str, arguments) -> None:
        if tool_call_id in self._rendered:
            return
        self._rendered.add(tool_call_id)
        try:
            payload = json.loads(arguments) if isinstance(arguments, str) else (arguments or {})
            messages = payload.get("messages") or []
        except Exception as e:  # noqa: BLE001
            print(f"[bridge] bad present args: {e}", flush=True)
            return
        for m in messages:
            if isinstance(m, dict) and m.get("type"):
                self.hub.broadcast(m)

    def _handle_event(self, ev: dict, *, ack: bool) -> None:
        seq = ev.get("seq") or 0
        if seq:
            self.last_seq = max(self.last_seq, seq)
        if ev.get("kind") != "message":
            return
        data = ev.get("data") or {}
        if data.get("role") != "assistant":
            return
        tool_calls = data.get("tool_calls") or []
        present = [tc for tc in tool_calls if (tc.get("function") or {}).get("name") == "present"]
        # The assistant's short prose rides along as a faint narrate line.
        content = (data.get("content") or "").strip()
        if content and present:
            self.hub.broadcast({"type": "narrate", "text": content})
        for tc in present:
            tcid = tc.get("id")
            self._render_present(tcid, (tc.get("function") or {}).get("arguments"))
            if ack and tcid:
                self._ack(tcid)

    # -- startup catch-up + live stream -------------------------------------

    def _catch_up(self) -> None:
        """Render the session's current surface into the relay (so a fresh browser
        sees current state) and ack only the still-pending present calls."""
        try:
            req = urllib.request.Request(
                f"{self.base}/v1/sessions/{self.session}", headers=self._headers())
            with urllib.request.urlopen(req, timeout=20) as r:
                session = json.loads(r.read())
            pending = {a.get("tool_call_id") for a in (session.get("awaiting") or [])}

            req = urllib.request.Request(
                f"{self.base}/v1/sessions/{self.session}/events?after_seq=0",
                headers=self._headers())
            with urllib.request.urlopen(req, timeout=20) as r:
                events = json.loads(r.read()).get("data", [])
        except Exception as e:  # noqa: BLE001
            print(f"[bridge] catch-up skipped: {e}", flush=True)
            return
        for ev in events:
            data = ev.get("data") or {}
            tcs = data.get("tool_calls") or [] if ev.get("kind") == "message" else []
            seq = ev.get("seq") or 0
            if seq:
                self.last_seq = max(self.last_seq, seq)
            for tc in tcs:
                if (tc.get("function") or {}).get("name") != "present":
                    continue
                tcid = tc.get("id")
                self._render_present(tcid, (tc.get("function") or {}).get("arguments"))
                # Only re-wake calls that are STILL pending (don't double-ack
                # ones a previous bridge run already resolved).
                if tcid in pending:
                    self._ack(tcid)

    def _stream_loop(self) -> None:
        while not self._stop:
            url = f"{self.base}/v1/sessions/{self.session}/stream?after_seq={self.last_seq}"
            try:
                req = urllib.request.Request(url, headers=self._headers(sse=True))
                with urllib.request.urlopen(req, timeout=120) as resp:
                    for raw in resp:
                        if self._stop:
                            return
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            ev = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        if isinstance(ev, dict) and "seq" in ev:
                            self._handle_event(ev, ack=True)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if not self._stop:
                    time.sleep(1.0)  # reconnect from last_seq
            except Exception as e:  # noqa: BLE001
                print(f"[bridge] stream error: {e}", flush=True)
                time.sleep(1.0)

    def start(self) -> None:
        self.hub.input_sink = self.forward_text
        self._catch_up()
        threading.Thread(target=self._stream_loop, daemon=True, name="aios-bridge").start()
        print(f"[bridge] live on session {self.session} via {self.base}", flush=True)

    def stop(self) -> None:
        self._stop = True
