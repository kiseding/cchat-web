import { createSignal, createResource, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { api, type SessionInfo } from "../api/client"

export function HomePage() {
  const navigate = useNavigate()
  const [sessions, { refetch, mutate }] = createResource(api.listSessions)
  const [creating, setCreating] = createSignal(false)
  const [deleting, setDeleting] = createSignal<Set<string>>(new Set())
  const [showNameDialog, setShowNameDialog] = createSignal(false)
  const [newSessionName, setNewSessionName] = createSignal("")
  const [nameError, setNameError] = createSignal("")
  let nameInputRef!: HTMLInputElement

  function openNameDialog() {
    setNewSessionName("")
    setNameError("")
    setShowNameDialog(true)
    setTimeout(() => nameInputRef?.focus(), 50)
  }

  async function createNew() {
    setCreating(true)
    setNameError("")
    try {
      const session = await api.createSession(newSessionName().trim() || undefined)
      navigate(`/chat/${session.id}`)
    } catch (err: any) {
      setCreating(false)
      if (err.message?.includes("already exists")) {
        setNameError("Name already taken, choose another.")
      }
    }
  }

  function handleNameKey(e: KeyboardEvent) {
    if (e.key === "Enter") createNew()
    if (e.key === "Escape") setShowNameDialog(false)
  }

  function deleteSession(id: string) {
    // Mark as deleting for animation
    setDeleting(prev => new Set(prev).add(id))
    // Remove from UI after animation
    setTimeout(() => {
      const list = sessions()
      if (list) mutate(list.filter(s => s.id !== id))
      setDeleting(prev => { const n = new Set(prev); n.delete(id); return n })
    }, 300)
    // Delete on server in background
    api.deleteSession(id).catch(console.error)
  }

  function formatDate(ts: number) {
    const d = new Date(ts)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  return (
    <div class="h-full flex flex-col max-w-3xl mx-auto p-4">
      <div class="flex items-center justify-between mb-6 pt-4">
        <h1 class="text-2xl font-bold" style="color: var(--text-strong)">Sessions</h1>
        <button
          onClick={openNameDialog}
          disabled={creating()}
          class="px-4 py-2 rounded-lg font-medium text-sm transition-colors cursor-pointer disabled:opacity-50"
          style="background: var(--accent); color: white"
        >
          {creating() ? "Creating..." : "New Session"}
        </button>
      </div>

      <Show
        when={!sessions.loading}
        fallback={<div class="text-center py-12" style="color: var(--text-weak)">Loading...</div>}
      >
        <Show
          when={sessions()?.length}
          fallback={
            <div class="text-center py-16" style="color: var(--text-weak)">
              <p class="text-lg mb-4">No sessions yet</p>
              <p>Click "New Session" to start chatting with Claude Code</p>
            </div>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={sessions()}>
              {(session: SessionInfo) => (
                <div
                  class="flex items-center justify-between p-4 rounded-lg transition-all duration-500 ease-out overflow-hidden"
                  classList={{ "opacity-0 max-h-0! py-0! my-0! border-0! pointer-events-none": deleting().has(session.id) }}
                  style={{ background: "var(--bg-raised)", border: "1px solid var(--border-base)", "max-height": deleting().has(session.id) ? "0px" : "80px" }}
                >
                  <div
                    onClick={() => navigate(`/chat/${session.id}`)}
                    class="min-w-0 flex-1 cursor-pointer"
                  >
                    <div class="font-medium truncate" style="color: var(--text-strong)">
                      {session.title || "Untitled"}
                    </div>
                    <div class="text-sm mt-1" style="color: var(--text-weak)">
                      {session.messageCount} messages · {formatDate(session.updatedAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteSession(session.id)}
                    class="px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer shrink-0 ml-3"
                    style={{ background: "#dc2626", color: "white" }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Name dialog */}
      <Show when={showNameDialog()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center"
          style="background: rgba(0,0,0,0.4)"
          onClick={() => setShowNameDialog(false)}
        >
          <div
            class="rounded-xl p-6 w-96 shadow-lg flex flex-col gap-4"
            style="background: var(--bg-base); border: 1px solid var(--border-base)"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="text-lg font-semibold" style="color: var(--text-strong)">New Session</h2>
            <input
              ref={nameInputRef}
              type="text"
              value={newSessionName()}
              onInput={(e) => { setNewSessionName(e.currentTarget.value); setNameError("") }}
              onKeyDown={handleNameKey}
              placeholder="Session name (optional)"
              class="px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "var(--bg-raised)",
                color: "var(--text-strong)",
                border: `1px solid ${nameError() ? "#dc2626" : "var(--border-base)"}`,
              }}
            />
            <Show when={nameError()}>
              <p class="text-xs" style="color: #dc2626">{nameError()}</p>
            </Show>
            <div class="flex gap-2 justify-end">
              <button
                onClick={() => setShowNameDialog(false)}
                class="px-4 py-2 rounded-lg text-sm cursor-pointer"
                style="background: var(--bg-stronger); color: var(--text-base)"
              >
                Cancel
              </button>
              <button
                onClick={createNew}
                disabled={creating()}
                class="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer disabled:opacity-50"
                style="background: var(--accent); color: white"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
