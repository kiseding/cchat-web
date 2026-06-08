import { createSignal, createResource, createEffect, For, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { api, type SessionInfo } from "../api/client"

function ConfirmDialog(props: { message: string; confirmLabel?: string; confirmColor?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.5)" onClick={props.onCancel}>
      <div class="rounded-2xl p-6 w-80 shadow-lg flex flex-col gap-5" style="background: var(--bg-base); border: 1px solid var(--border-base)" onClick={e => e.stopPropagation()}>
        <p class="text-sm text-center" style="color: var(--text-strong)">{props.message}</p>
        <div class="flex gap-3 justify-center">
          <button onClick={props.onCancel} class="px-5 py-2 rounded-lg text-sm cursor-pointer" style="background: var(--bg-stronger); color: var(--text-base)">Cancel</button>
          <button onClick={props.onConfirm} class="px-5 py-2 rounded-lg text-sm font-medium cursor-pointer" style={{ background: props.confirmColor || "#dc2626", color: "white" }}>{props.confirmLabel || "Confirm"}</button>
        </div>
      </div>
    </div>
  )
}

function NewSessionDialog(props: { creating: boolean; nameError: string; name: string; onInput: (v: string) => void; onCreate: () => void; onClose: () => void }) {
  let nameInputRef!: HTMLInputElement
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.5)" onClick={props.onClose}>
      <div class="rounded-2xl p-5 w-80 shadow-lg flex flex-col gap-4" style="background: var(--bg-base); border: 1px solid var(--border-base)" onClick={e => e.stopPropagation()}>
        <h3 class="text-sm font-semibold" style="color: var(--text-strong)">New Session</h3>
        <input ref={nameInputRef} type="text" value={props.name} onInput={e => { props.onInput(e.currentTarget.value) }}
          onKeyDown={e => { e.key === "Enter" && props.onCreate(); e.key === "Escape" && props.onClose() }}
          placeholder="Session name (optional)" class="px-3 py-2 rounded-lg text-sm outline-none"
          style={{ background: "var(--bg-raised)", color: "var(--text-strong)", border: `1px solid ${props.nameError ? "#dc2626" : "var(--border-base)"}` }} />
        <Show when={props.nameError}><p class="text-xs" style={{ color: "#dc2626" }}>{props.nameError}</p></Show>
        <div class="flex gap-2 justify-end">
          <button onClick={props.onClose} class="px-4 py-2 rounded-lg text-sm cursor-pointer" style={{ background: "var(--bg-stronger)", color: "var(--text-base)" }}>Cancel</button>
          <button onClick={props.onCreate} disabled={props.creating} class="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer disabled:opacity-50" style={{ background: "#34d399", color: "white" }}>Create</button>
        </div>
      </div>
    </div>
  )
}

function Sidebar(props: { open: boolean; onClose: () => void; showConfirm: (msg: string, label?: string, color?: string) => Promise<boolean>; onNewSession: () => void; refreshTick: number }) {
  // Refetch when sidebar opens
  createEffect(() => {
    if (props.open) refetch()
  })
  const _showConfirm = props.showConfirm
  const navigate = useNavigate()
  const params = useParams<{ id?: string }>()
  const [sessions, { refetch, mutate }] = createResource(() => props.refreshTick, api.listSessions)
  const [deleting, setDeleting] = createSignal<Set<string>>(new Set())

  async function deleteSession(id: string) {
    const ok = await _showConfirm("Delete this session?", "Delete", "#dc2626")
    if (!ok) return
    setDeleting(prev => new Set(prev).add(id))
    setTimeout(() => {
      const list = sessions()
      if (list) mutate(list.filter(s => s.id !== id))
      setDeleting(prev => { const n = new Set(prev); n.delete(id); return n })
      // If current session was deleted, go home
      if (params.id === id) navigate("/")
    }, 300)
    api.deleteSession(id).catch(console.error)
  }

  function formatDate(ts: number) {
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  return (
    <div
      class="fixed inset-y-0 left-0 z-40 w-[360px] flex flex-col transition-transform duration-300 ease-out"
      style={{
        background: "var(--bg-base)",
        "border-right": "1px solid var(--border-base)",
        transform: props.open ? "translateX(0)" : "translateX(-100%)",
      }}
    >
      <div class="flex items-center justify-between h-12 px-3 border-b" style="border-color: var(--border-base)">
        <h2 class="font-semibold text-sm" style="color: var(--text-strong)">Sessions</h2>
        <button onClick={props.onNewSession}
          class="w-6 h-6 rounded-full cursor-pointer transition-opacity hover:opacity-80 flex items-center justify-center text-[10px] font-bold"
          style={{ background: "#34d399", color: "white" }} title="New session">+</button>
      </div>
      <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        <Show when={!sessions.loading} fallback={<div class="text-xs p-4 text-center" style="color: var(--text-weak)">Loading...</div>}>
          <Show when={sessions()?.length} fallback={
            <div class="text-xs p-4 text-center" style="color: var(--text-weak)">No sessions yet</div>
          }>
            <For each={sessions()}>
              {(session: SessionInfo) => (
                <div
                  class="flex items-center justify-between p-2 rounded-xl transition-all duration-300 overflow-hidden group"
                  classList={{
                    "opacity-0 max-h-0! py-0! my-0! border-0! pointer-events-none": deleting().has(session.id),
                  }}
                  style={{
                    background: params.id === session.id ? "var(--bg-stronger)" : "var(--bg-raised)",
                    "max-height": deleting().has(session.id) ? "0px" : "60px",
                  }}
                >
                  <div onClick={() => { navigate(`/chat/${session.id}`); props.onClose() }} class="min-w-0 flex-1 cursor-pointer">
                    <div class="text-sm truncate" style={{ color: "var(--text-strong)" }}>{session.title || "Untitled"}</div>
                    <div class="text-xs" style="color: var(--text-weak)">{session.messageCount} msgs · {formatDate(session.updatedAt)}</div>
                  </div>
                  <button onClick={() => deleteSession(session.id)} class="ml-2 px-2 py-1 rounded text-[11px] cursor-pointer shrink-0 font-medium" style={{ background: "#dc2626", color: "white" }}>Del</button>
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
  const [sessionData] = createResource(
    () => params.id || null,
    (id) => id ? api.getSession(id) : Promise.resolve(null)
  )

  // New session dialog state
  const [showNewDialog, setShowNewDialog] = createSignal(false)
  const [newSessionName, setNewSessionName] = createSignal("")
  const [newSessionError, setNewSessionError] = createSignal("")
  const [creating, setCreating] = createSignal(false)

  async function createNewSession() {
    setCreating(true)
    setNewSessionError("")
    try {
      const session = await api.createSession(newSessionName().trim() || undefined)
      navigate(`/chat/${session.id}`)
      setShowNewDialog(false)
      setRefreshTick(t => t + 1)
    } catch (err: any) {
      setCreating(false)
      if (err.message?.includes("already exists")) setNewSessionError("Name already taken.")
    }
  }

  function openNewDialog() {
    setNewSessionName("")
    setNewSessionError("")
    setShowNewDialog(true)
  }

  function showConfirm(msg: string, label?: string, color?: string): Promise<boolean> {
    setConfirmLabel(label || "Confirm")
    setConfirmColor(color || "#dc2626")
    return new Promise(resolve => { setConfirmMsg(msg); confirmResolve = resolve })
  }

  const sessionTitle = () => {
    if (!params.id) return "CChat-Web"
    const d = sessionData()
    return d?.title || "CChat-Web"
  }

  return (
    <div class="h-dvh w-screen flex flex-col overflow-hidden" style="background: var(--bg-base); color: var(--text-base)">
      {/* Overlay */}
      <Show when={sidebarOpen()}>
        <div class="fixed inset-0 z-30" style="background: rgba(0,0,0,0.3)" onClick={() => setSidebarOpen(false)} />
      </Show>

      <Sidebar open={sidebarOpen()} onClose={() => setSidebarOpen(false)} showConfirm={showConfirm} onNewSession={openNewDialog} refreshTick={refreshTick()} />

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
        <div class="font-medium text-base truncate flex-1" style="color: var(--text-strong)">{sessionTitle()}</div>

        {/* macOS traffic lights */}
        <div class="flex items-center gap-3">
          <button onClick={async () => {
            if (!params.id) return
            if (await showConfirm("Delete this session?", "Delete", "#dc2626")) { api.deleteSession(params.id); navigate("/") }
          }}
            class="w-[18px] h-[18px] rounded-full transition-opacity"
            classList={{ "cursor-pointer hover:opacity-80": !!params.id, "opacity-30 cursor-not-allowed": !params.id }}
            style={{ background: "#f87171" }} title={params.id ? "Delete session" : "No session"} />
          <button onClick={async () => {
            if (!params.id) return
            if (await showConfirm("Close this session?", "Close", "#fbbf24")) navigate("/")
          }}
            class="w-[18px] h-[18px] rounded-full transition-opacity"
            classList={{ "cursor-pointer hover:opacity-80": !!params.id, "opacity-30 cursor-not-allowed": !params.id }}
            style={{ background: "#fbbf24" }} title={params.id ? "Close session" : "No session"} />
          <button onClick={openNewDialog}
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

      {/* New Session Dialog */}
      <Show when={showNewDialog()}>
        <NewSessionDialog
          creating={creating()}
          nameError={newSessionError()}
          name={newSessionName()}
          onInput={setNewSessionName}
          onCreate={createNewSession}
          onClose={() => setShowNewDialog(false)}
        />
      </Show>
    </div>
  )
}
