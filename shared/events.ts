import type { AcpAgentId, SessionModeState } from './agents.ts'
import type { WorkflowMeta } from './dsl.ts'

export type RunStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type AgentCallStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'skipped'

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface ToolCallState {
  id: string
  title: string
  kind?: string
  status: ToolCallStatus
  /** Optional file path the tool is acting on, for follow-along UI. */
  locations?: string[]
}

export interface AgentTokenUsage {
  input?: number
  output?: number
  total?: number
}

/** One agent() invocation within a run. */
export interface AgentCallState {
  id: string
  /** Monotonic call order (matches pi-dynamic-workflows callIndex semantics). */
  callIndex: number
  /** Which connected ACP backend ran this call (drives the per-call UI badge). */
  agent: AcpAgentId
  label: string
  phase: string
  prompt: string
  /** 1-based source line of the agent() call, when known. */
  line?: number
  config?: Record<string, string | boolean>
  /** True when the call requested structured (schema) output. */
  structured?: boolean
  status: AgentCallStatus
  /** Accumulated assistant message text. */
  message: string
  /** Accumulated reasoning/thought text. */
  thoughts: string
  /** Final returned value: text, or the validated object for schema calls. */
  output?: string
  resultJson?: unknown
  error?: string
  tokens?: AgentTokenUsage
  toolCalls: ToolCallState[]
  startedAt?: number
  finishedAt?: number
}

export interface PhaseState {
  title: string
  detail?: string
  /** IDs of agent calls grouped under this phase. */
  agentIds: string[]
}

export type AcpEventLevel =
  | 'system'
  | 'info'
  | 'message'
  | 'thought'
  | 'tool'
  | 'plan'
  | 'permission'
  | 'warn'
  | 'error'

/** A single line in the terminal-style ACP event console. */
export interface AcpLogEntry {
  id: string
  ts: number
  agentId?: string
  agentLabel?: string
  level: AcpEventLevel
  /** Wire-ish event name, e.g. 'agent_message_chunk', 'tool_call', 'spawn'. */
  type: string
  text: string
  data?: unknown
}

export type PauseKind = 'before-agent' | 'after-agent' | 'phase'

/** State surfaced to the UI when execution stops at a breakpoint. */
export interface PauseInfo {
  id: string
  line: number
  kind: PauseKind
  phase: string
  /** The agent call associated with this pause, if any. */
  agentId?: string
  label?: string
  /** Prompt about to run (before-agent) — for inspection. */
  prompt?: string
  /** Output just produced (after-agent) — for inspection. */
  output?: string
  resultJson?: unknown
}

export interface RunStats {
  agentCount: number
  completed: number
  failed: number
  durationMs: number
  tokens: AgentTokenUsage
}

/** A live, currently-applicable session config option from the running agent. */
export interface LiveConfigOption {
  id: string
  name: string
  type: 'select' | 'boolean'
  currentValue: string | boolean
  values?: { value: string; name: string }[]
}

/** The full, replayable snapshot of a run (sent on (re)subscribe). */
export interface RunSnapshot {
  runId: string
  status: RunStatus
  agent: AcpAgentId
  cwd: string
  meta?: WorkflowMeta
  modes?: SessionModeState
  /** Latest live config options from the running agent's session. */
  configOptions?: LiveConfigOption[]
  phases: PhaseState[]
  agents: AgentCallState[]
  log: AcpLogEntry[]
  pause?: PauseInfo
  result?: unknown
  error?: string
  stats: RunStats
  breakpoints: number[]
  startedAt: number
  finishedAt?: number
}

/** Incremental events streamed from the executor to the UI over the WS. */
export type RunEvent =
  | { type: 'run:started'; meta: WorkflowMeta; phases: PhaseState[]; agent: AcpAgentId; cwd: string }
  | { type: 'run:status'; status: RunStatus }
  | { type: 'session:modes'; modes: SessionModeState }
  | { type: 'session:configOptions'; agentId: string; options: LiveConfigOption[] }
  | { type: 'phase:enter'; title: string }
  | { type: 'agent:started'; agent: AgentCallState }
  | { type: 'agent:delta'; agentId: string; channel: 'message' | 'thought'; text: string }
  | { type: 'agent:tool'; agentId: string; tool: ToolCallState }
  | {
      type: 'agent:finished'
      agentId: string
      status: AgentCallStatus
      output?: string
      resultJson?: unknown
      error?: string
      tokens?: AgentTokenUsage
    }
  | { type: 'log'; message: string }
  | { type: 'acp'; entry: AcpLogEntry }
  | { type: 'breakpoint:set'; lines: number[] }
  | { type: 'breakpoint:hit'; pause: PauseInfo }
  | { type: 'breakpoint:resumed'; pauseId: string }
  | { type: 'run:finished'; status: RunStatus; result?: unknown; error?: string; stats: RunStats }
