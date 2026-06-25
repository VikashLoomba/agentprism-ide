import { CheckCircle2, AlertTriangle, XCircle, CircleDot } from 'lucide-react'
import { useStore } from '@/store/useStore'

export function EditorStatusBar() {
  const validation = useStore((s) => s.validation)
  const breakpoints = useStore((s) => s.breakpoints)
  const errors = validation.diagnostics.filter((d) => d.severity === 'error')
  const warnings = validation.diagnostics.filter((d) => d.severity === 'warning')
  const firstError = errors[0] ?? warnings[0]

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-sidebar px-3 text-[11px] text-muted-foreground">
      {errors.length === 0 ? (
        <span className="inline-flex items-center gap-1 text-success">
          <CheckCircle2 className="size-3.5" /> Valid
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-destructive">
          <XCircle className="size-3.5" /> {errors.length} error{errors.length > 1 ? 's' : ''}
        </span>
      )}
      {warnings.length > 0 && (
        <span className="inline-flex items-center gap-1 text-warning">
          <AlertTriangle className="size-3.5" /> {warnings.length}
        </span>
      )}
      {firstError && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
          L{firstError.startLine}: {firstError.message}
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-1">
        <CircleDot className="size-3 text-destructive" />
        {breakpoints.length} breakpoint{breakpoints.length === 1 ? '' : 's'}
      </span>
      <span className="text-muted-foreground/60">JavaScript · DSL</span>
    </div>
  )
}
