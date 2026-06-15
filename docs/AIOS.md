# Morph × aios — backing the dashboard with a real, long-lived session

Morph's default demo is a canned scenario, but the dashboard can be driven by a
**real [aios](https://github.com/eumemic/aios) session**: a long-lived,
Postgres-backed agent (any LiteLLM model) that you talk to through the
always-available composer, and that answers by *reshaping the dashboard* instead
of writing chat.

This is **seam B** from the integration study: a ~190-line bridge inside the
Morph relay, and **zero changes to aios** — just one agent + one session created
through the normal API.

```
HUMAN TYPES (primary channel)
  browser composer ──POST /input {text}──▶ Morph relay ──input_sink──▶
      POST /v1/sessions/{id}/messages {content}  ──▶  aios   (agent wakes)

AGENT DRIVES THE DASHBOARD (primary output)
  agent calls custom tool  present(messages[])   (ends the turn idle — unresolved)
  aios session stream ──SSE──▶ aios_bridge tail of /v1/sessions/{id}/stream
      ├─ tool_call name=="present": JSON.parse(arguments) IS the MorphSpec
      │     → hub.broadcast(each wire message)        → browser animates
      │     → POST /v1/sessions/{id}/tool-results "ok" → re-wakes the agent
      └─ assistant prose → a thin narrate line

WIDGET CLICK (secondary channel)
  browser button ──POST /action──▶ Morph relay ──input_sink──▶
      POST /v1/sessions/{id}/messages {content:"[widget] <action> on <id> = <v>"}
```

The bridge lives in [`aios_bridge.py`](../aios_bridge.py); the relay seam is
`Hub.input_sink` + `--mode aios` in [`server.py`](../server.py).

## Why the tool-result ack is load-bearing

aios custom (client-executed) tools are emitted to the model but **never run by
the harness** — an unresolved custom call ends the turn `idle`. The bridge must
POST a `tool-results` ack for each `present` call. If it doesn't, aios's sweep
eventually re-invokes the model with a context that ends on an assistant message
(consecutive assistant turns, no tool-result), and Anthropic rejects it with
*"This model does not support assistant message prefill; the conversation must
end with a user message"* — the session goes `errored`. **The ack is what keeps
every model re-call ending on a tool-result.** The bridge acks within
stream-latency of seeing the call, well ahead of any sweep.

## One-time setup

The integration was developed against an **isolated** aios runtime (separate DB
+ port, the main stack untouched) using the `aios-smoke-setup` skill. The shape:

1. **Isolated runtime** (a fresh DB on a local Postgres; api+worker on their own
   port). The runtime's `.env` sets `AIOS_DEFAULT_MCP_PERMISSION_POLICY=always_allow`
   and an `AIOS_EGRESS_CA_KEY` (any base64-32 value — chat-only sessions never use
   it). Model routing follows your environment's `ANTHROPIC_API_BASE` (set it if you
   front the Anthropic API with a proxy/gateway).

2. **The Morph agent** — `POST /v1/agents` with:
   - `model: "anthropic/claude-opus-4-8"` (or any LiteLLM-compatible model),
   - the "speak Morph" system prompt (ported from `agent/agent.py`, plus the
     persistence + always-available-human-channel guidance), and
   - a single **custom tool** `present` whose `input_schema` is the MorphSpec
     envelope `{ messages: [ …wire messages… ] }`.

3. **A long-lived session** — `POST /v1/sessions {agent_id, environment_id}`.

## Running it

```sh
# 1) bring up the isolated aios runtime (see the aios-smoke-setup skill), then
#    create the agent + session; capture the ids.
# 2) point the Morph relay at the session and serve:
set -a; source /path/to/aios-worktree/.env; source /tmp/morph-aios-ids.env; set +a
./run-aios.sh                 # = python3 server.py --mode aios
# open http://localhost:8765 and type in the composer.
```

`--mode aios` reads `AIOS_URL`, `AIOS_API_KEY`, and `MORPH_AIOS_SESSION` from the
environment (override with `--aios-url/--aios-key/--aios-session`). The bridge
catches up the current surface for late-joining browsers and only re-wakes
*still-pending* `present` calls, so it's safe to restart.

## Graceful path back to a connector

Seam B is a strict subset of a future **Morph connector** (seam A). The message
API already supports `metadata.channel`, so when the text-vs-widget distinction
needs to be first-class (or multiple browsers per session), the bridge graduates
into a connector without changing the browser at all.
