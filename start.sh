#!/bin/bash
# CChat-Web Quick Start
# Usage: ./start.sh [AUTH_TOKEN]

export AUTH_TOKEN="${1:-cchat2web}"
export PORT="${PORT:-4096}"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== CChat-Web ==="
echo "Server: http://localhost:$PORT"
echo "Token: $AUTH_TOKEN"
echo ""

# Build frontend
echo "Building frontend..."
cd "$DIR/packages/app" && bun install --silent && bun run build

# Start server
cd "$DIR/packages/server"
echo "Starting on port $PORT..."
bun run --watch index.ts
