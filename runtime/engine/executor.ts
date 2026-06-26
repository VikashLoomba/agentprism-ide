import vm from 'node:vm'
import type { AgentOptions } from '../../shared/dsl.ts'
import type { Json } from '../../shared/capability.ts'
import { DSL_METHODS, methodDefaults } from '../../shared/dsl-registry.ts'
import { instrumentWorkflow, WORKFLOW_FILENAME } from './instrument.ts'
import { isNonRecoverable } from './errors.ts'
import { METHOD_IMPLS, type MethodHelpers } from './methods/index.ts'

export interface CheckpointOptions {
  default?: unknown
  headless?: 'default' | 'abort'
  kind?: 'confirm' | 'input' | 'select'
  choices?: string[]
  timeoutMs?: number
}

/** Host-provided primitives the sandbox builds the full DSL on top of. */
export interface SandboxHost {
  agent: (prompt: string, opts?: AgentOptions) => Promise<unknown>
  phase: (title: string, opts?: { budget?: number }) => void
  log: (message?: unknown) => void
  checkpoint: (promptText: string, opts?: CheckpointOptions) => Promise<unknown>
  runNested: (script: string, args: unknown) => Promise<unknown>
  budget: { total: number | null; spent: () => number; remaining: () => number }
  args: unknown
  cwd: string
  /** Namespace -> { method: (args)=>Promise<result> }. Each namespace object is
   *  ALREADY frozen + host-bound + recorded by WorkflowRun.bindCapability. */
  capabilities: Record<string, Readonly<Record<string, (args: Json) => Promise<Json | null>>>>
  /** The single `prompts` namespace: { name: (data)=>string }. PURE + SYNC.
   *  Already frozen by WorkflowRun.bindPrompts. NOT recorded, NOT async. */
  prompts: Readonly<Record<string, (data: Json) => string>>
}

/** Per-method resolved config, keyed by method name. */
export type MethodConfigMap = Record<string, Record<string, unknown>>

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Bind a `kind: 'primitive'` global from the host. */
function bindPrimitive(name: string, host: SandboxHost): unknown {
  switch (name) {
    case 'agent':
      return host.agent
    case 'phase':
      return host.phase
    case 'log':
      return host.log
    case 'workflow':
      return host.runNested
    case 'checkpoint':
      return host.checkpoint
    default:
      throw new Error(`No host binding for DSL primitive "${name}"`)
  }
}

/** Bind a `kind: 'value'` global from the host. */
function bindValue(name: string, host: SandboxHost): unknown {
  switch (name) {
    case 'args':
      return host.args
    case 'cwd':
      return host.cwd
    case 'process':
      return { cwd: () => host.cwd }
    case 'budget':
      return host.budget
    default:
      throw new Error(`No host binding for DSL value "${name}"`)
  }
}

/**
 * Build the object injected as the vm's global scope, driven entirely by the
 * registry (shared/dsl-registry.ts):
 *
 *   • primitives  → bound from the host (privileged, touch run state)
 *   • combinators → built from runtime/engine/methods/<name>.ts on top of the
 *                   host + the already-assembled scope (read lazily at call time)
 *   • values      → bound from the host (args/cwd/budget/process)
 *
 * `config` carries each combinator's resolved (defaulted) tunables.
 */
export function buildSandboxGlobals(host: SandboxHost, config: MethodConfigMap = {}): Record<string, unknown> {
  const { log } = host

  const settleThunk = async (thunk: () => Promise<unknown>, label: string): Promise<unknown> => {
    try {
      return await thunk()
    } catch (err) {
      if (isNonRecoverable(err)) throw err
      log(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  const helpers: MethodHelpers = { settleThunk, asText, isNonRecoverable }

  const scope: Record<string, unknown> = {}

  // 1. Primitives + values straight from the host.
  for (const d of DSL_METHODS) {
    if (d.kind === 'primitive') scope[d.name] = bindPrimitive(d.name, host)
    else if (d.kind === 'value') scope[d.name] = bindValue(d.name, host)
  }

  // 1b. Capability namespaces from the host (already frozen + recorded).
  //     Injected AFTER the primitive/value loop, guarded against collisions
  //     with DSL globals. bindPrimitive/bindValue are untouched.
  for (const [ns, obj] of Object.entries(host.capabilities)) {
    if (ns in scope) throw new Error(`capability namespace "${ns}" collides with a DSL global`)
    scope[ns] = obj // live host reference; vm.createContext contextifies in place
  }

  // 1c. The single pure `prompts` namespace. Collision-guarded against DSL globals
  //     AND against capability namespaces already injected in step 1b (cross-system
  //     guard — capabilities never needed this since they were the sole injector).
  //     host.prompts is ALREADY frozen by WorkflowRun.bindPrompts (no rebuild/refreeze).
  if ('prompts' in scope) {
    throw new Error('prompts namespace collides with a DSL global or capability')
  }
  scope.prompts = host.prompts // already frozen by WorkflowRun.bindPrompts

  // 2. Combinators built on top of the scope. Factories read OTHER globals
  //    (scope.parallel, ...) lazily inside the returned function, so the build
  //    order within this loop does not matter.
  for (const d of DSL_METHODS) {
    if (d.kind !== 'combinator') continue
    const factory = METHOD_IMPLS[d.name]
    if (!factory) throw new Error(`No implementation registered for DSL combinator "${d.name}"`)
    scope[d.name] = factory({ host, scope, config: config[d.name] ?? methodDefaults(d.name), helpers })
  }

  // 3. Fixed shims (not registry-managed: no user-facing surface).
  scope.console = {
    log: (...a: unknown[]) => log(a.map(asText).join(' ')),
    info: (...a: unknown[]) => log(a.map(asText).join(' ')),
    debug: (...a: unknown[]) => log(a.map(asText).join(' ')),
    warn: (...a: unknown[]) => log('[warn] ' + a.map(asText).join(' ')),
    error: (...a: unknown[]) => log('[error] ' + a.map(asText).join(' ')),
  }

  return scope
}

/** Run already-instrumented code in a fresh vm context built from the globals. */
export async function runVm(code: string, globals: Record<string, unknown>): Promise<unknown> {
  const context = vm.createContext(globals)
  const script = new vm.Script(code, { filename: WORKFLOW_FILENAME })
  return script.runInContext(context)
}

/** Instrument + run a workflow body in a fresh vm context built from the globals. */
export async function executeWorkflow(
  normalizedSource: string,
  host: SandboxHost,
  config: MethodConfigMap = {},
): Promise<{ result: unknown; headerLines: number }> {
  const { code, headerLines } = instrumentWorkflow(normalizedSource)
  const result = await runVm(code, buildSandboxGlobals(host, config))
  return { result, headerLines }
}
