import { Loader2, CheckCircle2, XCircle, PauseCircle, CircleSlash, Circle } from 'lucide-react'
import type { RunStatus } from '@shared/events'
import { cn } from '@/lib/utils'

const MAP: Record<RunStatus, { label: string; className: string; icon: typeof Circle; spin?: boolean }> = {
  starting: { label: 'Starting', className: 'text-info', icon: Loader2, spin: true },
  running: { label: 'Running', className: 'text-info', icon: Loader2, spin: true },
  paused: { label: 'Paused', className: 'text-warning', icon: PauseCircle },
  completed: { label: 'Completed', className: 'text-success', icon: CheckCircle2 },
  failed: { label: 'Failed', className: 'text-destructive', icon: XCircle },
  cancelled: { label: 'Cancelled', className: 'text-muted-foreground', icon: CircleSlash },
}

export function StatusBadge({ status }: { status?: RunStatus }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Circle className="size-3" /> Idle
      </span>
    )
  }
  const cfg = MAP[status]
  const Icon = cfg.icon
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', cfg.className)}>
      <Icon className={cn('size-3.5', cfg.spin && 'animate-spin')} />
      {cfg.label}
    </span>
  )
}
