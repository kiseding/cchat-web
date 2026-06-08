// Prevent crashes from unhandled rejections
process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err))
process.on("uncaughtException", (err) => console.error("uncaught exception:", err))

import { Hono } from "hono"
import { cors } from "hono/cors"
import { randomUUIDv7 } from "bun"
import type { ClaudeProcessEvent } from "./claude-process"
import { createProcess, getProcess, cleanupProcess } from "./claude-process"
import {
  listSessions,
  getSession,
  createSession,
  deleteSession,
  getMessages,
  appendMessage,
  updateSession,
  type SessionMessage,
} from "./session"

const AUTH_TOKEN = process.env.AUTH_TOKEN || "cchat2web"
const sessionProcMap = new Map<string, string>() // web session id → claude process id

const app = new Hono()

// Auth middleware (skip health check)
app.use("/*", async (c, next) => {
  if (c.req.path === "/api/health") return next()
  const auth = c.req.header("Authorization") || ""
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401)
  }
  return next()
})

app.use("/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}))

// ── Session routes ──

app.get("/api/sessions", async (c) => {
  const sessions = await listSessions()
  return c.json(sessions)
})

app.post("/api/sessions", async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }))
  const name = body.name?.trim()
  // Check for duplicate session name
  if (name) {
    const existing = await listSessions()
    if (existing.some(s => s.title === name)) {
      return c.json({ error: "Session name already exists" }, 409)
    }
  }
  const id = randomUUIDv7()
  const session = await createSession(id, name || undefined)
  return c.json(session, 201)
})

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  const session = await getSession(id)
  if (!session) return c.json({ error: "Session not found" }, 404)
  const messages = await getMessages(id)
  return c.json({ ...session, messages })
})

app.delete("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  cleanupProcess(id)
  await deleteSession(id)
  return c.json({ ok: true })
})

// Send message with SSE streaming
app.post("/api/sessions/:id/messages", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{ text: string }>()
  const text = body.text?.trim()
  if (!text) return c.json({ error: "Empty message" }, 400)

  // Ensure session exists
  let session = await getSession(id)
  if (!session) session = await createSession(id)

  // Save user message
  const userMsg: SessionMessage = {
    id: randomUUIDv7(),
    role: "user",
    content: text,
    timestamp: Date.now(),
  }
  await appendMessage(id, userMsg)


  // Collect response as ordered blocks (text interleaved with tools)
  let currentText = ""
  const contentBlocks: SessionMessage["parts"] = []
  let done = false
  const donePromise = Promise.withResolvers<void>()

  function flushText() {
    if (currentText.trim()) {
      contentBlocks.push({ type: "text", text: currentText })
      currentText = ""
    }
  }

  // Real-time streaming via ReadableStream
  let streamController: ReadableStreamDefaultController | null = null

  function sendSSE(event: string, data: unknown) {
    if (streamController) {
      try {
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        streamController.enqueue(new TextEncoder().encode(line))
      } catch (e) { /* controller closed */ }
    }
  }

  const stream = new ReadableStream({
    start(controller) { streamController = controller },
    cancel() { streamController = null },
  })

  const procId = randomUUIDv7()
  sessionProcMap.set(id, procId)
  const proc = createProcess(procId)
  proc.on("event", (evt: ClaudeProcessEvent) => {
    switch (evt.type) {
      case "init": sendSSE("init", evt.data); break
      case "question":
        sendSSE("question", evt.data)
        break
      case "thinking": sendSSE("thinking", evt.data); break
      case "text-delta":
        if (evt.data?.text) currentText += evt.data.text
        sendSSE("text-delta", evt.data)
        break
      case "tool-start":
        flushText()
        contentBlocks.push({ type: "tool_call", toolName: evt.data.toolName, toolInput: evt.data.toolInput, toolId: evt.data.toolId })
        sendSSE("tool-start", evt.data)
        break
      case "tool-end":
        contentBlocks.push({ type: "tool_result", toolId: evt.data.toolId, toolOutput: truncateOutput(evt.data.output) })
        sendSSE("tool-end", evt.data)
        break
      case "done":
        flushText()
        sendSSE("done", {})
        streamController?.close()
        donePromise.resolve()
        break
      case "error":
        sendSSE("error", { message: String(evt.data) })
        streamController?.close()
        donePromise.resolve()
        break
    }
  })

  proc.on("exit", () => {
    if (streamController) {
      try {
        flushText()
        sendSSE("done", {})
        streamController.close()
      } catch (e) { /* already closed */ }
    }
    donePromise.resolve()
  })

  proc.on("error", (err) => {
    sendSSE("error", { message: err.message })
    streamController?.close()
    donePromise.resolve()
  })

  // Pass recent messages from THIS session only as context
  const allMessages = await getMessages(id)
  const contextMsgs = allMessages.slice(0, -1).slice(-30)
  const history = contextMsgs
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n")
  const prompt = history
    ? `Previous conversation:\n${history}\n\nUser: ${text}\n\nContinue as Assistant.`
    : text

  proc.start()
  proc.sendMessage(prompt)

  setTimeout(() => {
    if (streamController) {
      sendSSE("error", { message: "Request timed out" })
      streamController.close()
    }
  }, 120000)

  // Save message when done (keep process alive for next message)
  donePromise.promise.then(async () => {
    try {
      const fullText = contentBlocks.filter(b => b.type === "text").map(b => b.text).join("\n\n")
      if (fullText || contentBlocks.some(b => b.type !== "text")) {
        await appendMessage(id, { id: randomUUIDv7(), role: "assistant", content: fullText, parts: contentBlocks, timestamp: Date.now() })
        const current = await getSession(id)
        if (current && (!current.title || current.title === "New Session")) {
          await updateSession(id, { title: generateTitle(text) })
        }
      }
    } catch (err) {
      console.error("Failed to save message:", err)
    }
  })

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  })
})

// Answer a question from Claude Code
app.post("/api/sessions/:webId/answer", async (c) => {
  const webId = c.req.param("webId")
  const body = await c.req.json<{ toolId: string; answer: any }>()
  const proc = getProcess(sessionProcMap.get(webId) || "")
  if (!proc) return c.json({ error: "No active session" }, 404)
  const answerContent = typeof body.answer === "string" ? body.answer : JSON.stringify(body.answer)
  const response = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: body.toolId, content: answerContent }],
    },
  }) + "\n"
  proc.sendRaw(response)
  return c.json({ ok: true })
})

// Abort running session
app.post("/api/sessions/:id/abort", async (c) => {
  const id = c.req.param("id")
  cleanupProcess(id)
  return c.json({ ok: true })
})

app.get("/api/health", (c) => c.json({ status: "ok" }))

// ── Helpers ──

function generateTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim()
  return cleaned.length > 60 ? cleaned.slice(0, 60) + "..." : cleaned
}

function truncateOutput(output: string, maxLen = 5000): string {
  if (output.length <= maxLen) return output
  return output.slice(0, maxLen) + `\n... [truncated]`
}

const port = parseInt(process.env.PORT || "5173")
console.log(`Bridge server starting on http://localhost:${port}`)

Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch: app.fetch,
})
