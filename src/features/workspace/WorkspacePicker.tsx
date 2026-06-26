import { Bell, FolderOpen, X } from 'lucide-react'
import { useStore } from '@/store/useStore'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const OPEN_SENTINEL = '__open_folder__'

/** Per-workspace status dot driven by the derived `workspaceAttention` map (c4). */
function StatusDot({ status }: { status: 'idle' | 'running' | 'needs-input' | 'error' }) {
  if (status === 'idle') return null
  const cls =
    status === 'running'
      ? 'bg-primary animate-pulse'
      : status === 'needs-input'
        ? 'bg-warning animate-pulse'
        : 'bg-destructive'
  return <span className={cn('size-2 shrink-0 rounded-full', cls)} title={status} />
}

export function WorkspacePicker() {
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const attention = useStore((s) => s.workspaceAttention)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const closeWorkspace = useStore((s) => s.closeWorkspace)

  async function handleChange(value: string) {
    if (value === OPEN_SENTINEL) {
      const root = window.prompt('Open workspace folder (absolute path):')
      if (!root) return
      const id = await openWorkspace(root)
      await setActiveWorkspace(id)
      return
    }
    await setActiveWorkspace(value)
  }

  // Global "background workspace needs input" indicator: visible iff a NON-active,
  // still-open workspace is blocked on a permission/input request (list-scoped, so
  // a stale/dangling attention entry for a closed ws can never relight it).
  const backgroundNeedsInput = workspaces.some(
    (w) => w.id !== activeWorkspaceId && attention[w.id]?.status === 'needs-input',
  )
  function handleBell() {
    const target = workspaces.find(
      (w) => w.id !== activeWorkspaceId && attention[w.id]?.status === 'needs-input',
    )
    if (target) void setActiveWorkspace(target.id)
  }

  return (
    <div className="flex items-center gap-1.5">
      <Select value={activeWorkspaceId || undefined} onValueChange={(v) => void handleChange(v)}>
        <SelectTrigger size="sm" className="max-w-[220px]">
          <SelectValue placeholder="Workspace" />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id} className="pr-2">
              <span className="flex min-w-0 items-center gap-2" title={w.root}>
                <StatusDot status={attention[w.id]?.status ?? 'idle'} />
                <span className="truncate">{w.name}</span>
                {w.id !== activeWorkspaceId && (
                  <button
                    type="button"
                    aria-label={`Close ${w.name}`}
                    disabled={workspaces.length === 1}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      void closeWorkspace(w.id)
                    }}
                    className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={OPEN_SENTINEL}>
            <span className="flex items-center gap-2">
              <FolderOpen className="size-3.5" />
              Open folder…
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      {backgroundNeedsInput && (
        <button
          type="button"
          onClick={handleBell}
          title="A background workspace needs input — click to switch"
          className="relative rounded p-1 text-warning hover:bg-accent"
        >
          <Bell className="size-4" />
          <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />
        </button>
      )}
    </div>
  )
}
