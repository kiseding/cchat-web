import { join } from "node:path"
import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises"

const DATA_DIR = join(process.env.HOME || "/tmp", ".cchat2web")
const SESSIONS_DIR = join(DATA_DIR, "sessions")

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  claudeSessionId?: string
}

export interface SessionMessage {
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

let initialized = false

async function ensureDir() {
  if (!initialized) {
    await mkdir(SESSIONS_DIR, { recursive: true })
    initialized = true
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  await ensureDir()
  const files = await readdir(SESSIONS_DIR)
  const sessions: SessionMeta[] = []
  for (const file of files) {
    if (!file.endsWith(".json") || file.includes("-messages")) continue
    const data = await readFile(join(SESSIONS_DIR, file), "utf-8")
    const meta: SessionMeta = JSON.parse(data)
    sessions.push(meta)
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

export async function getSession(id: string): Promise<SessionMeta | null> {
  await ensureDir()
  try {
    const data = await readFile(sessionPath(id), "utf-8")
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function createSession(id: string, title?: string): Promise<SessionMeta> {
  await ensureDir()
  const now = Date.now()
  const meta: SessionMeta = {
    id,
    title: title || "New Session",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  }
  await writeFile(sessionPath(id), JSON.stringify(meta, null, 2))
  return meta
}

export async function updateSession(id: string, updates: Partial<Pick<SessionMeta, "title" | "messageCount" | "claudeSessionId">>): Promise<void> {
  const meta = await getSession(id)
  if (!meta) return
  Object.assign(meta, updates, { updatedAt: Date.now() })
  await writeFile(sessionPath(id), JSON.stringify(meta, null, 2))
}

export async function deleteSession(id: string): Promise<void> {
  await ensureDir()
  try { await unlink(sessionPath(id)) } catch { /* ignore */ }
  // Also delete messages file
  try { await unlink(messagesPath(id)) } catch { /* ignore */ }
}

export async function getMessages(id: string): Promise<SessionMessage[]> {
  await ensureDir()
  try {
    const data = await readFile(messagesPath(id), "utf-8")
    return JSON.parse(data)
  } catch {
    return []
  }
}

export async function appendMessage(id: string, msg: SessionMessage): Promise<void> {
  const messages = await getMessages(id)
  messages.push(msg)
  await writeFile(messagesPath(id), JSON.stringify(messages, null, 2))
  await updateSession(id, { messageCount: messages.length })
}

function sessionPath(id: string) {
  return join(SESSIONS_DIR, `${id}.json`)
}

function messagesPath(id: string) {
  return join(SESSIONS_DIR, `${id}-messages.json`)
}
