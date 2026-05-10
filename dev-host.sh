#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8000}"
cd "$(dirname "$0")"

exec python3 -c '
import http.server, sys
port = int(sys.argv[1])
server = http.server.ThreadingHTTPServer(("127.0.0.1", port), http.server.SimpleHTTPRequestHandler)
print(f"Serving HTTP on localhost port {port} (http://localhost:{port}/) ...", flush=True)
server.serve_forever()
' "$PORT"
