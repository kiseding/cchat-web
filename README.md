# CChat-Web

Claude Code 的 Web 聊天界面。通过 HTTP + SSE 桥接 Claude Code CLI 的 stream-json 协议，在浏览器里使用 Claude Code。

A web chat interface for Claude Code. Bridges Claude Code CLI's stream-json protocol to the browser via HTTP + SSE.

## 特性 / Features

- 🗣️ Claude Code 驱动，非 token API / Powered by Claude Code CLI, not Anthropic API
- ⚡ SSE 实时流式输出 / Real-time streaming via SSE
- 🛠️ 工具调用折叠卡片 / Collapsible tool call cards (Bash, Read, Write...)
- 📝 多会话管理 / Multi-session management
- 🔒 Bearer token 密码认证 / Password auth
- 🎨 深色模式 / Dark mode
- 📱 移动端适配 / Mobile responsive
- 🐳 4MB Docker 镜像 / 4MB Docker image

## 前置条件 / Prerequisites

- **Go** ≥ 1.22 或 **Node.js** ≥ 22（仅前端构建 / frontend build only）
- **Claude Code CLI** (`claude` 在 PATH 中)

## 快速开始 / Quick Start

```bash
git clone https://github.com/kiseding/cchat-web.git
cd cchat-web
./start.sh 你的密码
```

打开 `http://localhost:4096`，输入密码登录。

## 手动部署 / Manual Setup

```bash
# 构建前端 / Build frontend
cd packages/app && npm install && npx vite build

# 编译并启动 / Build and run server
cd ../server
go build -o server main.go
AUTH_TOKEN=你的密码 ./server
```

## 开发模式 / Development

```bash
# 终端 1 — API 服务器
cd packages/server && PORT=5173 AUTH_TOKEN=your-password go run main.go

# 终端 2 — 前端热更新
cd packages/app && npx vite
```

## 环境变量 / Environment

| 变量 | 默认 | 说明 |
|------|------|------|
| `AUTH_TOKEN` | `cchat2web` | 登录密码 |
| `PORT` | `4096` | 服务端口 |
| `CLAUDE_PATH` | `claude` | Claude Code 路径 |

## Docker

```bash
docker compose up -d
```

镜像自动构建于每次 push：`ghcr.io/kiseding/cchat-web`（压缩后 4MB）。

The image is auto-built on push: `ghcr.io/kiseding/cchat-web` (4MB compressed).

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 会话列表 / List sessions |
| POST | `/api/sessions` | 创建会话 / Create session |
| GET | `/api/sessions/:id` | 会话详情 / Session detail |
| DELETE | `/api/sessions/:id` | 删除会话 / Delete session |
| POST | `/api/sessions/:id/messages` | 发送消息 (SSE) / Send message |
| POST | `/api/sessions/:id/abort` | 中断 / Abort |

## 架构 / Architecture

```
浏览器 (SolidJS)   :4096
    ↕ HTTP + SSE
Go 服务器           :4096
    ↕ stdin/stdout stream-json
Claude Code CLI     (每条消息一个进程)
```

## 项目结构 / Structure

```
cchat-web/
├── packages/
│   ├── app/           # SolidJS SPA
│   │   └── src/
│   │       ├── app.tsx              # 登录页 / Login
│   │       ├── pages/
│   │       │   ├── chat.tsx         # 聊天页 / Chat
│   │       │   └── main-layout.tsx  # 布局 + 侧边栏 / Layout
│   │       ├── api/client.ts        # HTTP + SSE 客户端
│   │       └── index.css            # 样式 / Styles
│   └── server/        # Go 服务端
│       ├── main.go     # HTTP, SSE, Claude 进程, 会话存储
│       └── go.mod
├── Dockerfile
├── docker-compose.yml
└── start.sh
```

## 技术栈 / Tech Stack

| 层 | 技术 |
|---|------|
| 前端 | SolidJS + Tailwind CSS + marked |
| 后端 | Go (net/http) |
| AI | Claude Code CLI (stream-json) |
| 容器 | Docker multi-stage (scratch, ~4MB) |

## License

MIT

---

Design by [kiseding](https://github.com/kiseding)
