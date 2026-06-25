import type { AcpAgentId, AcpAgentSpec } from './agents.ts'
import type { RunEvent, RunSnapshot } from './events.ts'

/** Parameters to launch a workflow run. */
export interface RunRequest {
  runId: string
  /** The raw workflow script source. */
  source: string
  /** Which ACP agent powers the agent() calls. */
  agent: AcpAgentId
  /** Selected session mode id (from the agent's availableModes). */
  modeId?: string
  /** Working directory the agents operate in (absolute). */
  cwd: string
  /** Arbitrary JSON exposed to the script as `args`. */
  args?: unknown
  /** Lines (1-based) with breakpoints set. */
  breakpoints: number[]
  /** Start paused and pause at every agent boundary (step debugging). */
  stepMode?: boolean
  /** Route every ACP permission request to the UI instead of auto-approving. */
  manualApprovals?: boolean
  /** Max concurrent agents (clamped to MAX_CONCURRENCY). */
  maxConcurrency?: number
  /** Optional hard token budget for the run. */
  tokenBudget?: number | null
  /**
   * Per-run method config overrides, keyed by method name. Layered ON TOP of
   * the script's `meta.config` (UI wins), then parsed through each method's
   * configSchema. See shared/dsl-registry.ts.
   */
  methodConfig?: Record<string, Record<string, unknown>>
}

export interface PermissionOption {
  optionId: string
  name: string
  kind: string
}

/** A permission request bubbled up from an ACP agent, awaiting a UI decision. */
export interface PermissionRequest {
  requestId: string
  agentId: string
  agentLabel?: string
  toolTitle: string
  toolKind?: string
  options: PermissionOption[]
}

export type PermissionResponse =
  | { kind: 'selected'; optionId: string }
  | { kind: 'cancelled' }

/** Client -> Server WebSocket messages. */
export type ClientMessage =
  | { t: 'start'; run: RunRequest }
  | { t: 'subscribe'; runId: string }
  | { t: 'resume'; runId: string }
  | { t: 'step'; runId: string }
  | { t: 'cancel'; runId: string }
  | { t: 'setBreakpoints'; runId: string; lines: number[] }
  | { t: 'permission'; runId: string; requestId: string; response: PermissionResponse }
  | { t: 'ping' }

/** Server -> Client WebSocket messages. */
export type ServerMessage =
  | { t: 'hello'; agents: AcpAgentSpec[] }
  | { t: 'snapshot'; snapshot: RunSnapshot }
  | { t: 'event'; runId: string; event: RunEvent }
  | { t: 'permission'; runId: string; req: PermissionRequest }
  | { t: 'permission:resolved'; runId: string; requestId: string }
  | { t: 'error'; runId?: string; message: string }
  | { t: 'pong' }

/* ----------------------------- REST DTOs ----------------------------- */

export interface WorkflowFileInfo {
  name: string
  path: string
  size: number
  modifiedAt: number
}

export interface WorkflowFileContent {
  name: string
  content: string
}

export interface AgentsResponse {
  agents: AcpAgentSpec[]
  /** Default working directory suggested for new runs. */
  defaultCwd: string
}
