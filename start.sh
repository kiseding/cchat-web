#!/bin/bash
# CChat-Web Quick Start

export AUTH_TOKEN="${1:-cchat2web}"
export PORT="${PORT:-4096}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== CChat-Web ==="
echo "Server: http://localhost:$PORT"
echo "Token: $AUTH_TOKEN"

# Build frontend
echo "Building frontend..."
cd "$DIR/packages/app" && npm install --silent && npx vite build

# Build and run Go server
cd "$DIR/packages/server"
echo "Building server..."
go build -o server main.go
echo "Starting on port $PORT..."
exec ./server
