// Node.js version of bridge server
import { createServer } from "node:http"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Reuse the same Hono app logic
import { Hono } from "hono"
import { cors } from "hono/cors"
import type { ClaudeProcessEvent } from "./claude-process.ts"
import { createProcess, getProcess, cleanupProcess } from "./claude-process.ts"
import {
  listSessions, getSession, createSession, deleteSession,
  getMessages, appendMessage, updateSession,
  type SessionMessage,
} from "./session.ts"

process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err))
process.on("uncaughtException", (err) => console.error("uncaught exception:", err))

const AUTH_TOKEN = process.env.AUTH_TOKEN || "cchat2web"
const sessionProcMap = new Map()

const app = new Hono()

app.use("/*", async (c, next) => {
  if (c.req.path === "/api/health") return next()
  const auth = c.req.header("Authorization") || ""
  if (auth !== `Bearer ${AUTH_TOKEN}`) return c.json({ error: "Unauthorized" }, 401)
  return next()
})

app.use("/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}))

// Session routes
app.get("/api/sessions", async (c) => { const sessions = await listSessions(); return c.json(sessions) })

app.post("/api/sessions", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = body.name?.trim()
  if (name) {
    const existing = await listSessions()
    if (existing.some(s => s.title === name)) return c.json({ error: "Session name already exists" }, 409)
  }
  const id = randomUUID()
  const session = await createSession(id, name || undefined)
  return c.json(session, 201)
})

app.get("/api/sessions/:id", async (c) => {
  const session = await getSession(c.req.param("id"))
  if (!session) return c.json({ error: "Session not found" }, 404)
  const messages = await getMessages(session.id)
  return c.json({ ...session, messages })
})

app.delete("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  cleanupProcess(id)
  await deleteSession(id)
  return c.json({ ok: true })
})

app.post("/api/sessions/:id/messages", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json()
  const text = body.text?.trim()
  if (!text) return c.json({ error: "Empty message" }, 400)

  let session = await getSession(id)
  if (!session) session = await createSession(id)

  const userMsg = { id: randomUUID(), role: "user", content: text, timestamp: Date.now() }
  await appendMessage(id, userMsg)

  let currentText = ""
  const contentBlocks = []

  function flushText() {
    if (currentText.trim()) { contentBlocks.push({ type: "text", text: currentText }); currentText = "" }
  }

  let streamController = null
  function sendSSE(event, data) {
    if (streamController) {
      try { streamController.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch {}
    }
  }

  const stream = new ReadableStream({
    start(controller) { streamController = controller },
    cancel() { streamController = null },
  })

  const procId = randomUUID()
  sessionProcMap.set(id, procId)
  const proc = createProcess(procId)

  const donePromise = Promise.withResolvers()

  proc.on("event", (evt) => {
    switch (evt.type) {
      case "init": sendSSE("init", evt.data); break
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
        contentBlocks.push({ type: "tool_result", toolId: evt.data.toolId, toolOutput: truncate(evt.data.output) })
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
    if (streamController) { flushText(); sendSSE("done", {}); streamController.close() }
    donePromise.resolve()
  })
  proc.on("error", (err) => { sendSSE("error", { message: err.message }); streamController?.close(); donePromise.resolve() })

  proc.start()
  proc.sendMessage(buildPrompt(text, id))

  setTimeout(() => { if (streamController) { sendSSE("error", { message: "Request timed out" }); streamController.close() } }, 120000)

  donePromise.promise.then(async () => {
    try {
      sessionProcMap.delete(id); cleanupProcess(proc.id)
      const fullText = contentBlocks.filter(b => b.type === "text").map(b => b.text).join("\n\n")
      if (fullText || contentBlocks.some(b => b.type !== "text")) {
        await appendMessage(id, { id: randomUUID(), role: "assistant", content: fullText, parts: contentBlocks, timestamp: Date.now() })
        const current = await getSession(id)
        if (current && (!current.title || current.title === "New Session")) {
          await updateSession(id, { title: generateTitle(text) })
        }
      }
    } catch (err) { console.error("Failed to save message:", err) }
  })

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
})

async function buildPrompt(text, id) {
  const allMessages = await getMessages(id)
  const contextMsgs = allMessages.slice(0, -1).slice(-30)
  const history = contextMsgs.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n")
  return history ? `Previous conversation:\n${history}\n\nUser: ${text}\n\nContinue as Assistant.` : text
}

function generateTitle(text) { const c = text.replace(/\s+/g, " ").trim(); return c.length > 60 ? c.slice(0, 60) + "..." : c }
function truncate(output, maxLen = 5000) { return output.length <= maxLen ? output : output.slice(0, maxLen) + `\n... [truncated]` }

// ── HTTP Server ──
const port = parseInt(process.env.PORT || "4096")
const staticDir = join(__dirname, "..", "app", "dist")

async function serveStatic(pathname) {
  try {
    const filePath = join(staticDir, pathname === "/" ? "index.html" : pathname)
    const data = await readFile(filePath)
    const ext = pathname.split(".").pop()
    const mime = { html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", json: "application/json" }[ext] || "text/plain"
    return new Response(data, { headers: { "Content-Type": mime } })
  } catch { return null }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)

  // API routes
  if (url.pathname.startsWith("/api/")) {
    const webRes = await app.fetch(req)
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers))
    if (webRes.body) {
      const reader = webRes.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) { res.end(); return }
          res.write(value)
          pump() // recursive but goes async
        }
      }
      // For simplicity, read all
      const buf = await webRes.arrayBuffer()
      res.end(Buffer.from(buf))
    } else { res.end() }
    return
  }

  // Static files
  const staticRes = await serveStatic(url.pathname)
  if (staticRes) {
    res.writeHead(staticRes.status || 200, Object.fromEntries(staticRes.headers))
    const buf = await staticRes.arrayBuffer()
    res.end(Buffer.from(buf))
    return
  }

  // SPA fallback
  const indexRes = await serveStatic("/index.html")
  if (indexRes) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(Buffer.from(await indexRes.arrayBuffer())) }
  else { res.writeHead(404); res.end("Not Found") }
})

server.listen(port, "0.0.0.0", () => console.log(`CChat-Web server starting on http://localhost:${port}`))
