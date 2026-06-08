import { createSignal, createResource, For, Show, createEffect, onCleanup, onMount } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import { marked } from "marked"
import { api, type Message, type SessionDetail } from "../api/client"

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true })

function MarkdownContent(props: { text: string }) {
  const html = () => marked.parse(props.text) as string
  return <div class="text-sm leading-relaxed prose prose-sm" style="max-width:none" innerHTML={html()} />
}

function ToolCard(props: { tools: Array<{ name: string; input?: any; output?: string }> }) {
  const [expanded, setExpanded] = createSignal(false)
  const count = props.tools.length
  const names = () => [...new Set(props.tools.map(t => t.name))].join(", ")

  return (
    <div class="my-1 rounded-lg overflow-hidden border" style="border-color: var(--border-base); background: var(--bg-raised)">
      <button
        onClick={() => setExpanded(!expanded())}
        class="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium cursor-pointer hover:opacity-80"
        style="color: var(--text-weak); background: var(--bg-stronger)"
      >
        <span style="font-size:10px">{expanded() ? "▾" : "▸"}</span>
        <span>{count} {count === 1 ? "tool" : "tools"}</span>
        <span class="opacity-60">{names()}</span>
        <Show when={!expanded() && props.tools.some(t => t.output)}>
          <span class="truncate flex-1 text-left opacity-50">
            {props.tools.find(t => t.output)?.output?.split("\n")[0]?.slice(0, 80)}
          </span>
        </Show>
      </button>
      <Show when={expanded()}>
        <div class="p-2 flex flex-col gap-4">
          <For each={props.tools}>
            {(tool, i) => (
              <div class="text-xs" style="color: var(--text-base)">
                <div class="font-semibold px-1 text-xs" style="color: var(--text-weak)">
                  {i() + 1}. {tool.name}
                </div>
                <Show when={tool.input && Object.keys(tool.input).length > 0}>
                  <Show when={tool.input.command || tool.input.cmd} fallback={
                    <pre class="whitespace-pre-wrap text-xs px-1 opacity-80 mb-1">{JSON.stringify(tool.input, null, 2)}</pre>
                  }>
                    <div class="rounded-md overflow-hidden mb-1" style="background: #1a1b26; color: #a9b1d6; font-family: ui-monospace,monospace">
                      <div class="flex items-center gap-1.5 px-3 py-1.5 text-[11px]" style="background: #16171f">
                        <span class="rounded-full inline-block w-2.5 h-2.5" style="background: #f7768e" />
                        <span class="rounded-full inline-block w-2.5 h-2.5" style="background: #e0af68" />
                        <span class="rounded-full inline-block w-2.5 h-2.5" style="background: #9ece6a" />
                        <span class="ml-2" style="color: #565f89">bash</span>
                      </div>
                      <div class="px-3 py-2 text-[13px] leading-relaxed">
                        <span style="color: #9ece6a">$ </span>
                        <span style="color: #7dcfff">{tool.input.command || tool.input.cmd}</span>
                      </div>
                    </div>
                  </Show>
                </Show>
                <Show when={tool.output}>
                  <pre class="whitespace-pre-wrap text-[13px] p-3 rounded-md overflow-auto max-h-64 leading-relaxed" style="background: #1a1b26; color: #a9b1d6; font-family: ui-monospace,monospace">{tool.output.slice(0, 5000)}</pre>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// Merge consecutive tool blocks into groups
type DisplayBlock = { type: "text"; text: string } | { type: "tool-group"; tools: Array<{ name: string; input?: any; output?: string }> }

function mergeParts(parts: Message["parts"]): DisplayBlock[] {
  if (!parts) return []
  const result: DisplayBlock[] = []
  let currentGroup: DisplayBlock["tools"] = []
  let pendingCall: { name: string; input?: any } | null = null

  function flushGroup() {
    if (currentGroup.length > 0) {
      result.push({ type: "tool-group", tools: [...currentGroup] })
      currentGroup = []
    }
  }

  for (const p of parts) {
    if (p.type === "text") {
      flushGroup()
      if (p.text) result.push({ type: "text", text: p.text })
    } else if (p.type === "tool_call") {
      if (pendingCall) {
        currentGroup.push({ name: pendingCall.name, input: pendingCall.input })
      }
      pendingCall = { name: p.toolName || "Tool", input: p.toolInput }
    } else if (p.type === "tool_result") {
      currentGroup.push({
        name: pendingCall?.name || "Tool",
        input: pendingCall?.input,
        output: p.toolOutput,
      })
      pendingCall = null
    }
  }
  if (pendingCall) currentGroup.push({ name: pendingCall.name, input: pendingCall.input })
  flushGroup()
  return result
}

function MessageBubble(props: { message: Message }) {
  const isUser = () => props.message.role === "user"
  const hasTextParts = () => props.message.parts?.some(p => p.type === "text")

  // New format with interleaved parts
  if (hasTextParts()) {
    const merged = () => mergeParts(props.message.parts)
    return (
      <div class="flex flex-col gap-1">
        <For each={merged()}>
          {(block) => (
            <>
              <Show when={block.type === "text" && block.text}>
                <div class="flex flex-col items-start">
                  <div class="max-w-[92%] sm:max-w-[85%] rounded-2xl rounded-bl-md px-[15px] py-1.5" style="background: var(--bg-raised); color: var(--text-base); border: 1px solid var(--border-base)">
                    <MarkdownContent text={block.text!} />
                  </div>
                </div>
              </Show>
              <Show when={block.type === "tool-group"}>
                <div style="max-width: 85%">
                  <ToolCard tools={block.tools} />
                </div>
              </Show>
            </>
          )}
        </For>
      </div>
    )
  }

  // Old format or user message
  return (
    <div class="flex flex-col" classList={{ "items-end": isUser(), "items-start": !isUser() }}>
      <div
        class="max-w-[92%] sm:max-w-[85%] rounded-2xl px-[15px] py-1.5"
        classList={{ "rounded-br-md": isUser(), "rounded-bl-md": !isUser() }}
        style={isUser()
          ? "background: var(--accent); color: white"
          : "background: var(--bg-raised); color: var(--text-base); border: 1px solid var(--border-base)"
        }
      >
        <Show when={props.message.content}>
          <MarkdownContent text={props.message.content} />
        </Show>
      </div>
      {/* Tool cards outside bubble for old format (merge consecutive) */}
      <For each={mergeParts(props.message.parts?.filter(p => p.type !== "text") || [])}>
        {(block) => (
          <Show when={block.type === "tool-group"}>
            <div style="max-width: 85%">
              <ToolCard tools={block.tools} />
            </div>
          </Show>
        )}
      </For>
    </div>
  )
}

function QuestionDialog(props: { question: any; onAnswer: (ans: Record<string, string>) => void; onClose: () => void }) {
  const qs = () => props.question?.question?.questions || []
  const [answers, setAnswers] = createSignal<Record<string, string>>({})
  const [otherTexts, setOtherTexts] = createSignal<Record<string, string>>({})
  const allAnswered = () => qs().every((q: any) => {
    const key = q.header || q.question
    const hasOther = (q.options || []).some((o: any) => (typeof o === "object" && o.isOther))
    if (hasOther) return !!answers()[key] || !!otherTexts()[key]
    return !!answers()[key]
  })

  function selectAnswer(key: string, value: string, isOther?: boolean) {
    if (isOther) {
      setOtherTexts(prev => ({ ...prev, [key]: value }))
      setAnswers(prev => ({ ...prev, [key]: value }))
    } else {
      setOtherTexts(prev => { const n = { ...prev }; delete n[key]; return n })
      setAnswers(prev => ({ ...prev, [key]: value }))
    }
  }

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.5)" onClick={props.onClose}>
      <div class="rounded-xl p-5 max-w-lg w-full mx-4 shadow-lg flex flex-col gap-4 max-h-[80vh] overflow-y-auto" style="background: var(--bg-base); border: 1px solid var(--border-base)" onClick={e => e.stopPropagation()}>
        <h3 class="font-semibold text-sm" style="color: var(--text-strong)">Claude needs your input</h3>
        <For each={qs()}>
          {(q: any) => {
            const key = q.header || q.question
            const selected = () => answers()[key]
            const hasOther = (q.options || []).some((o: any) => (typeof o === "object" && o.isOther))
            const isOther = () => !!otherTexts()[key]
            return (
              <div class="flex flex-col gap-2">
                <p class="text-sm font-medium" style="color: var(--text-strong)">{q.question}</p>
                <Show when={q.description}><p class="text-xs" style="color: var(--text-weak)">{q.description}</p></Show>
                <div class="flex flex-col gap-1">
                  <For each={q.options || []}>
                    {(opt: any) => {
                      const label = typeof opt === "string" ? opt : (opt.label || "")
                      const desc = typeof opt === "object" ? opt.description : ""
                      const isOtherOption = typeof opt === "object" && opt.isOther
                      if (isOtherOption) {
                        return (
                          <div class="flex gap-2 items-center">
                            <input type="text"
                              value={otherTexts()[key] || ""}
                              onInput={e => selectAnswer(key, e.currentTarget.value, true)}
                              placeholder={label || "Other..."}
                              class="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                              style={{ background: "var(--bg-raised)", color: "var(--text-strong)", border: `1px solid ${isOther() ? "var(--accent)" : "var(--border-base)"}` }}
                            />
                          </div>
                        )
                      }
                      return (
                        <button onClick={() => selectAnswer(key, label)}
                          class="text-left px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors"
                          style={selected() === label && !isOther() ? { background: "var(--accent)", color: "white" } : { background: "var(--bg-stronger)", color: "var(--text-strong)" }}>
                          <span class="font-medium">{label}</span>
                          <Show when={desc}><span class="block text-xs mt-0.5 opacity-70">{desc}</span></Show>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </div>
            )
          }}
        </For>
        <button onClick={() => props.onAnswer(answers())} disabled={!allAnswered()}
          class="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer disabled:opacity-40"
          style="background: var(--accent); color: white">Submit</button>
      </div>
    </div>
  )
}

export function ChatPage() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [input, setInput] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [streamingText, setStreamingText] = createSignal("")
  const [thinkingTokens, setThinkingTokens] = createSignal(0)
  const [streamingTools, setStreamingTools] = createSignal<Array<{type:"tool_call"|"tool_result",toolName?:string,toolInput?:any,toolOutput?:string,toolId?:string}>>([])
  const [permissionMode, setPermissionMode] = createSignal("bypassPermissions")
  const [question, setQuestion] = createSignal<any>(null)
  const [optimisticUserMsg, setOptimisticUserMsg] = createSignal<Message | null>(null)
  const [sessionData, { refetch, mutate }] = createResource(
    () => params.id || null,
    (id) => id ? api.getSession(id) : Promise.resolve(null)
  )

  // Auto-send pending message from session creation
  onMount(() => {
    const pending = sessionStorage.getItem("pending-msg")
    if (pending && params.id) {
      sessionStorage.removeItem("pending-msg")
      setTimeout(() => { setInput(pending); send() }, 100)
    }
  })

  let scrollerRef!: HTMLDivElement
  let inputRef!: HTMLTextAreaElement

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (scrollerRef) scrollerRef.scrollTop = scrollerRef.scrollHeight
    })
  }

  async function send() {
    const text = input().trim()
    if (!text || sending()) return

    // Auto-create session if on home page
    let sid = params.id
    if (!sid) {
      try {
        const s = await api.createSession()
        sid = s.id
        // Store text so new page can auto-send
        sessionStorage.setItem("pending-msg", text)
        navigate(`/chat/${s.id}`, { replace: true })
        return // Let the new page instance handle sending
      } catch { return }
    }

    setInput("")
    setSending(true)
    setStreamingText("")
    setThinkingTokens(0)
    setStreamingTools([])
    // Optimistic user message
    setOptimisticUserMsg({
      id: "optimistic-" + Date.now(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    })
    scrollToBottom()

    try {
      await api.sendMessage(sid, text, (evt) => {
        switch (evt.event) {
          case "init":
            if (evt.data.permissionMode) setPermissionMode(evt.data.permissionMode)
            break
          case "thinking":
            setThinkingTokens(evt.data.tokens)
            break
          case "text-delta":
            setStreamingText(prev => prev + (evt.data.text || ""))
            scrollToBottom()
            break
          case "tool-start":
            setStreamingTools(prev => [...prev, { type: "tool_call", toolName: evt.data.toolName, toolInput: evt.data.toolInput, toolId: evt.data.toolId }])
            scrollToBottom()
            break
          case "tool-end":
            setStreamingTools(prev => [...prev, { type: "tool_result", toolOutput: evt.data.output, toolId: evt.data.toolId }])
            scrollToBottom()
            break
          case "question":
            console.log("Question received, opening dialog:", evt.data)
            setQuestion({ ...evt.data, sessionId: params.id })
            break
        }
      })
    } catch (err: any) {
      console.error("Send error:", err)
    } finally {
      setSending(false)
      // Append user + assistant messages locally (no flash)
      const finalText = streamingText()
      const finalTools = streamingTools()
      const cur = sessionData()
      if (cur) {
        const parts: any[] = []
        if (finalTools.length > 0) {
          for (const t of finalTools) {
            if (t.type === "tool_call") parts.push({ type: "tool_call", toolName: t.toolName, toolInput: t.toolInput, toolId: t.toolId })
            else parts.push({ type: "tool_result", toolOutput: t.toolOutput, toolId: t.toolId })
          }
        }
		if (finalText) parts.push({ type: "text", text: finalText })
        const newMsgs = [...cur.messages]
        // Remove optimistic, add real user + assistant
        newMsgs.push({ id: "user-" + Date.now(), role: "user", content: text, timestamp: Date.now() })
        if (finalText || parts.length > 0) {
          newMsgs.push({ id: "assistant-" + Date.now(), role: "assistant", content: finalText, parts, timestamp: Date.now() })
        }
        mutate({ ...cur, messages: newMsgs })
      }
      setStreamingText("")
      setThinkingTokens(0)
      setStreamingTools([])
      setOptimisticUserMsg(null)
      scrollToBottom()
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  onMount(() => {
    inputRef?.focus()
  })

  createEffect(() => {
    if (sessionData()?.messages) scrollToBottom()
  })

  return (
    <div class="h-full flex flex-col max-w-4xl mx-auto">
      {/* Messages */}
      <div
        ref={scrollerRef}
        class="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6"
      >
        <div class="flex flex-col gap-4">
          <Show
            when={!sessionData.loading}
            fallback={<div class="text-center py-8" style="color: var(--text-weak)">Loading...</div>}
          >
            <For each={sessionData()?.messages}>
              {(msg: Message) => <MessageBubble message={msg} />}
            </For>

            {/* Optimistic user message at bottom */}
            <Show when={optimisticUserMsg()}>
              {(msg) => <MessageBubble message={msg()} />}
            </Show>

            {/* Streaming assistant bubble */}
            <Show when={sending()}>
              <div class="flex flex-col items-start">
                <div
                  class="max-w-[92%] sm:max-w-[85%] rounded-2xl rounded-bl-md px-[15px] py-1.5"
                  style="background: var(--bg-raised); color: var(--text-base); border: 1px solid var(--border-base)"
                >
                  <Show when={thinkingTokens() > 0}>
                    <div class="text-xs mb-1" style="color: var(--text-weak)">
                      Thinking... ({thinkingTokens()} tokens)
                    </div>
                  </Show>
                  {/* Streaming tools */}
                  <For each={mergeParts(streamingTools() as any)}>
                    {(block) => (
                      <Show when={block.type === "tool-group"}>
                        <ToolCard tools={block.tools} />
                      </Show>
                    )}
                  </For>
                  <Show
                    when={streamingText()}
                    fallback={
                      <Show when={streamingTools().length === 0}>
                        <div class="flex gap-1">
                          <span class="animate-pulse">●</span>
                          <span class="animate-pulse" style="animation-delay: 0.2s">●</span>
                          <span class="animate-pulse" style="animation-delay: 0.4s">●</span>
                        </div>
                      </Show>
                    }
                  >
                    <MarkdownContent text={streamingText()} />
                  </Show>
                </div>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      {/* Input */}
      <div
        class="shrink-0 px-2 sm:px-3 pt-3 sm:pt-4 pb-2 mx-2 sm:mx-3 mb-2 sm:mb-3 rounded-2xl" style="padding-bottom: max(8px, env(safe-area-inset-bottom, 0px))"
        style="background: var(--bg-raised); border: 1px solid var(--border-base)"
      >
        <div class="flex gap-3 items-end">
          <textarea
            ref={inputRef}
            value={input()}
            onInput={(e) => {
              setInput(e.currentTarget.value)
              const el = e.currentTarget
              el.style.height = "auto"
              el.style.height = Math.min(el.scrollHeight, 72) + "px"
            }}
            onKeyDown={handleKeyDown}
            placeholder=""
            rows={1}
            disabled={sending()}
            class="flex-1 resize-none rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 text-[16px] sm:text-sm outline-none transition-all disabled:opacity-50"
			style="font-size: 16px" onFocus={(e) => { setTimeout(() => { e.currentTarget.style.fontSize = "" }, 100) }}
            style={{
              background: "var(--bg-base)",
              color: "var(--text-strong)",
              border: `1px solid var(--border-base)`,
              "min-height": sending() ? "42px" : "42px",
              "max-height": sending() ? "42px" : "72px",
              height: sending() ? "42px" : undefined,
            }}
          />
          <Show
            when={sending()}
            fallback={
              <button onClick={send} disabled={!input().trim()}
                class="shrink-0 px-5 py-3 rounded-2xl font-medium text-sm transition-all cursor-pointer disabled:opacity-40"
                style={{ background: "var(--accent)", color: "white" }}>Send</button>
            }
          >
            <button onClick={async () => {
              await api.abortSession(params.id!)
              setSending(false)
            }}
              class="shrink-0 px-5 py-3 rounded-2xl font-medium text-sm transition-all cursor-pointer"
              style={{ background: "#ef4444", color: "white" }}>Stop</button>
          </Show>
        </div>
        <div class="flex justify-between mt-2">
          <span class="text-[11px]" style={{ color: permissionMode() === "bypassPermissions" ? "#ff6b91" : "var(--text-weak)" }}>
            ⏵⏵ {permissionMode() === "default" ? "ask permissions" : permissionMode() === "acceptEdits" ? "auto-accept edits" : permissionMode() === "plan" ? "read-only plan" : "bypass permissions on"}
          </span>
          <span class="text-[11px]" style="color: var(--text-weak)">Enter ↵ · Shift+Enter ↵↵</span>
        </div>
      </div>

    </div>
  )
}
