# CChat-Web

Web chat interface for Claude Code. Bridges Claude Code CLI's stream-json protocol to a browser UI via HTTP + SSE.

## Features

- Claude Code powered — uses local CLI, not token API
- Real-time SSE streaming — thinking tokens and response appear as they're generated
- Tool calls rendered as collapsible blocks (Bash, Read, Write, etc.)
- Multi-session management — create, rename, delete; sessions are isolated
- Password auth via Bearer token
- Dark mode follows system preference
- Mobile responsive

## Prerequisites

- **Go** ≥ 1.22
- **Node.js** ≥ 22 (frontend build only)
- **Claude Code CLI** (`claude` in PATH)

```bash
claude --version
```

If `claude` is not in PATH:
```bash
export CLAUDE_PATH=/path/to/claude
```

## Quick Start

```bash
git clone https://github.com/kiseding/cchat-web.git
cd cchat-web
./start.sh your-password
```

Open `http://localhost:4096`, enter password to login.

## Manual Setup

```bash
# Build frontend (one-time)
cd packages/app && npm install && npx vite build

# Build and run server
cd packages/server
go build -o server main.go
AUTH_TOKEN=your-password ./server
```

## Development

```bash
# Terminal 1 — API server
cd packages/server && PORT=5173 AUTH_TOKEN=your-password go run main.go

# Terminal 2 — Frontend dev server with HMR
cd packages/app && npx vite
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | `cchat2web` | Login password |
| `PORT` | `4096` | Server port |
| `CLAUDE_PATH` | `claude` | Path to Claude Code binary |

## Docker

```bash
docker compose up -d
```

Image: `ghcr.io/kiseding/cchat-web` (auto-built on push to master).

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session |
| GET | `/api/sessions/:id` | Session detail + messages |
| DELETE | `/api/sessions/:id` | Delete session |
| POST | `/api/sessions/:id/messages` | Send message (SSE streaming) |
| POST | `/api/sessions/:id/abort` | Abort running request |

## Architecture

```
Browser (SolidJS)   :4096
    ↕ HTTP + SSE
Go server           :4096
    ↕ stdin/stdout stream-json
Claude Code CLI     (one process per message)
```

## Project Structure

```
cchat-web/
├── packages/
│   ├── app/           # SolidJS SPA
│   │   └── src/
│   │       ├── app.tsx              # Login page
│   │       ├── pages/
│   │       │   ├── chat.tsx         # Chat page
│   │       │   └── main-layout.tsx  # Layout + sidebar
│   │       ├── api/client.ts        # HTTP client + SSE parser
│   │       └── index.css            # Styles
│   └── server/        # Go server
│       ├── main.go     # HTTP, SSE, Claude process, session store
│       └── go.mod
├── Dockerfile
├── docker-compose.yml
└── start.sh
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | SolidJS + Tailwind CSS + marked |
| Server | Go (stdlib: net/http) |
| AI | Claude Code CLI (stream-json) |
| Container | Docker multi-stage (scratch ~10MB) |

## License

MIT

---

Design by [kiseding](https://github.com/kiseding)
