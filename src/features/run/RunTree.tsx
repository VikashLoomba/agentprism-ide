import { useState } from 'react'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  CircleSlash,
  PauseCircle,
  Circle,
  ChevronRight,
  Wrench,
  Brain,
  Hash,
} from 'lucide-react'
import type { AgentCallState, AgentCallStatus, RunSnapshot } from '@shared/events'
import type { AcpAgentId } from '@shared/agents'
import { useStore } from '@/store/useStore'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const STATUS_ICON: Record<AgentCallStatus, { icon: typeof Circle; className: string; spin?: boolean }> = {
  pending: { icon: Circle, className: 'text-muted-foreground' },
  running: { icon: Loader2, className: 'text-info', spin: true },
  paused: { icon: PauseCircle, className: 'text-warning' },
  completed: { icon: CheckCircle2, className: 'text-success' },
  failed: { icon: XCircle, className: 'text-destructive' },
  skipped: { icon: CircleSlash, className: 'text-muted-foreground' },
}

/** Fallback display names, used before the agents list loads. */
const AGENT_NAME_FALLBACK: Record<AcpAgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

/** Build a compact badge string from a per-call session config object. */
function formatConfigBadge(config: AgentCallState['config']): string | null {
  if (!config) return null
  const entries = Object.entries(config)
  if (entries.length === 0) return null
  const { model, rest } = entries.reduce<{
    model?: string | boolean
    rest: [string, string | boolean][]
  }>(
    (acc, [key, value]) => {
      if (key === 'model') acc.model = value
      else acc.rest.push([key, value])
      return acc
    },
    { rest: [] },
  )
  const parts: string[] = []
  if (model != null && model !== '') parts.push(String(model))
  for (const [key, value] of rest) parts.push(`${key}=${value}`)
  return parts.length > 0 ? parts.join(' ') : null
}

function AgentCard({ agent, paused }: { agent: AgentCallState; paused: boolean }) {
  const [open, setOpen] = useState(false)
  const agentName = useStore(
    (s) => s.agents.find((a) => a.id === agent.agent)?.name ?? AGENT_NAME_FALLBACK[agent.agent] ?? agent.agent,
  )
  const cfg = STATUS_ICON[agent.status]
  const Icon = cfg.icon
  const preview = (agent.message || agent.thoughts || '').slice(-160).trim()
  const configBadge = formatConfigBadge(agent.config)

  return (
    <div
      className={cn(
        'rounded-md border bg-card/60 transition-colors',
        paused ? 'border-warning/70 ring-1 ring-warning/30' : 'border-border/60',
      )}
    >
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className={cn('size-4 shrink-0', cfg.className, cfg.spin && 'animate-spin')} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{agent.label}</span>
        <span className="rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[10px] font-semibold text-foreground/70">
          {agentName}
        </span>
        {configBadge && (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">{configBadge}</span>
        )}
        {agent.structured && <span className="text-[10px] text-info">{'{ }'}</span>}
        {agent.line != null && (
          <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground">
            <Hash className="size-2.5" />
            {agent.line}
          </span>
        )}
      </button>

      {!open && preview && (
        <div className="truncate px-2.5 pb-1.5 pl-8 text-[11px] text-muted-foreground">{preview}</div>
      )}

      {open && (
        <div className="space-y-2 border-t border-border/50 px-2.5 py-2 text-[12px]">
          <Field label="Prompt">{agent.prompt}</Field>
          {agent.toolCalls.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <Wrench className="size-3" /> Tools
              </div>
              <div className="space-y-0.5">
                {agent.toolCalls.map((t) => (
                  <div key={t.id} className="flex items-center gap-1.5 text-[11px]">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        t.status === 'completed' ? 'bg-success' : t.status === 'failed' ? 'bg-destructive' : 'bg-info',
                      )}
                    />
                    <span className="truncate">{t.title}</span>
                    <span className="text-muted-foreground">{t.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {agent.thoughts && (
            <Field label="Thinking" icon={<Brain className="size-3" />}>
              {agent.thoughts}
            </Field>
          )}
          {(agent.message || agent.output) && <Field label="Output">{agent.output || agent.message}</Field>}
          {agent.resultJson !== undefined && (
            <Field label="Result (JSON)" mono>
              {JSON.stringify(agent.resultJson, null, 2)}
            </Field>
          )}
          {agent.error && <div className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{agent.error}</div>}
          {agent.tokens?.total != null && (
            <div className="text-[10px] text-muted-foreground">{agent.tokens.total.toLocaleString()} tokens</div>
          )}
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  children,
  mono,
  icon,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
  icon?: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          'max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 text-[11px] leading-relaxed text-foreground/90',
          mono && 'font-mono',
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function RunTree({ run }: { run: RunSnapshot }) {
  const pauseAgentId = useStore((s) => s.run?.pause?.agentId)
  const byId = new Map(run.agents.map((a) => [a.id, a]))
  const grouped = run.phases
    .map((p) => ({ phase: p, agents: p.agentIds.map((id) => byId.get(id)).filter(Boolean) as AgentCallState[] }))
    .filter((g) => g.agents.length > 0 || run.phases.length > 1)
  const ungrouped = run.agents.filter((a) => !run.phases.some((p) => p.agentIds.includes(a.id)))

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3">
        {grouped.map(({ phase, agents }) => (
          <div key={phase.title}>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">{phase.title}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {agents.filter((a) => a.status === 'completed').length}/{agents.length}
              </span>
              <div className="h-px flex-1 bg-border/60" />
            </div>
            <div className="space-y-1.5">
              {agents.map((a) => (
                <AgentCard key={a.id} agent={a} paused={a.id === pauseAgentId} />
              ))}
              {agents.length === 0 && <p className="pl-1 text-[11px] text-muted-foreground/70">no agents yet</p>}
            </div>
          </div>
        ))}
        {ungrouped.length > 0 && (
          <div className="space-y-1.5">
            {ungrouped.map((a) => (
              <AgentCard key={a.id} agent={a} paused={a.id === pauseAgentId} />
            ))}
          </div>
        )}
        {run.agents.length === 0 && (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No agents have started yet. Agents appear here as the workflow runs.
          </p>
        )}
      </div>
    </ScrollArea>
  )
}
