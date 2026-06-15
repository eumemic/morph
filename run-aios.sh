#!/usr/bin/env bash
# Start the Morph relay bridged to a live aios session (seam B).
#
# Prerequisites (see docs/AIOS.md for the full one-time setup):
#   * an aios runtime is up (api + worker) on $AIOS_URL
#   * a "morph-presenter" agent (with the custom `present` tool) + a session exist
#   * AIOS_URL, AIOS_API_KEY, MORPH_AIOS_SESSION are exported (or in an env file)
#
# Usage:
#   AIOS_URL=http://127.0.0.1:8091 AIOS_API_KEY=... MORPH_AIOS_SESSION=sess_... \
#     ./run-aios.sh [--port 8765]
#
# Or source an aios .env + an ids file first:
#   set -a; source /path/to/aios/.env; source /tmp/morph-aios-ids.env; set +a
#   ./run-aios.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${AIOS_URL:?set AIOS_URL (e.g. http://127.0.0.1:8091)}"
: "${AIOS_API_KEY:?set AIOS_API_KEY}"
: "${MORPH_AIOS_SESSION:?set MORPH_AIOS_SESSION (sess_...)}"

exec python3 server.py --mode aios "$@"
