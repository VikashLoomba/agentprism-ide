/**
 * The DSL method registry — the single source of truth for every global the
 * workflow sandbox exposes.
 *
 * Each method/value is described once here, and the four consumers DERIVE from
 * this list instead of duplicating it:
 *
 *   • server/workflow/executor.ts  — builds the vm globals (impls in methods/*)
 *   • shared/validate.ts           — agent-producer set + agent()/phase() call
 *                                     sites + meta.config validation
 *   • src/lib/workflow-dts.ts      — the Monaco intellisense .d.ts (joins `dts`)
 *   • src/features/run/MethodConfig — auto-generated config form (configSchema)
 *
 * This file is isomorphic (browser + Node). It carries only METADATA + Zod
 * config schemas — never the combinator implementations, which import node:vm
 * via the executor and must stay out of the browser bundle.
 */
import { z } from 'zod'

export type DslMethodKind = 'primitive' | 'combinator' | 'value'

export interface DslMethodDescriptor {
  /** Global identifier injected into the sandbox scope. */
  name: string
  /**
   * primitive  — privileged, bound from the WorkflowRun host (touches run state).
   * combinator — pure, built on host + other globals; impl in server/workflow/methods/<name>.ts.
   * value      — a non-callable global (args, cwd, budget, process).
   */
  kind: DslMethodKind
  /** One-line summary for docs / hovers. */
  summary: string
  /** The `declare …` block this method contributes to the Monaco .d.ts. */
  dts: string
  /** True if calling it (transitively) spawns agents — drives the validator hint. */
  producesAgents?: boolean
  /** The two call sites the validator tracks (breakpoints + phase grouping). */
  callSite?: 'agent' | 'phase'
  /** Zod schema of per-workflow / per-run tunables (defaults baked in). */
  configSchema?: z.ZodType
}

/* --------------------------- config schemas ---------------------------- */

const verifyConfig = z.object({
  reviewers: z.number().int().min(1).max(16).default(2).describe('How many adversarial reviewers vote.'),
  threshold: z.number().min(0).max(1).default(0.5).describe('Fraction of reviewers that must confirm for real=true.'),
  lens: z.array(z.string()).default([]).describe('Optional review lenses, applied round-robin across reviewers.'),
  instruction: z
    .string()
    .default('Adversarially fact-check the following. Try hard to REFUTE it; only confirm if it truly holds up.')
    .describe('Prompt prefix each reviewer receives before the item.'),
})

const judgePanelConfig = z.object({
  judges: z.number().int().min(1).max(16).default(3).describe('Judges scoring each candidate attempt.'),
  rubric: z.string().default('overall quality and correctness').describe('What the judges score on (0..1).'),
})

const loopUntilDryConfig = z.object({
  consecutiveEmpty: z.number().int().min(1).max(20).default(2).describe('Stop after this many rounds yield nothing new.'),
  maxRounds: z.number().int().min(1).max(500).default(50).describe('Hard cap on rounds.'),
})

const completenessCheckConfig = z.object({
  instruction: z
    .string()
    .default('Given the task args and the results, list anything still missing. Be specific.')
    .describe('Prompt prefix for the completeness critic.'),
})

const retryConfig = z.object({
  attempts: z.number().int().min(1).max(20).default(3).describe('Maximum attempts before returning the last value.'),
})

const gateConfig = z.object({
  attempts: z.number().int().min(1).max(20).default(3).describe('Maximum validate→retry cycles.'),
})

/* ----------------------------- descriptors ----------------------------- */

export const DSL_METHODS: DslMethodDescriptor[] = [
  {
    name: 'agent',
    kind: 'primitive',
    producesAgents: true,
    callSite: 'agent',
    summary: 'Spawn an isolated subagent that runs to completion and returns its final answer.',
    dts: `/**
 * Spawn an isolated subagent that runs to completion and returns its final
 * answer. With opts.schema it returns the validated object; otherwise the
 * final assistant text. Recoverable failures resolve to null — check before
 * synthesizing conclusions.
 */
declare function agent<const S extends JsonSchema>(prompt: string, opts: AgentOptions & { schema: S }): Promise<FromSchema<S> | null>;
declare function agent(prompt: string, opts?: AgentOptions): Promise<string | null>;`,
  },
  {
    name: 'jsonSchema',
    kind: 'combinator',
    summary: "Identity helper that preserves a schema literal's type so agent({ schema }) infers a typed result.",
    dts: `/**
 * Wrap a JSON Schema literal so agent({ schema }) infers a TYPED result —
 * e.g. \`const S = jsonSchema({ ... }); const r = await agent(p, { schema: S })\`
 * gives \`r\` a typed shape (and that flows through parallel/pipeline). Needed in
 * plain-JS workflows because \`as const\` is not valid there; returns the schema unchanged.
 */
declare function jsonSchema<const T extends JsonSchema>(schema: T): T;`,
  },
  {
    name: 'parallel',
    kind: 'combinator',
    producesAgents: true,
    summary: 'Run () => Promise thunks concurrently; results in input order, recoverable failures become null.',
    dts: `/**
 * Run an array of () => Promise thunks concurrently (capped). Results are
 * returned in input order; a recoverable failure becomes null in that slot.
 * Pass FUNCTIONS, not promises: parallel(items.map(x => () => agent(...))).
 */
declare function parallel<T = unknown>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;`,
  },
  {
    name: 'pipeline',
    kind: 'combinator',
    producesAgents: true,
    summary: 'Fan each item through sequential stages; different items run concurrently.',
    dts: `/**
 * Fan each item through sequential stages; different items run concurrently.
 * Each stage receives (previousValue, originalItem, index).
 */
declare function pipeline(
  items: unknown[],
  ...stages: Array<(prev: any, original: any, index: number) => unknown>
): Promise<any[]>;`,
  },
  {
    name: 'phase',
    kind: 'primitive',
    callSite: 'phase',
    summary: 'Group subsequent agents under a phase; optional soft per-phase token budget.',
    dts: `/** Group subsequent agents under a phase; optional soft per-phase token budget. */
declare function phase(title: string, opts?: { budget?: number }): void;`,
  },
  {
    name: 'log',
    kind: 'primitive',
    summary: 'Append a message to the run log / terminal console.',
    dts: `/** Append a message to the run log / terminal console. */
declare function log(message?: unknown): void;`,
  },
  {
    name: 'workflow',
    kind: 'primitive',
    producesAgents: true,
    summary: 'Run a saved workflow (or raw script) inline; one level deep only.',
    dts: `/** Run a saved workflow (or raw script) inline; one level deep only. */
declare function workflow(nameOrScript: string, args?: unknown): Promise<unknown>;`,
  },
  {
    name: 'verify',
    kind: 'combinator',
    producesAgents: true,
    configSchema: verifyConfig,
    summary: 'Adversarial fact-check: N reviewers vote on whether an item holds up.',
    dts: `/** Adversarial fact-check: N reviewers vote on whether an item holds up. */
declare function verify(
  item: unknown,
  opts?: { reviewers?: number; threshold?: number; lens?: string | string[] }
): Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real?: boolean; reason?: string } | null> }>;`,
  },
  {
    name: 'judgePanel',
    kind: 'combinator',
    producesAgents: true,
    configSchema: judgePanelConfig,
    summary: 'Score N candidate attempts with a judge panel and return the best.',
    dts: `/** Score N candidate attempts with a judge panel and return the best. */
declare function judgePanel(
  attempts: unknown[],
  opts?: { judges?: number; rubric?: string }
): Promise<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;`,
  },
  {
    name: 'loopUntilDry',
    kind: 'combinator',
    producesAgents: true,
    configSchema: loopUntilDryConfig,
    summary: 'Keep running rounds until they stop yielding new (deduped) items.',
    dts: `/** Keep running rounds until they stop yielding new (deduped) items. */
declare function loopUntilDry(opts: {
  round: (roundIndex: number) => Promise<unknown[]> | unknown[];
  key?: (item: unknown) => string;
  consecutiveEmpty?: number;
  maxRounds?: number;
}): Promise<unknown[]>;`,
  },
  {
    name: 'completenessCheck',
    kind: 'combinator',
    producesAgents: true,
    configSchema: completenessCheckConfig,
    summary: 'Final "what\'s missing?" critic over a set of results.',
    dts: `/** Final "what's missing?" critic over a set of results. */
declare function completenessCheck(
  taskArgs: unknown,
  results: unknown
): Promise<{ complete: boolean; missing?: string[] } | null>;`,
  },
  {
    name: 'retry',
    kind: 'combinator',
    producesAgents: true,
    configSchema: retryConfig,
    summary: 'Bounded retry of a thunk until a predicate holds.',
    dts: `/** Bounded retry of a thunk until a predicate holds. */
declare function retry(
  thunk: (attempt: number) => Promise<unknown> | unknown,
  opts?: { attempts?: number; until?: (r: unknown) => boolean }
): Promise<unknown>;`,
  },
  {
    name: 'gate',
    kind: 'combinator',
    producesAgents: true,
    configSchema: gateConfig,
    summary: 'Run a thunk, validate it, and feed validator feedback into the next attempt.',
    dts: `/** Run a thunk, validate it, and feed validator feedback into the next attempt. */
declare function gate(
  thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
  validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
  opts?: { attempts?: number }
): Promise<{ ok: boolean; value: unknown; attempts: number }>;`,
  },
  {
    name: 'checkpoint',
    kind: 'primitive',
    summary: 'Journaled, replayable human approval gate.',
    dts: `/** Journaled, replayable human approval gate. */
declare function checkpoint(promptText: string, opts?: CheckpointOptions): Promise<unknown>;`,
  },

  /* ------------------------------- values -------------------------------- */
  {
    name: 'args',
    kind: 'value',
    summary: 'Arbitrary JSON passed into the run from the UI.',
    dts: `/** Arbitrary JSON passed into the run from the UI. */
declare const args: any;`,
  },
  {
    name: 'cwd',
    kind: 'value',
    summary: 'Absolute working directory the agents operate in.',
    dts: `/** Absolute working directory the agents operate in. */
declare const cwd: string;`,
  },
  {
    name: 'process',
    kind: 'value',
    summary: 'Frozen stub — only process.cwd() is available.',
    dts: `/** Frozen stub — only process.cwd() is available. */
declare const process: { cwd(): string };`,
  },
  {
    name: 'budget',
    kind: 'value',
    summary: 'Token budget accounting for the run.',
    dts: `/** Token budget accounting for the run. */
declare const budget: { total: number | null; spent(): number; remaining(): number };`,
  },
]

export const DSL_METHOD_MAP = new Map(DSL_METHODS.map((m) => [m.name, m]))

/**
 * Names a capability namespace must NOT take, because they would collide with a
 * DSL global (every injected `name` above) or a core JS global. A capability so
 * named would emit a second top-level ambient `declare` and silently void DSL
 * intellisense (semantic validation is off in monaco-setup.ts). Enforced by the
 * dts builder (src/lib/workflow-dts.ts) and the executor injection guard.
 */
export const CAPABILITY_RESERVED_NAMES: ReadonlySet<string> = new Set<string>([
  ...DSL_METHODS.map((m) => m.name),
  'Math',
  'JSON',
  'Date',
  'Promise',
  'Object',
  'Array',
  'globalThis',
  'process',
  'console',
])

/** Names of globals that ultimately spawn agents (validator "agent() required" hint). */
export const AGENT_PRODUCER_NAMES: ReadonlySet<string> = new Set(
  DSL_METHODS.filter((m) => m.producesAgents).map((m) => m.name),
)

/** Methods that expose tunable config (used by the UI form + meta.config validation). */
export function methodsWithConfig(): DslMethodDescriptor[] {
  return DSL_METHODS.filter((m) => m.configSchema)
}

/** JSON Schema for a method's config (for UI form generation), or undefined. */
export function methodJsonSchema(name: string): Record<string, unknown> | undefined {
  const schema = DSL_METHOD_MAP.get(name)?.configSchema
  if (!schema) return undefined
  return z.toJSONSchema(schema) as Record<string, unknown>
}

/** The defaulted config for a method (schema.parse({})), or {} when no schema. */
export function methodDefaults(name: string): Record<string, unknown> {
  const schema = DSL_METHOD_MAP.get(name)?.configSchema
  if (!schema) return {}
  const r = schema.safeParse({})
  return r.success ? (r.data as Record<string, unknown>) : {}
}

/**
 * Merge config layers (later wins) and parse through the method's schema so
 * defaults fill any gaps. Falls back to schema defaults if the merge is invalid
 * (the validator surfaces bad config before a run, so this is just belt-and-braces).
 */
export function resolveMethodConfig(name: string, ...layers: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const layer of layers) {
    if (layer && typeof layer === 'object' && !Array.isArray(layer)) Object.assign(merged, layer)
  }
  const schema = DSL_METHOD_MAP.get(name)?.configSchema
  if (!schema) return merged
  const r = schema.safeParse(merged)
  if (r.success) return r.data as Record<string, unknown>
  return methodDefaults(name)
}

/** Validate a single method's config override; returns an error message or null. */
export function validateMethodConfig(name: string, raw: unknown): string | null {
  const d = DSL_METHOD_MAP.get(name)
  if (!d) return `unknown method "${name}"`
  if (!d.configSchema) return `method "${name}" has no configurable options`
  const r = d.configSchema.safeParse(raw)
  if (r.success) return null
  return r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}
