import { useEffect } from 'react'
import { FilePlus2, RefreshCw, Trash2, FileCode2 } from 'lucide-react'
import { toast } from 'sonner'
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
      <ScrollArea className="flex-1">
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
      </ScrollArea>
    </div>
  )
}
