const BASE = "/api"

function getToken(): string { return localStorage.getItem("cchat2web-token") || "" }
export function setToken(token: string) { localStorage.setItem("cchat2web-token", token) }
export function hasToken(): boolean { return !!getToken() }

export interface SessionInfo {
  sessionId: string
  title: string
  projectPath: string
  messageCount: number
  lastActivity: number
  inputTokens: number
  outputTokens: number
}

export interface SessionDetail extends SessionInfo {
  messages: Message[]
}

export interface Message {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  parts?: MessagePart[]
  timestamp: number
  extra?: { isCompactSummary?: boolean }
}

export interface MessagePart {
  type: "text" | "tool_call" | "tool_result" | "thinking"
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  toolId?: string
}

export interface SSEEvent {
  event: string
  data: any
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
    },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export const api = {
  // Session list — comes from Claude JSONL
  listSessions: () => request<SessionInfo[]>("/claude-sessions"),

  // Get session messages
  getSession: (id: string) =>
    request<Message[]>(`/claude-sessions/${id}`),

  // Delete session from disk
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/claude-sessions/${id}/delete`, { method: "DELETE" }),

  // Export as Markdown
  exportSessionUrl: (id: string) => `${BASE}/claude-sessions/${id}/export`,

  // Send message with SSE streaming
  sendMessage: (sessionId: string | null, text: string, onEvent: (event: SSEEvent) => void): Promise<string | null> => {
    return new Promise((resolve, reject) => {
      fetch(`${BASE}/sessions/${sessionId || "new"}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": getToken(),
        },
        body: JSON.stringify({ text, sessionId }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }))
            reject(new Error(err.error || `HTTP ${res.status}`))
            return
          }
          const reader = res.body!.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          let capturedSessionId: string | null = null
          while (true) {
            const { done, value } = await reader.read()
            if (done) { resolve(capturedSessionId); return }
            buffer += decoder.decode(value, { stream: true })
            const parts = buffer.split("\n\n")
            buffer = parts.pop() || ""
            for (const part of parts) {
              const lines = part.split("\n")
              let event = ""
              for (const line of lines) {
                if (line.startsWith("event: ")) event = line.slice(7)
                else if (line.startsWith("data: ")) {
                  try {
                    const data = JSON.parse(line.slice(6))
                    if (event === "init" && data.sessionId) capturedSessionId = data.sessionId
                    onEvent({ event: event || "message", data })
                  } catch {
                    onEvent({ event: event || "message", data: line.slice(6) })
                  }
                }
              }
            }
          }
        })
    })
  },

  abortSession: () =>
    request<{ ok: boolean }>("/abort", { method: "POST", body: JSON.stringify({}) }),
}
