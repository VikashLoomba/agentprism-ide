// runtime/index.ts
//
// The published "." surface: a transport-agnostic, embeddable workflow runtime.
// A host app `import { createRuntime } from 'agentprism'` and runs workflows
// programmatically, receiving the full event stream and the mid-run interaction
// round-trips (permission + human-in-the-loop input). The IDE's WS/HTTP server is
// just another consumer of this exact API — there is ONE engine.
import { RunController } from './run-controller.ts'
import type { Prepared, RunHandle, RunOptions, RunResult } from './run-controller.ts'
import { resolveWorkflow } from './resolve.ts'
import type { WorkflowRef } from './resolve.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { validateInputs } from '../shared/validate-inputs.ts'
import { loadCapabilities } from '../server/workflow/capability-loader.ts'
import { loadPrompts } from '../server/workflow/prompt-loader.ts'
import type { CapabilityCatalog } from '../shared/capability-resolve.ts'
import type { PromptCatalog } from '../shared/prompt-resolve.ts'

export interface RuntimeOptions {
  /** Default working directory for runs (NOT the package root). Defaults to the
   *  host's AGENTPRISM_DEFAULT_CWD / process.cwd(). A run may override per-call. */
  cwd?: string
  /** Secret source threaded into capability effects. Defaults to process.env.
   *  Never serialized to the browser, never persisted. */
  env?: NodeJS.ProcessEnv
}

export interface Runtime {
  /** Start a workflow. Validates `input` against the workflow's `meta.inputs`
   *  BEFORE starting; on failure the returned handle settles `failed` with the
   *  errors and emits a failed run:finished. */
  run(workflow: WorkflowRef, input?: Record<string, unknown>, options?: RunOptions): RunHandle
  /** Late-attach to an in-flight or recently-finished run by id. */
  get(runId: string): RunHandle | undefined
  list(): RunHandle[]
  /** The resolved capability + prompt catalogs (reused by the IDE server). */
  catalogs(): Promise<{ capabilities: CapabilityCatalog; prompts: PromptCatalog }>
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env
  const controller = new RunController({ env, cwd: options.cwd })

  return {
    run(workflow, input, runOptions = {}) {
      const agent = runOptions.agent ?? 'claude'
      const prepare = async (): Promise<Prepared> => {
        const source = await resolveWorkflow(workflow)
        // Best-effort meta extraction to gate inputs before the engine starts.
        // `meta` is undefined whenever the meta literal has ANY validation error,
        // so this falls back to "no declared inputs" (free-form args, back-compat);
        // the engine re-validates fully against the live catalogs at start().
        const validation = validateWorkflow(source, agent)
        const result = validateInputs(validation.meta?.inputs, input)
        if (!result.ok) return { ok: false, errors: result.errors }
        return { ok: true, source, args: result.value }
      }
      return controller.launch(prepare, runOptions)
    },
    get: (runId) => controller.get(runId),
    list: () => controller.list(),
    async catalogs() {
      const [caps, prompts] = await Promise.all([loadCapabilities(env), loadPrompts()])
      return { capabilities: caps.catalog, prompts: prompts.catalog }
    },
  }
}

/** Convenience for the common "fire and collect" case: run a workflow to
 *  completion and resolve its terminal result. */
export async function runWorkflow(
  workflow: WorkflowRef,
  input?: Record<string, unknown>,
  options: RunOptions & RuntimeOptions = {},
): Promise<RunResult> {
  const { env, ...runOptions } = options
  const runtime = createRuntime({ cwd: options.cwd, env })
  return runtime.run(workflow, input, runOptions).done
}

/* ------------------------------ public types ------------------------------ */

export type { WorkflowRef } from './resolve.ts'
export type { RunHandle, RunOptions, RunResult, RunInteraction } from './run-controller.ts'

// Re-exported from shared so a consumer needs only this entry point.
export type {
  RunEvent,
  RunSnapshot,
  RunStatus,
  RunStats,
  AgentCallState,
  AgentCallStatus,
  EffectCallState,
  EffectCallStatus,
  ToolCallState,
  ToolCallStatus,
  PhaseState,
  PauseInfo,
  PauseKind,
  AcpLogEntry,
  AcpEventLevel,
  LiveConfigOption,
  AgentTokenUsage,
} from '../shared/events.ts'
export type {
  RunRequest,
  PermissionRequest,
  PermissionResponse,
  PermissionOption,
  InputRequest,
  InputResponse,
} from '../shared/protocol.ts'
export type { AcpAgentId, AcpAgentSpec, SessionModeState } from '../shared/agents.ts'
export type { WorkflowMeta, WorkflowInputParam, WorkflowMetaPhase } from '../shared/dsl.ts'
export type { ParamType } from '../shared/param.ts'
export type { Json } from '../shared/capability.ts'
export type { CapabilityCatalog } from '../shared/capability-resolve.ts'
export type { PromptCatalog } from '../shared/prompt-resolve.ts'
