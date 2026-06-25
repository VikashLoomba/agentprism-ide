import { PauseCircle, Play, StepForward, Square } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { Button } from '@/components/ui/button'

export function PauseInspector() {
  const pause = useStore((s) => s.run?.pause)
  const resumeRun = useStore((s) => s.resumeRun)
  const stepRun = useStore((s) => s.stepRun)
  const cancelRun = useStore((s) => s.cancelRun)
  if (!pause) return null

  return (
    <div className="shrink-0 border-y border-warning/40 bg-warning/10 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <PauseCircle className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-[12px]">
          Paused after <b className="font-semibold">{pause.label ?? 'agent'}</b>
          <span className="text-muted-foreground"> · line {pause.line}</span>
        </span>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="outline" className="h-7" onClick={stepRun}>
            <StepForward className="size-3.5" /> Step
          </Button>
          <Button size="sm" className="h-7" onClick={resumeRun}>
            <Play className="size-3.5" /> Resume
          </Button>
          <Button size="sm" variant="destructive" className="h-7" onClick={cancelRun}>
            <Square className="size-3.5" />
          </Button>
        </div>
      </div>
      {pause.output && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px] text-foreground/90">
          {pause.output}
        </pre>
      )}
      {pause.resultJson !== undefined && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] text-foreground/90">
          {JSON.stringify(pause.resultJson, null, 2)}
        </pre>
      )}
    </div>
  )
}
