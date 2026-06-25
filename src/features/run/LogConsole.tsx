import { useEffect, useRef, useState } from 'react'
import { Terminal, ArrowDownToLine } from 'lucide-react'
import type { AcpEventLevel, AcpLogEntry } from '@shared/events'
import { useStore } from '@/store/useStore'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const LEVEL_CLASS: Record<AcpEventLevel, string> = {
  system: 'text-muted-foreground',
  info: 'text-foreground/70',
  message: 'text-foreground/90',
  thought: 'text-primary/80 italic',
  tool: 'text-info',
  plan: 'text-chart-2',
  permission: 'text-warning',
  warn: 'text-warning',
  error: 'text-destructive',
}

function time(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

function Line({ entry }: { entry: AcpLogEntry }) {
  return (
    <div className="flex gap-2 px-3 py-px hover:bg-accent/30">
      <span className="shrink-0 select-none tabular-nums text-muted-foreground/50">{time(entry.ts)}</span>
      {entry.agentLabel && <span className="shrink-0 max-w-28 truncate text-primary/70">{entry.agentLabel}</span>}
      <span className={cn('min-w-0 whitespace-pre-wrap break-words', LEVEL_CLASS[entry.level])}>{entry.text}</span>
    </div>
  )
}

export function LogConsole() {
  // Select the whole run (a fresh object each flush) so we re-render as the
  // in-place-mutated log array grows.
  const log = useStore((s) => s.run?.log)
  const logLen = useStore((s) => s.run?.log.length ?? 0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    if (stick && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logLen, stick])

  const entries = log ?? []
  const view = entries.length > 1200 ? entries.slice(entries.length - 1200) : entries

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom !== stick) setStick(atBottom)
  }

  return (
    <div className="relative flex h-full flex-col bg-[#161619]">
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
        <Terminal className="size-3.5" />
        <span className="font-semibold uppercase tracking-wider">ACP Event Log</span>
        <span className="tabular-nums text-muted-foreground/60">{entries.length}</span>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto py-1 font-mono text-[11px] leading-relaxed">
        {view.length === 0 && (
          <p className="px-3 py-6 text-center text-muted-foreground/70">
            ACP events (agent spawns, tool calls, permissions, stderr) stream here during a run.
          </p>
        )}
        {view.map((e) => (
          <Line key={e.id} entry={e} />
        ))}
      </div>
      {!stick && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 right-3 h-7 gap-1 text-[11px] shadow"
          onClick={() => setStick(true)}
        >
          <ArrowDownToLine className="size-3.5" /> Follow
        </Button>
      )}
    </div>
  )
}
