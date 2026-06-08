#!/bin/bash
# CChat-Web Quick Start
# Usage: ./start.sh [AUTH_TOKEN]

export AUTH_TOKEN="${1:-cchat2web}"

echo "=== CChat-Web ==="
echo "Bridge server: http://localhost:5173"
echo "Frontend: http://localhost:4096"
echo "Token: $AUTH_TOKEN"
echo ""

# Start bridge server
cd "$(dirname "$0")/packages/server"
bun run index.ts &
BRIDGE_PID=$!

# Start frontend
cd ../app
bun run dev --host &
FRONTEND_PID=$!

echo "Press Ctrl+C to stop"
trap "kill $BRIDGE_PID $FRONTEND_PID 2>/dev/null; exit" INT
wait
