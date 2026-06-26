/**
 * Combinator implementations registry.
 *
 * Every `kind: 'combinator'` method in shared/dsl-registry.ts has exactly one
 * factory file in this directory. A factory receives a MethodContext (the host
 * primitives, the already-built global scope to compose on, the resolved
 * config, and shared helpers) and returns the function injected into the vm.
 *
 * To add a combinator: drop a `<name>.ts` here exporting a MethodFactory, add a
 * line to METHOD_IMPLS below, and add a descriptor to shared/dsl-registry.ts.
 * Nothing else needs to change — the executor, validator, intellisense .d.ts,
 * and config UI all derive from the registry.
 */
import type { SandboxHost } from '../executor.ts'

/** Shared helpers handed to every combinator (bound to the current run's host). */
export interface MethodHelpers {
  /** Run a thunk; rethrow non-recoverable errors, otherwise log + resolve null. */
  settleThunk: (thunk: () => Promise<unknown>, label: string) => Promise<unknown>
  /** Stringify any value for prompt embedding / logging. */
  asText: (value: unknown) => string
  /** True if the error must halt the whole run. */
  isNonRecoverable: (err: unknown) => boolean
}

export interface MethodContext {
  /** Privileged primitives from the WorkflowRun (agent/phase/log/...). */
  host: SandboxHost
  /** The global scope being assembled — read OTHER globals lazily at call time. */
  scope: Record<string, unknown>
  /** Resolved + defaulted config for THIS method (from meta.config + run override). */
  config: Record<string, unknown>
  helpers: MethodHelpers
}

export type MethodFactory = (ctx: MethodContext) => unknown

/** Convenience: a parallel() compatible signature read off the live scope. */
export type ParallelFn = (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>

import { parallel } from './parallel.ts'
import { pipeline } from './pipeline.ts'
import { verify } from './verify.ts'
import { judgePanel } from './judgePanel.ts'
import { loopUntilDry } from './loopUntilDry.ts'
import { completenessCheck } from './completenessCheck.ts'
import { retry } from './retry.ts'
import { gate } from './gate.ts'
import { jsonSchema } from './jsonSchema.ts'

export const METHOD_IMPLS: Record<string, MethodFactory> = {
  parallel,
  pipeline,
  verify,
  judgePanel,
  loopUntilDry,
  completenessCheck,
  retry,
  gate,
  jsonSchema,
}
