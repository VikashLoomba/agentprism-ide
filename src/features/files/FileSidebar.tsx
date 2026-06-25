import { useEffect } from 'react'
import { FilePlus2, RefreshCw, Trash2, FileCode2, Wrench, Share2, AlertTriangle, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import type { CapabilityCatalogEntry, PromptCatalogEntry } from '@shared/protocol'
import { useStore } from '@/store/useStore'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export function FileSidebar() {
  const files = useStore((s) => s.files)
  const fileName = useStore((s) => s.fileName)
  const refreshFiles = useStore((s) => s.refreshFiles)
  const openFile = useStore((s) => s.openFile)
  const newFile = useStore((s) => s.newFile)
  const deleteFileByName = useStore((s) => s.deleteFileByName)
  const capabilities = useStore((s) => s.capabilities)
  const usedCapabilities = useStore((s) => s.validation.meta?.capabilities)
  const prompts = useStore((s) => s.prompts)
  const openPrompt = useStore((s) => s.openPrompt)
  const openTool = useStore((s) => s.openTool)

  useEffect(() => {
    refreshFiles()
  }, [refreshFiles])

  async function handleOpen(name: string) {
    try {
      await openFile(name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open file')
    }
  }

  async function handleDelete(e: React.MouseEvent, name: string) {
    e.stopPropagation()
    if (!window.confirm(`Delete ${name}? This removes the local file.`)) return
    try {
      await deleteFileByName(name)
      toast.success(`Deleted ${name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  // Tool/capability .ts modules open into the editor (TypeScript) via the real
  // /api/tools/:tier/:name route — editable + saveable, like workflows/prompts.
  // Opening is allowed even when a tool has a loadError, so it can be fixed.
  async function handleOpenTool(cap: CapabilityCatalogEntry) {
    const fileName = cap.path.split('/').pop()
    if (!fileName) {
      toast.error(`Could not resolve a filename for ${cap.name}`)
      return
    }
    try {
      await openTool(cap.tier, fileName)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not open ${cap.name}`)
    }
  }

  // Prompt templates are pure Handlebars files opened into the editor (with a
  // live-preview pane) via the real /api/prompts/:tier/:name route.
  async function handleOpenPrompt(prompt: PromptCatalogEntry) {
    if (prompt.loadError) {
      toast.error(`${prompt.name}: ${prompt.loadError}`)
      return
    }
    try {
      await openPrompt(prompt.tier, prompt.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not open ${prompt.name}`)
    }
  }

  const projectTools = capabilities.filter((c) => c.tier === 'project')
  const userTools = capabilities.filter((c) => c.tier === 'user')
  const projectPrompts = prompts.filter((p) => p.tier === 'project')
  const userPrompts = prompts.filter((p) => p.tier === 'user')

  // Non-portable hint: the active workflow leans on a user-tier (Shared tools)
  // capability, so it won't run unchanged for someone without that mount.
  const usesUserTier =
    !!usedCapabilities &&
    userTools.some(
      (u) =>
        usedCapabilities.includes(u.name) ||
        usedCapabilities.includes(`user:${u.name}`) ||
        usedCapabilities.includes(`@me/${u.name}`),
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Workflows</span>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-6" onClick={() => refreshFiles()} title="Refresh">
            <RefreshCw className="size-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="size-6" onClick={newFile} title="New workflow">
            <FilePlus2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-2">
          {files.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No saved workflows yet. Write one and hit Save.
            </p>
          )}
          {files.map((f) => (
            <button
              key={f.name}
              onClick={() => handleOpen(f.name)}
              className={cn(
                'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                fileName === f.name ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <FileCode2 className="size-3.5 shrink-0 text-primary/80" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <Trash2
                className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                onClick={(e) => handleDelete(e, f.name)}
              />
            </button>
          ))}
        </div>

        {projectTools.length > 0 && (
          <ToolSection
            label="Tools"
            icon={<Wrench className="size-3.5 shrink-0 text-primary/80" />}
            tools={projectTools}
            onOpen={handleOpenTool}
          />
        )}

        {userTools.length > 0 && (
          <ToolSection
            label="Shared tools"
            icon={<Share2 className="size-3.5 shrink-0 text-primary/80" />}
            tools={userTools}
            onOpen={handleOpenTool}
            hint={
              usesUserTier
                ? 'This workflow uses a Shared tool — it is not portable without that mount.'
                : undefined
            }
          />
        )}

        {projectPrompts.length > 0 && (
          <PromptSection
            label="Prompts"
            icon={<MessageSquare className="size-3.5 shrink-0 text-primary/80" />}
            prompts={projectPrompts}
            onOpen={handleOpenPrompt}
          />
        )}

        {userPrompts.length > 0 && (
          <PromptSection
            label="Shared prompts"
            icon={<MessageSquare className="size-3.5 shrink-0 text-primary/80" />}
            prompts={userPrompts}
            onOpen={handleOpenPrompt}
          />
        )}
      </ScrollArea>
    </div>
  )
}

function ToolSection({
  label,
  icon,
  tools,
  onOpen,
  hint,
}: {
  label: string
  icon: React.ReactNode
  tools: CapabilityCatalogEntry[]
  onOpen: (cap: CapabilityCatalogEntry) => void
  hint?: string
}) {
  return (
    <div className="border-t border-border/50">
      <div className="px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="px-2 pb-2">
        {tools.map((cap) => (
          <button
            key={`${cap.tier}:${cap.name}`}
            onClick={() => onOpen(cap)}
            title={cap.loadError ? cap.loadError : cap.path}
            className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/50"
          >
            {icon}
            <span className="min-w-0 flex-1 truncate">{cap.name}</span>
            {cap.loadError && (
              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
            )}
          </button>
        ))}
        {hint && (
          <p className="px-2 pt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-500">{hint}</p>
        )}
      </div>
    </div>
  )
}

function PromptSection({
  label,
  icon,
  prompts,
  onOpen,
}: {
  label: string
  icon: React.ReactNode
  prompts: PromptCatalogEntry[]
  onOpen: (prompt: PromptCatalogEntry) => void
}) {
  return (
    <div className="border-t border-border/50">
      <div className="px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="px-2 pb-2">
        {prompts.map((prompt) => (
          <button
            key={`${prompt.tier}:${prompt.name}`}
            onClick={() => onOpen(prompt)}
            title={prompt.loadError ? prompt.loadError : prompt.path}
            className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/50"
          >
            {icon}
            <span className="min-w-0 flex-1 truncate">{prompt.name}</span>
            {prompt.loadError && (
              <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
