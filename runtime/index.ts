// runtime/index.ts
//
// The published "." surface: a transport-agnostic, embeddable workflow runtime
// that hosts a WorkspaceRegistry (N workspaces in one process). A host app
// `import { createRuntime } from 'agentprism'` and runs workflows programmatically,
// receiving the full event stream and the mid-run interaction round-trips. The
// IDE's WS/HTTP server is just another consumer of this exact API — ONE engine.
import { createWorkspaceRegistry } from './workspace-registry.ts'
import { loadPersistedRoots, savePersistedRoots, canonicalKey } from './workspace-store.ts'
import { listAgents } from './agents.ts'
import type { WorkflowRef } from './resolve.ts'
import type { RunHandle, RunOptions, RunResult } from './run-controller.ts'
import type { WorkspaceRegistry } from './workspace.ts'
import type { CapabilityCatalog } from '../shared/capability-resolve.ts'
import type { PromptCatalog } from '../shared/prompt-resolve.ts'
import type { AcpAgentSpec } from '../shared/agents.ts'

export interface RuntimeOptions {
  /** Pre-open these roots; the FIRST is the default. Back-compat: omit -> a single
   *  default workspace at `cwd ?? process.cwd()` (today's behavior). */
  workspaces?: Array<string | { root: string; env?: NodeJS.ProcessEnv }>
  /** Back-compat: default workspace root when `workspaces` omitted. */
  cwd?: string
  /** Registry-wide default env. Defaults to process.env; never serialized. */
  env?: NodeJS.ProcessEnv
  /** IDE‑only opt‑in: restore + persist non‑default workspace roots to
   *  ~/.agentprism/workspaces.json (keyed by the default root). Default false —
   *  the programmatic embed never reads or writes that file. Set true ONLY in the
   *  two IDE entrypoints (server/index.ts, bin/agentprism-ide.mjs). */
  persistWorkspaces?: boolean
}

export interface Runtime {
  /** The workspace registry this runtime hosts (open/close/list workspaces). */
  readonly workspaces: WorkspaceRegistry
  /** Back-compat convenience delegating to `workspaces.default()`. */
  run(workflow: WorkflowRef, input?: Record<string, unknown>, options?: RunOptions): RunHandle
  /** Late-attach to an in-flight or recently-finished run by id (searches all). */
  get(runId: string): RunHandle | undefined
  list(): RunHandle[]
  /** The default workspace's resolved capability + prompt catalogs. */
  catalogs(): Promise<{ capabilities: CapabilityCatalog; prompts: PromptCatalog }>
  /** Process-global agent catalog + PACKAGE_ROOT install probe (§4.1). */
  listAgents(): AcpAgentSpec[]
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env
  const persistEnabled = options.persistWorkspaces === true

  // Suppress per‑open persistence writes during boot; persist once after restore.
  // `defaultRoot` is the FIXED persistence key, captured after the first open below and
  // NEVER reassigned — even if the registry later promotes a different default on close.
  let restoring = true
  let defaultRoot = ''
  // Persist every open root EXCEPT the fixed boot default (it is the key, re‑derived from
  // cwd each boot). Filtering here — against `defaultRoot`, not the registry's mutable
  // `defaultId` — is what keeps a promoted‑on‑close root in the persisted set. `onChange`
  // already passes ALL open roots; we drop the boot default here.
  const persistNonDefault = (allOpenRoots: string[]) => {
    savePersistedRoots(
      defaultRoot,
      allOpenRoots.filter((r) => canonicalKey(r) !== canonicalKey(defaultRoot)),
    )
  }
  const registry = createWorkspaceRegistry({
    env,
    // When persistence is off, pass NO callback at all → the registry's open/close
    // are fully inert w.r.t. the filesystem (programmatic embed / runWorkflow).
    onChange: persistEnabled
      ? (allOpenRoots) => {
          if (!restoring) persistNonDefault(allOpenRoots)
        }
      : undefined,
  })

  // 1. Open the provided roots (first = default) or the back‑compat cwd default.
  if (options.workspaces && options.workspaces.length > 0) {
    for (const w of options.workspaces) {
      if (typeof w === 'string') registry.open(w)
      else registry.open(w.root, { env: w.env })
    }
  } else {
    // Back-compat: a single default workspace at cwd ?? process.cwd(). This is the
    // SOLE permitted process.cwd() reader in the runtime (composition-root default).
    registry.open(options.cwd ?? process.cwd(), { useEnvDirOverrides: true })
  }
  defaultRoot = registry.default().root

  // 2. IDE‑only: restore previously‑added (non‑default) roots for THIS default root,
  //    on top of the provided set. open() dedups by workspace id, so a persisted root
  //    that equals the default (or any already‑open root) is a harmless no‑op.
  if (persistEnabled) {
    for (const root of loadPersistedRoots(defaultRoot)) {
      try {
        registry.open(root)
      } catch {
        /* skip unreadable/missing root */
      }
    }
  }

  restoring = false
  // 3. IDE‑only: one authoritative write of the surviving set under the FIXED boot
  //    default‑root key (prunes dead roots, captures CLI --workspace additions). Filter by
  //    the boot `defaultRoot` — NOT `w.isDefault` — so this stays consistent with the
  //    onChange path and with the key even after an in‑session default reassignment.
  if (persistEnabled) {
    persistNonDefault(registry.list().map((w) => w.root))
  }

  return {
    workspaces: registry,
    run: (workflow, input, runOptions) => registry.default().runtime.run(workflow, input, runOptions),
    get(runId) {
      for (const info of registry.list()) {
        const handle = registry.getOrThrow(info.id).runtime.get(runId)
        if (handle) return handle
      }
      return undefined
    },
    list() {
      return registry.list().flatMap((info) => registry.getOrThrow(info.id).runtime.list())
    },
    catalogs: () => registry.default().catalogs(),
    listAgents,
  }
}

/** Convenience for the common "fire and collect" case: run a workflow to
 *  completion and resolve its terminal result. Opens a one-shot default workspace. */
export async function runWorkflow(
  workflow: WorkflowRef,
  input?: Record<string, unknown>,
  options: RunOptions & RuntimeOptions = {},
): Promise<RunResult> {
  const { env, workspaces, cwd, ...runOptions } = options
  const runtime = createRuntime({ workspaces, cwd: cwd ?? process.cwd(), env })
  return runtime.run(workflow, input, runOptions).done
}

/* ------------------------------ public types ------------------------------ */

export { computeWorkspaceId } from './workspace.ts'
export type { Workspace, WorkspaceRegistry, WorkspaceRuntime, WorkspaceInfo } from './workspace.ts'
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
