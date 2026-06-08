import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude"

export interface ClaudeProcessEvent {
  type: "init" | "thinking" | "text-delta" | "text-start" | "text-end" |
    "tool-start" | "tool-progress" | "tool-end" |
    "permission-request" | "done" | "error" | "raw"
  data?: any
  raw?: object
}

export class ClaudeProcess extends EventEmitter {
  private process: ChildProcess | null = null
  private sessionId: string
  private alive = false
  private stderrLog = ""

  constructor(sessionId: string) {
    super()
    this.sessionId = sessionId
  }

  get isAlive() { return this.alive }
  get id() { return this.sessionId }

  start(): void {
    if (this.alive) return

    console.log(`[claude:${this.sessionId}] Starting Claude Code process...`)

    const choiceRule = "IMPORTANT: This is a fresh session in a web chat. Do NOT use any information from memory files or previous sessions — only use what the user tells you in this conversation. When asking the user to choose, format options as: 1. ShortLabel 2. ShortLabel 3. ShortLabel on ONE line."

    this.process = spawn(CLAUDE_PATH, [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "-p",
      "--verbose",
      "--tools", "Task,Bash,CronCreate,CronDelete,CronList,Edit,EnterPlanMode,EnterWorktree,ExitPlanMode,ExitWorktree,Glob,Grep,NotebookEdit,Read,ScheduleWakeup,Skill,TaskCreate,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate,WebFetch,WebSearch,Workflow,Write",
      "--append-system-prompt", choiceRule,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    })

    this.alive = true

    // Read stdout as a stream of lines
    let stdoutBuf = ""
    this.process.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split("\n")
      stdoutBuf = lines.pop() || "" // keep incomplete line in buffer
      for (const line of lines) {
        if (line.trim()) this.handleLine(line)
      }
    })

    this.process.stdout!.on("end", () => {
      // Process any remaining data
      if (stdoutBuf.trim()) this.handleLine(stdoutBuf)
    })

    this.process.on("exit", (code) => {
      this.alive = false
      console.log(`[claude:${this.sessionId}] Process exited with code ${code}`)
      if (this.stderrLog) {
        console.error(`[claude:${this.sessionId}] stderr: ${this.stderrLog.slice(0, 500)}`)
      }
      this.emit("exit", code)
    })

    this.process.on("error", (err) => {
      this.alive = false
      console.error(`[claude:${this.sessionId}] Spawn error:`, err.message)
      this.emit("error", err)
    })

    this.process.stderr?.on("data", (data: Buffer) => {
      this.stderrLog += data.toString()
    })
  }

  private handleLine(line: string) {
    try {
      const parsed = JSON.parse(line)
      this.processMessage(parsed)
    } catch {
      // Non-JSON line, log for debugging
      if (line.length < 200) console.log(`[claude:${this.sessionId}] non-json: ${line}`)
    }
  }

  private processMessage(msg: any) {
    const type = msg.type
    const subtype = msg.subtype

    // Init message
    if (type === "system" && subtype === "init") {
      console.log(`[claude:${this.sessionId}] Session initialized`)
      this.emit("event", {
        type: "init",
        data: { sessionId: msg.session_id, model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode },
        raw: msg,
      } satisfies ClaudeProcessEvent)
      return
    }

    // Thinking tokens
    if (type === "system" && subtype === "thinking_tokens") {
      this.emit("event", {
        type: "thinking",
        data: { tokens: msg.estimated_tokens },
        raw: msg,
      } satisfies ClaudeProcessEvent)
      return
    }

    // Assistant message
    if (type === "assistant" && msg.message) {
      const content: any[] = msg.message.content || []
      for (const part of content) {
        if (part.type === "text") {
          this.emit("event", {
            type: "text-delta",
            data: { text: part.text },
            raw: msg,
          } satisfies ClaudeProcessEvent)
        } else if (part.type === "tool_use") {
          this.emit("event", {
            type: "tool-start",
            data: { toolId: part.id, toolName: part.name, toolInput: part.input },
            raw: msg,
          } satisfies ClaudeProcessEvent)
        }
      }
      return
    }

    // User message with tool result
    if (type === "user" && msg.message) {
      const content: any[] = msg.message.content || []
      for (const part of content) {
        if (part.type === "tool_result") {
          const output = typeof part.content === "string" ? part.content : JSON.stringify(part.content)
          this.emit("event", {
            type: "tool-end",
            data: { toolId: part.tool_use_id, output },
            raw: msg,
          } satisfies ClaudeProcessEvent)
        }
      }
      return
    }

    // Result / done
    if (type === "result") {
      console.log(`[claude:${this.sessionId}] Completed`)
      this.emit("event", {
        type: "done",
        data: msg,
        raw: msg,
      } satisfies ClaudeProcessEvent)
      return
    }

    // Unknown message type
    if (subtype && subtype !== "thinking_tokens") {
      this.emit("event", {
        type: "raw",
        data: subtype,
        raw: msg,
      } satisfies ClaudeProcessEvent)
    }
  }

  sendRaw(data: string): void {
    if (!this.process?.stdin) return
    this.process.stdin.write(data)
  }

  sendMessage(text: string): void {
    if (!this.process?.stdin) {
      console.error(`[claude:${this.sessionId}] Cannot send: stdin not available`)
      return
    }
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
    console.log(`[claude:${this.sessionId}] Sending message via stdin`)
    this.process.stdin.write(msg)
    this.process.stdin.end()
  }

  abort(): void {
    if (this.process) {
      this.process.kill("SIGTERM")
      this.alive = false
    }
  }

  destroy(): void {
    this.abort()
    this.removeAllListeners()
  }
}

// Global registry
const processes = new Map<string, ClaudeProcess>()

export function getProcess(sessionId: string): ClaudeProcess | undefined {
  return processes.get(sessionId)
}

export function createProcess(sessionId: string): ClaudeProcess {
  const existing = processes.get(sessionId)
  if (existing) existing.destroy()
  const proc = new ClaudeProcess(sessionId)
  processes.set(sessionId, proc)
  proc.on("exit", () => { processes.delete(sessionId) })
  return proc
}

export function cleanupProcess(sessionId: string): void {
  const proc = processes.get(sessionId)
  if (proc) { proc.destroy(); processes.delete(sessionId) }
}
