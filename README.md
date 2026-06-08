# CChat-Web

Claude Code 的 Web 聊天界面。通过 HTTP + SSE 桥接 Claude Code CLI 的 stream-json 协议，在浏览器里使用 Claude Code。

## 截图

![screenshot](https://github.com/user-attachments/assets/placeholder)

## 特性

- 🗣️ Claude Code 驱动 — 非 token API，直接使用本地 Claude Code 的能力
- ⚡ 实时流式输出 — SSE 推送，思考过程和回复逐字显示
- 🛠️ 工具调用可视化 — Bash、Read、Write 等工具调用折叠展示
- 📝 多会话管理 — 创建、重命名、删除会话，会话间数据隔离
- 🔒 密码保护 — Bearer token 认证
- 🎨 深色模式 — 自动跟随系统
- 📱 响应式布局

## 快速开始

### 前置条件

- [Bun](https://bun.sh) 1.3+
- [Claude Code](https://github.com/anomalyco/opencode) CLI（非 Anthropic API）

### 安装

```bash
git clone https://github.com/kiseding/cchat-web.git
cd cchat-web
bun install
```

### 启动

```bash
# 终端 1: 启动 Bridge Server（端口 5173）
cd packages/server
AUTH_TOKEN=你的密码 bun run index.ts

# 终端 2: 启动前端开发服务器（端口 4096）
cd packages/app
bun run dev
```

打开 `http://localhost:4096`，输入密码登录。

### 外网访问

Vite 开发服务器默认绑定 `0.0.0.0`，局域网内可通过 IP 访问：
```
http://192.168.x.x:4096
```

通过 Cloudflare 等反向代理访问时，需确保代理端口支持。

## 架构

```
浏览器 (SolidJS Web UI)    端口 4096
    ↕ HTTP REST + SSE
Bridge Server (Bun + Hono) 端口 5173
    ↕ stdin/stdout stream-json
Claude Code CLI 进程 (每消息一个实例)
```

## 项目结构

```
cchat-web/
├── packages/
│   ├── app/       # SolidJS 前端
│   │   └── src/
│   │       ├── app.tsx              # 登录页
│   │       ├── pages/
│   │       │   ├── chat.tsx         # 聊天页
│   │       │   └── main-layout.tsx  # 布局 + 侧边栏
│   │       └── api/client.ts        # API 客户端 + SSE 解析
│   └── server/    # Bridge Server
│       ├── index.ts          # HTTP 路由 + SSE 流
│       ├── claude-process.ts # Claude Code 进程管理
│       └── session.ts        # 会话持久化 (JSON 文件)
└── package.json
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions/:id` | 会话详情 + 消息 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| POST | `/api/sessions/:id/messages` | 发送消息 (SSE 流式返回) |
| POST | `/api/sessions/:id/abort` | 中断运行 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTH_TOKEN` | `cchat2web` | 登录密码 |
| `PORT` | `5173` | Bridge Server 端口 |

## 技术栈

- **前端**: SolidJS + Tailwind CSS + marked
- **后端**: Bun + Hono + stream-json
- **AI**: Claude Code CLI

## License

MIT

---

Design by [kiseding](https://github.com/kiseding)
