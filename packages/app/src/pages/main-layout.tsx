import { createSignal, createResource, createEffect, For, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { api, type SessionInfo } from "../api/client"

function DialogOverlay(props: { closing: boolean; onClose: () => void; children: any }) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        animation: props.closing ? "fadeOut 0.2s ease-in forwards" : "fadeIn 0.3s ease-out",
      }}
      onClick={props.onClose}>
      <div style={{ animation: props.closing ? "scaleOut 0.2s ease-in forwards" : "scaleIn 0.3s ease-out" }}
        onClick={e => e.stopPropagation()}>
        {props.children}
      </div>
    </div>
  )
}

function ConfirmDialog(props: { message: string; confirmLabel?: string; confirmColor?: string; onConfirm: () => void; onCancel: () => void }) {
  const [closing, setClosing] = createSignal(false)
  const close = (fn: () => void) => {
    setClosing(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(fn, 200)
      })
    })
  }
  return (
    <DialogOverlay closing={closing()} onClose={() => close(props.onCancel)}>
      <div class="rounded-2xl p-6 w-80 shadow-xl flex flex-col gap-5" style="background: var(--bg-base); border: 1px solid var(--border-base)">
        <p class="text-[15px] text-center" style="color: var(--text-strong)">{props.message}</p>
        <div class="flex gap-3 justify-center">
          <button onClick={() => close(props.onCancel)} class="px-5 py-2 rounded-lg text-[15px] cursor-pointer hover:opacity-80 transition-opacity" style="background: var(--bg-stronger); color: var(--text-base)">Cancel</button>
          <button onClick={() => close(props.onConfirm)} class="px-5 py-2 rounded-lg text-[15px] font-medium cursor-pointer hover:opacity-80 transition-opacity" style={{ background: props.confirmColor || "#dc2626", color: "white" }}>{props.confirmLabel || "Confirm"}</button>
        </div>
      </div>
    </DialogOverlay>
  )
}

function Sidebar(props: { open: boolean; onClose: () => void; showConfirm: (msg: string, label?: string, color?: string) => Promise<boolean>; onNewSession: () => void; refreshTick: number }) {
  createEffect(() => { if (props.open) refetch() })
  const navigate = useNavigate()
  const params = useParams<{ id?: string }>()
  const [sessions, { refetch, mutate }] = createResource(() => props.refreshTick + 1, api.listSessions)
  const [deleting, setDeleting] = createSignal<Set<string>>(new Set())

  const formatTokens = (n: number) => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1000 ? (n/1e3).toFixed(1)+"K" : String(n)

  async function deleteSession(sessionId: string) {
    const ok = await props.showConfirm("Delete this session?", "Delete", "#dc2626")
    if (!ok) return
    setDeleting(prev => new Set(prev).add(sessionId))
    setTimeout(() => {
      const list = sessions()
      if (list) mutate(list.filter(s => s.sessionId !== sessionId))
      setDeleting(prev => { const n = new Set(prev); n.delete(sessionId); return n })
      if (params.id === sessionId) navigate("/")
    }, 300)
    api.deleteSession(sessionId).catch(console.error)
  }

  function formatDate(ts: number) {
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  return (
    <div
      class="fixed inset-y-0 left-0 z-40 w-[300px] flex flex-col transition-transform duration-300 ease-out"
      style={{
        background: "var(--bg-base)",
        "border-right": "1px solid var(--border-base)",
        transform: props.open ? "translateX(0)" : "translateX(-100%)",
      }}
    >
      <div class="flex items-center justify-between h-12 px-3 border-b" style="border-color: var(--border-base)">
        <h2 class="font-semibold text-[15px]" style="color: var(--text-strong)">Sessions</h2>
        <button onClick={props.onNewSession}
          class="w-6 h-6 rounded-full cursor-pointer transition-opacity hover:opacity-80 flex items-center justify-center text-[10px] font-bold"
          style={{ background: "#34d399", color: "white" }} title="New session">+</button>
      </div>
      <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        <Show when={!sessions.loading} fallback={<div class="text-[13px] p-4 text-center" style="color: var(--text-weak)">Loading...</div>}>
          <Show when={sessions.error}>
            <div class="text-[13px] p-4 text-center" style="color: #ef4444">{String(sessions.error)}</div>
          </Show>
          <Show when={sessions()?.length} fallback={
            <Show when={!sessions.error}><div class="text-[13px] p-4 text-center" style="color: var(--text-weak)">No sessions yet</div></Show>
          }>
            <For each={sessions()}>
              {(session: SessionInfo) => (
                <div
                  class="flex items-center justify-between p-2 rounded-xl transition-all duration-300 overflow-hidden group"
                  classList={{
                    "opacity-0 max-h-0! py-0! my-0! border-0! pointer-events-none": deleting().has(session.sessionId),
                  }}
                  style={{
                    background: params.id === session.sessionId ? "var(--bg-stronger)" : "var(--bg-raised)",
                    "max-height": deleting().has(session.sessionId) ? "0px" : "60px",
                  }}
                >
                  <div onClick={() => { props.onClose(); setTimeout(() => navigate(`/chat/${session.sessionId}`), 300) }} class="min-w-0 flex-1 cursor-pointer">
                    <div class="text-[15px] truncate" style={{ color: "var(--text-strong)" }}>{session.title || "Untitled"}</div>
                    <div class="text-[13px]" style="color: var(--text-weak)">
                      {session.messageCount} msgs
                      {session.inputTokens + session.outputTokens > 0 ? ` · in:${formatTokens(session.inputTokens)} out:${formatTokens(session.outputTokens)}` : ""}
                      {" · "}{formatDate(session.lastActivity)}
                    </div>
                  </div>
                  <button onClick={() => deleteSession(session.sessionId)} class="ml-2 px-2 py-1 rounded text-[11px] cursor-pointer shrink-0 font-medium" style={{ background: "#dc2626", color: "white" }}>Del</button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

    </div>
  )
}

export function MainLayout(props: { children: any }) {
  const navigate = useNavigate()
  const params = useParams<{ id?: string }>()
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [refreshTick, setRefreshTick] = createSignal(0)
  const [confirmMsg, setConfirmMsg] = createSignal("")
  const [confirmLabel, setConfirmLabel] = createSignal("Confirm")
  const [confirmColor, setConfirmColor] = createSignal("#dc2626")
  let confirmResolve: ((v: boolean) => void) | null = null

  // Load sessions to find title for header
  const [sessionList] = createResource(() => refreshTick() + 1, api.listSessions)

  function openNewSession() {
    setSidebarOpen(false)
    navigate("/chat/new")
  }

  function showConfirm(msg: string, label?: string, color?: string): Promise<boolean> {
    setConfirmLabel(label || "Confirm")
    setConfirmColor(color || "#dc2626")
    return new Promise(resolve => { setConfirmMsg(msg); confirmResolve = resolve })
  }

  const sessionTitle = () => {
    if (!params.id || params.id === "new") return "CChat-Web"
    const list = sessionList()
    const s = list?.find((s: SessionInfo) => s.sessionId === params.id)
    return s?.title || "CChat-Web"
  }

  return (
    <div class="h-dvh w-screen flex flex-col overflow-hidden" style="position: relative" style="background: var(--bg-base); color: var(--text-base)">
      {/* Overlay */}
      <Show when={sidebarOpen()}>
        <div class="fixed inset-0 z-30" style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }} onClick={() => setSidebarOpen(false)} />
      </Show>

      <Sidebar open={sidebarOpen()} onClose={() => setSidebarOpen(false)} showConfirm={showConfirm} onNewSession={openNewSession} refreshTick={refreshTick()} />

      <header class="shrink-0 flex items-center gap-3 px-3 h-12 border-b" style="border-color: var(--border-base); background: var(--bg-raised)">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen())}
          class="cursor-pointer p-1 rounded hover:opacity-80"
          style="color: var(--text-weak)"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <div class="font-medium text-[17px] truncate flex-1" style="color: var(--text-strong)">{sessionTitle()}</div>

        {/* macOS traffic lights */}
        <div class="flex items-center gap-3">
          <button onClick={async () => {
            if (!params.id || params.id === "new") return
            if (await showConfirm("Delete this session?", "Delete", "#dc2626")) { api.deleteSession(params.id); navigate("/") }
          }}
            class="w-[18px] h-[18px] rounded-full transition-opacity"
            classList={{ "cursor-pointer hover:opacity-80": !!params.id && params.id !== "new", "opacity-30 cursor-not-allowed": !params.id || params.id === "new" }}
            style={{ background: "#f87171" }} title={params.id && params.id !== "new" ? "Delete session" : "No session"} />
          <button onClick={async () => {
            if (!params.id || params.id === "new") return
            if (await showConfirm("Close this session?", "Close", "#fbbf24")) navigate("/")
          }}
            class="w-[18px] h-[18px] rounded-full transition-opacity"
            classList={{ "cursor-pointer hover:opacity-80": !!params.id && params.id !== "new", "opacity-30 cursor-not-allowed": !params.id || params.id === "new" }}
            style={{ background: "#fbbf24" }} title={params.id && params.id !== "new" ? "Close session" : "No session"} />
          <button onClick={openNewSession}
            class="w-[18px] h-[18px] rounded-full cursor-pointer hover:opacity-80 transition-opacity"
            style={{ background: "#34d399" }} title="New session" />
        </div>
      </header>

      <main class="flex-1 min-h-0 overflow-hidden">
        {props.children}
      </main>

      {/* Confirm Dialog */}
      <Show when={confirmMsg()}>
        <ConfirmDialog
          message={confirmMsg()}
          confirmLabel={confirmLabel()}
          confirmColor={confirmColor()}
          onConfirm={() => { setConfirmMsg(""); confirmResolve?.(true) }}
          onCancel={() => { setConfirmMsg(""); confirmResolve?.(false) }}
        />
      </Show>
    </div>
  )
}
