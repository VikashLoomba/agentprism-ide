/**
 * Ambient TypeScript declarations injected into Monaco as an extra lib so that
 * workflow scripts get full intellisense over the DSL globals.
 *
 * The per-method `declare …` blocks are NOT hand-maintained here — they are
 * sourced from the single registry (shared/dsl-registry.ts) so intellisense can
 * never drift from the runtime / validator. This file only owns the shared
 * type PREAMBLE (interfaces + the JsonSchema/ModelTier aliases) that those
 * declarations reference.
 *
 * Loaded via monaco.languages.typescript.*.addExtraLib(). Because the file
 * declares top-level ambient symbols (no imports/exports in the emitted string),
 * they become global to every model in the editor.
 */
import type { AcpAgentId, AcpAgentSpec } from '@shared/agents'
import { ACP_AGENT_LIST } from '@shared/agents'
import { CAPABILITY_RESERVED_NAMES, DSL_METHODS } from '@shared/dsl-registry'
import type { CapabilityCatalogEntry, PromptCatalogEntry } from '@shared/protocol'

const PREAMBLE = `// AgentPrism workflow DSL — ambient globals.
// Scripts are plain ES modules: the first statement must be
//   export const meta = { name, description, phases? }

/** A plain JSON Schema object (not TypeScript / not TypeBox). */
type JsonSchema = Record<string, unknown>;

/**
 * Maps a JSON Schema literal to the TypeScript type that agent({ schema })
 * resolves to. Works when the schema is written inline, or referenced via
 * jsonSchema(...) (plain const schemas widen and fall back to unknown).
 */
type FromSchema<S> =
  S extends { enum: readonly (infer E)[] } ? E :
  S extends { const: infer C } ? C :
  S extends { type: 'string' } ? string :
  S extends { type: 'number' | 'integer' } ? number :
  S extends { type: 'boolean' } ? boolean :
  S extends { type: 'null' } ? null :
  S extends { type: 'array' } ? (S extends { items: infer I } ? FromSchema<I>[] : unknown[]) :
  S extends { type: 'object' } ? (S extends { properties: infer P } ? { [K in keyof P]: FromSchema<P[K]> } : Record<string, unknown>) :
  unknown;

interface WorkflowMetaPhase {
  /** Display title. Must match the string passed to phase('...') exactly. */
  title: string;
  /** Free-text detail shown under the phase in the run view. */
  detail?: string;
  /** Per-phase model route ("provider/modelId" or bare id). */
  model?: string;
}

interface WorkflowMeta {
  /** short_snake_case identifier, non-empty. */
  name: string;
  /** Non-empty human description. */
  description: string;
  /** Declared phases, in order. The first becomes the initial phase. */
  phases?: WorkflowMetaPhase[];
  /** Default model for agents with no model/tier/route. */
  model?: string;
  /** Per-method config overrides, e.g. { verify: { reviewers: 3 } }. */
  config?: Record<string, Record<string, unknown>>;
  /** World-touching capabilities this workflow uses, by namespace name.
   *  Resolved project-local tools/ first, then user-level ~/.agentprism/tools/.
   *  Qualify with "user:"/"@me/" to force the user tier or "project:" to force project. */
  capabilities?: string[];
}

interface CheckpointOptions {
  /** Reply used when running headless (no UI). Defaults to true. */
  default?: unknown;
  headless?: "default" | "abort";
  kind?: "confirm" | "input" | "select";
  choices?: string[];
  timeoutMs?: number;
}`

/** PascalCase interface name for an agent's config, e.g. claude → ClaudeAgentConfig. */
function configInterfaceName(id: AcpAgentId): string {
  return `${id.charAt(0).toUpperCase()}${id.slice(1)}AgentConfig`
}

/**
 * One config interface per agent, generated from its `configCatalog`.
 *
 * Critically (see docs/agent-session-config-design.md §1.2 probe): for the
 * discriminated `AgentOptions` union to actually NARROW config completions on
 * `opts.agent`, these interfaces must NOT carry a `[configId: string]: …` index
 * signature and must NOT use the `(string & {})` open escape hatch — both defeat
 * TypeScript's excess-property checking, which is what drives per-key completion
 * filtering. Fixed-vocab `select`/`boolean` entries become closed literal unions;
 * `open === true` entries become bare `string` (any value accepted, but the
 * property name stays constrained per-agent). Forward-compat for runtime-discovered
 * values is delegated to shared/validate.ts, which only ever emits warnings.
 */
function buildAgentConfigInterface(spec: AcpAgentSpec): string {
  const lines: string[] = [`interface ${configInterfaceName(spec.id)} {`]
  for (const entry of spec.configCatalog) {
    const key = /^[a-zA-Z_$][\w$]*$/.test(entry.id) ? entry.id : JSON.stringify(entry.id)
    let type: string
    if (entry.open === true) {
      // Open catalog entry — any string id is valid; validate.ts won't flag it.
      type = 'string'
    } else {
      type = (entry.values ?? []).map((v) => JSON.stringify(v.value)).join(' | ')
      if (!type) type = 'string'
    }
    lines.push(`  /** ${entry.id} */`)
    lines.push(`  ${key}?: ${type};`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * The three-member discriminated `AgentOptions` union (see design §1.2):
 *   • `{ agent?: undefined; config?: <Default>Config }`  — omitted backend → run default
 *   • `{ agent: '<id>'; config?: <Id>Config }`           — one branch per connected agent
 *
 * Setting `agent: 'codex'` narrows `config` completions/excess-property checks to
 * Codex's catalog (and vice-versa). The omitted-agent branch types against the
 * current default agent, so this block is regenerated whenever the default changes.
 *
 * NOTE: top-level `opts.agent` (which backend) is distinct from Claude's
 * `config.agent` (its custom-persona option) — different nesting, no collision.
 */
function buildAgentOptionsDts(agents: AcpAgentSpec[], defaultAgentId: AcpAgentId): string {
  const defaultConfig = configInterfaceName(defaultAgentId)
  const branches: string[] = [
    `  // Omitted agent → the run's DEFAULT backend (RunRequest.agent).\n` +
      `  | (AgentOptionsBase & { agent?: undefined; config?: ${defaultConfig} })`,
  ]
  for (const spec of agents) {
    branches.push(
      `  | (AgentOptionsBase & { agent: ${JSON.stringify(spec.id)}; config?: ${configInterfaceName(spec.id)} })`,
    )
  }
  return [
    `interface AgentOptionsBase {`,
    `  /** Short display label (2-5 words); should be unique per call. */`,
    `  label?: string;`,
    `  /** Override the current phase for this single agent. */`,
    `  phase?: string;`,
    `  /** JSON Schema — agent() resolves to a validated object instead of text. */`,
    `  schema?: JsonSchema;`,
    `  /** Run inside a throwaway git worktree for conflict-free parallel edits. */`,
    `  isolation?: "worktree";`,
    `  /** Named agent definition that binds tools/model/role prompt. */`,
    `  agentType?: string;`,
    `  /** Per-agent hard timeout in ms; null = no timeout. */`,
    `  timeoutMs?: number | null;`,
    `  /** Retry attempts after a recoverable failure. */`,
    `  retries?: number;`,
    `}`,
    ``,
    `/** Per-call agent() options. \`agent\` picks the connected backend (omitted → run default);`,
    ` *  \`config\` narrows to that backend's session-config catalog. */`,
    `type AgentOptions =`,
    ...branches,
    `;`,
  ].join('\n')
}

/**
 * One `declare const <ns>: { … }` ambient block per capability the workflow uses.
 *
 * The method surface is the capability's `dts` body — derived server-side from the
 * effect signatures (see derive-capability-dts.ts) — or a loose index signature
 * when absent. Each namespace is a global, like the DSL methods.
 *
 * C1 (capability-system-design §8): a capability whose name collides with a DSL
 * global (agent/args/cwd/budget/phase/…) or a core JS global is SKIPPED here, never
 * relying solely on the runtime executor guard — emitting a second top-level ambient
 * `declare const args` would silently void DSL intellisense (semantic validation is off).
 */
function buildCapabilityDts(entry: CapabilityCatalogEntry): string | null {
  if (CAPABILITY_RESERVED_NAMES.has(entry.name)) return null
  const body = entry.dts?.trim() ? entry.dts : '[method: string]: (args: any) => Promise<any>;'
  return `declare const ${entry.name}: {\n${body}\n};`
}

/**
 * ONE `declare const prompts: { <name>(data: <T>): string; … }` block for the
 * workflow's scoped prompt entries. Each member name is the entry's identifier
 * bareName (Option A — guaranteed valid TS, no quoting/transform). Return is
 * `string` (pure/sync), unlike capability methods (Promise<any>). Returns null
 * when there are no scoped prompts so no empty block is emitted.
 */
function buildPromptsDts(entries: PromptCatalogEntry[]): string | null {
  if (entries.length === 0) return null
  const members = entries.map((e) => {
    const doc = e.loadError ? `  /** ⚠ ${e.loadError} */\n` : ''
    return `${doc}  ${e.name}(data: ${e.paramsDts}): string;`
  })
  return `declare const prompts: {\n${members.join('\n')}\n};`
}

/**
 * Build the full ambient `.d.ts` injected into Monaco, given the CONNECTED agents
 * and the current DEFAULT agent. The result is DYNAMIC: it must be regenerated and
 * re-injected whenever the connected-agents list or the default agent changes, so
 * that config completions narrow correctly on `opts.agent`.
 *
 * Concatenates: PREAMBLE (sans AgentOptions) + one config interface per agent +
 * the discriminated AgentOptions union + every registry method's declaration block +
 * one `declare const <ns>` block per scoped capability (meta.capabilities-resolved
 * entries, passed by the caller; collisions with DSL/core globals are skipped).
 */
export function buildWorkflowDts(
  agents: AcpAgentSpec[],
  defaultAgentId: AcpAgentId,
  capabilities?: CapabilityCatalogEntry[],
  prompts?: PromptCatalogEntry[],
): string {
  const configInterfaces = agents.map((spec) => buildAgentConfigInterface(spec))
  const agentOptions = buildAgentOptionsDts(agents, defaultAgentId)
  const capabilityDts = (capabilities ?? [])
    .map(buildCapabilityDts)
    .filter((block): block is string => block !== null)
  const promptsDts = buildPromptsDts(prompts ?? [])
  return (
    [
      PREAMBLE,
      ...configInterfaces,
      agentOptions,
      ...DSL_METHODS.map((m) => m.dts),
      ...capabilityDts,
      ...(promptsDts ? [promptsDts] : []),
    ].join('\n\n') + '\n'
  )
}

/**
 * Bootstrap value for module load / before /api/agents resolves. Uses the full
 * static registry and `claude` as the default so the editor has completions
 * immediately; the store re-injects a connected-agents-scoped build once agents load.
 */
export const INITIAL_WORKFLOW_DSL_DTS: string = buildWorkflowDts(ACP_AGENT_LIST, 'claude')
