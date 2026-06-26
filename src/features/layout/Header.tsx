import { Play, Square, StepForward, Save, Circle, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/store/useStore'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { StatusBadge } from './StatusBadge'
import { WorkspacePicker } from '@/features/workspace/WorkspacePicker'
import { cn } from '@/lib/utils'

export function Header() {
  const run = useStore((s) => s.run)
  const validation = useStore((s) => s.validation)
  const inputsValid = useStore((s) => s.inputsValid)
  const wsStatus = useStore((s) => s.wsStatus)
  const fileName = useStore((s) => s.fileName)
  const dirty = useStore((s) => s.dirty)
  const startRun = useStore((s) => s.startRun)
  const cancelRun = useStore((s) => s.cancelRun)
  const resumeRun = useStore((s) => s.resumeRun)
  const stepRun = useStore((s) => s.stepRun)
  const saveCurrent = useStore((s) => s.saveCurrent)

  const errors = validation.diagnostics.filter((d) => d.severity === 'error').length
  const isActive = !!run && !run.finishedAt && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled'
  const paused = run?.status === 'paused'
  const canRun = validation.ok && inputsValid && wsStatus === 'open' && !isActive

  async function handleSave() {
    try {
      let name = fileName
      if (!name) {
        const input = window.prompt('Save workflow as:', (validation.meta?.name ?? 'workflow') + '.js')
        if (!input) return
        name = input
      }
      const info = await saveCurrent(name)
      toast.success(`Saved ${info?.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-sidebar px-4 no-drag">
      <div className="flex items-center gap-2.5">
        <img src="/prism.svg" alt="" className="size-7" />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">AgentPrism</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Dynamic Agent Workflows</div>
        </div>
      </div>

      <Separator orientation="vertical" className="mx-1 !h-7" />
      <WorkspacePicker />

      <Separator orientation="vertical" className="mx-1 !h-7" />

      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate font-medium text-foreground/90">{fileName ?? 'untitled workflow'}</span>
        {dirty && <span className="size-1.5 rounded-full bg-warning" title="Unsaved changes" />}
      </div>

      {errors > 0 && (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="size-3.5" />
          {errors} error{errors > 1 ? 's' : ''}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-xs',
            wsStatus === 'open' ? 'text-success' : wsStatus === 'connecting' ? 'text-warning' : 'text-destructive',
          )}
          title={`Backend ${wsStatus}`}
        >
          <Circle className="size-2 fill-current" />
          {wsStatus === 'open' ? 'connected' : wsStatus}
        </span>

        <StatusBadge status={run?.status} />

        <Separator orientation="vertical" className="mx-1 !h-7" />

        <Button size="sm" variant="ghost" onClick={handleSave} title="Save workflow (saves to a local .js file)">
          <Save className="size-4" />
          Save
        </Button>

        {paused ? (
          <>
            <Button size="sm" variant="outline" onClick={stepRun} title="Run to the next agent, then pause">
              <StepForward className="size-4" />
              Step
            </Button>
            <Button size="sm" onClick={resumeRun} title="Continue until the next breakpoint">
              <Play className="size-4" />
              Resume
            </Button>
            <Button size="sm" variant="destructive" onClick={cancelRun}>
              <Square className="size-4" />
            </Button>
          </>
        ) : isActive ? (
          <Button size="sm" variant="destructive" onClick={cancelRun}>
            <Square className="size-4" />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={startRun}
            disabled={!canRun}
            title={
              !validation.ok
                ? 'Fix validation errors first'
                : !inputsValid
                  ? 'Fill required inputs'
                  : 'Run workflow'
            }
          >
            <Play className="size-4" />
            Run
          </Button>
        )}
      </div>
    </header>
  )
}
