/**
 * Type definitions for the AgentPrism workflow DSL.
 *
 * These mirror the pi-dynamic-workflows runtime surface (meta export + the
 * agent()/parallel()/pipeline()/phase()/log() globals). They are the runtime
 * source of truth shared by the validator, the executor, and the UI. The
 * ambient `.d.ts` that powers Monaco intellisense is generated from the same
 * shapes (see src/lib/workflow-dts.ts).
 */

import type { AcpAgentId } from './agents.ts'

export type IsolationMode = 'worktree'

/**
 * Per-call ACP session config — keys are SessionConfigOption ids advertised by
 * the selected agent: Claude model|mode|effort|agent, Codex
 * model|mode|reasoning_effort|fast-mode; applied via session/set_config_option
 * before the first prompt; unknown ids ignored with a warning.
 */
export type AgentSessionConfig = Record<string, string | boolean>

export interface WorkflowMetaPhase {
  /** Display title. Must match the string passed to phase('...') exactly. */
  title: string
  /** Optional free-text detail shown under the phase in the run view. */
  detail?: string
  /** Optional per-phase model route ("provider/modelId" or bare id). */
  model?: string
}

export interface WorkflowMeta {
  /** short_snake_case identifier, non-empty. */
  name: string
  /** Non-empty human description. */
  description: string
  /** Declared phases, in order. The first becomes the initial phase. */
  phases?: WorkflowMetaPhase[]
  /** Default model for agents that specify no per-call config/route. */
  model?: string
  /**
   * Per-method config overrides, keyed by method name (e.g.
   * `{ verify: { reviewers: 3 } }`). Validated against each method's
   * configSchema (see shared/dsl-registry.ts). The run UI can override these
   * per-run on top of whatever the script declares here.
   */
  config?: Record<string, Record<string, unknown>>
  /**
   * Declared capability (Shared tools) namespaces this workflow may call.
   * Each entry is a bare name resolved project-local `tools/` first, then
   * user-level `~/.agentprism/tools/`. A name may be tier-qualified with a
   * `project:`, `user:`, or `@me/` prefix to force a specific tier (`@me/foo`
   * and `user:foo` both pin the user tier; `project:foo` pins the project
   * tier). Unresolved names are a hard validation error.
   */
  capabilities?: string[]
}

export interface AgentOptions {
  /** Short display label (2-5 words). Should be unique per call. */
  label?: string
  /** Override the current phase for this single agent. */
  phase?: string
  /** JSON Schema — agent() resolves to a validated object instead of text. */
  schema?: Record<string, unknown>
  /**
   * Which connected ACP backend runs THIS call. Omitted → the run default
   * (RunRequest.agent). Note this top-level `agent` (the backend selector) is
   * distinct from Claude's `config.agent` (its custom-persona option id).
   */
  agent?: AcpAgentId
  /** Per-call ACP session config (model/mode/effort/etc.) for the selected agent. */
  config?: AgentSessionConfig
  /** Run inside a throwaway git worktree for conflict-free parallel edits. */
  isolation?: IsolationMode
  /** Named agent definition (binds tools/model/role prompt). */
  agentType?: string
  /** Per-agent hard timeout in ms; null = no timeout. */
  timeoutMs?: number | null
  /** Retry attempts after a recoverable failure. */
  retries?: number
}

/** Runtime caps mirrored from pi-dynamic-workflows config. */
export const MAX_AGENTS_PER_RUN = 1000
export const MAX_CONCURRENCY = 16
export const MAX_AGENT_RETRIES = 3

/** Determinism blocklist applied to the raw script before parsing. */
export const DETERMINISM_BLOCKLIST =
  /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/
