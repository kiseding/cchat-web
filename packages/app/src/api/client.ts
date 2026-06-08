const BASE = "/api"

function getToken(): string {
  return localStorage.getItem("cchat2web-token") || ""
}

export function setToken(token: string) {
  localStorage.setItem("cchat2web-token", token)
}

export function hasToken(): boolean {
  return !!getToken()
}

export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  claudeSessionId?: string
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
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getToken()}`,
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
  listSessions: () => request<SessionInfo[]>("/sessions"),

  createSession: (name?: string) => request<SessionInfo>("/sessions", {
    method: "POST",
    body: JSON.stringify({ name }),
  }),

  getSession: (id: string) => request<SessionDetail>(`/sessions/${id}`),

  deleteSession: (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: "DELETE" }),

  sendMessage: (sessionId: string, text: string, onEvent: (event: SSEEvent) => void): Promise<void> => {
    return new Promise((resolve, reject) => {
      fetch(`${BASE}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ text }),
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
          while (true) {
            const { done, value } = await reader.read()
            if (done) { resolve(); return }
            buffer += decoder.decode(value, { stream: true })
            // Parse complete SSE events from buffer
            const parts = buffer.split("\n\n")
            buffer = parts.pop() || "" // keep incomplete chunk
            for (const part of parts) {
              const lines = part.split("\n")
              let event = ""
              for (const line of lines) {
                if (line.startsWith("event: ")) event = line.slice(7)
                else if (line.startsWith("data: ")) {
                  try {
                    onEvent({ event: event || "message", data: JSON.parse(line.slice(6)) })
                  } catch {
                    onEvent({ event: event || "message", data: line.slice(6) })
                  }
                }
              }
            }
          }
        })
        .catch(reject)
    })
  },

  abortSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/abort`, { method: "POST" }),

