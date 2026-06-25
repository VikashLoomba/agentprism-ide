import { CheckCircle2, XCircle, Clock, Bot, Hash } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { ScrollArea } from '@/components/ui/scroll-area'

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1">
      {icon}
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="ml-auto text-[12px] font-semibold tabular-nums">{value}</span>
    </div>
  )
}

export function ResultPanel() {
  const run = useStore((s) => s.run)
  if (!run) {
    return <p className="px-3 py-8 text-center text-xs text-muted-foreground">Run a workflow to see its result here.</p>
  }
  const { stats } = run
  const result = run.result
  const resultText = typeof result === 'string' ? result : result !== undefined ? JSON.stringify(result, null, 2) : null

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Stat icon={<Bot className="size-3.5 text-primary" />} label="Agents" value={String(stats.agentCount)} />
          <Stat icon={<CheckCircle2 className="size-3.5 text-success" />} label="OK" value={String(stats.completed)} />
          <Stat icon={<XCircle className="size-3.5 text-destructive" />} label="Failed" value={String(stats.failed)} />
          <Stat icon={<Clock className="size-3.5 text-info" />} label="Time" value={`${(stats.durationMs / 1000).toFixed(1)}s`} />
          {stats.tokens.total != null && (
            <Stat icon={<Hash className="size-3.5 text-muted-foreground" />} label="Tokens" value={stats.tokens.total.toLocaleString()} />
          )}
        </div>

        {run.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {run.error}
          </div>
        )}

        {resultText != null ? (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Returned value</div>
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-[12px] leading-relaxed text-foreground/90">
              {resultText}
            </pre>
          </div>
        ) : (
          run.finishedAt && <p className="text-center text-xs text-muted-foreground">The workflow returned no value.</p>
        )}
      </div>
    </ScrollArea>
  )
}
