import type { AcpAgentId, AcpAgentSpec } from './agents.ts'
import type { RunEvent, RunSnapshot } from './events.ts'
import type { PromptParam } from './prompt-frontmatter.ts'
import type { Json } from './capability.ts'

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
  /** The owning workspace's id (scopes the run to one workspace). */
  workspaceId: string
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

/** A mid-run human-in-the-loop input request (checkpoint / input / select),
 *  awaiting a value from the host (UI or programmatic onInput handler). */
export interface InputRequest {
  requestId: string
  kind: 'confirm' | 'input' | 'select'
  prompt: string
  /** Choices for kind==='select'. */
  options?: { id: string; label: string }[]
  default?: Json
  /** The agent associated with this request, when raised in an agent context. */
  agentId?: string
}

export type InputResponse =
  | { kind: 'value'; value: Json }
  | { kind: 'cancelled' }

/** Client -> Server WebSocket messages. */
export type ClientMessage =
  | { t: 'start'; workspaceId: string; run: RunRequest }
  | { t: 'subscribe'; workspaceId: string; runId: string }
  | { t: 'resume'; workspaceId: string; runId: string }
  | { t: 'step'; workspaceId: string; runId: string }
  | { t: 'cancel'; workspaceId: string; runId: string }
  | { t: 'setBreakpoints'; workspaceId: string; runId: string; lines: number[] }
  | { t: 'permission'; workspaceId: string; runId: string; requestId: string; response: PermissionResponse }
  | { t: 'input'; workspaceId: string; runId: string; requestId: string; response: InputResponse }
  | { t: 'ping' }

/** Server -> Client WebSocket messages. */
export type ServerMessage =
  | { t: 'hello'; agents: AcpAgentSpec[]; workspaces: WorkspaceInfo[]; defaultWorkspaceId: string }
  | { t: 'snapshot'; workspaceId: string; snapshot: RunSnapshot }
  | { t: 'event'; workspaceId: string; runId: string; event: RunEvent }
  | { t: 'permission'; workspaceId: string; runId: string; req: PermissionRequest }
  | { t: 'permission:resolved'; workspaceId: string; runId: string; requestId: string }
  | { t: 'input'; workspaceId: string; runId: string; req: InputRequest }
  | { t: 'input:resolved'; workspaceId: string; runId: string; requestId: string }
  | { t: 'error'; workspaceId?: string; runId?: string; message: string }
  | { t: 'pong' }

/* ----------------------------- REST DTOs ----------------------------- */

/** Safe, serializable description of a workspace (ships to the browser). */
export interface WorkspaceInfo {
  id: string
  name: string
  root: string
  isDefault: boolean
}

export interface WorkspacesResponse {
  workspaces: WorkspaceInfo[]
  defaultWorkspaceId: string
}

export interface OpenWorkspaceRequest {
  root: string
}

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

/** Safe metadata view of one capability (NEVER the effect fns, NEVER secret values). */
export interface CapabilityCatalogEntry {
  /** Namespace name (== Capability.name). */
  name: string
  tier: 'project' | 'user'
  /** Declared secret NAMES only. */
  secrets: string[]
  /** Per-secret presence from host env (host computes; UI shows required/present). */
  secretStatus: Record<string, { present: boolean }>
  /** Effect method names (for the palette / hovers). */
  methods: string[]
  /** Ambient `declare const <name>: { ... }` body, derived from the effect
   *  signatures server-side (see derive-capability-dts.ts); '' for loose. */
  dts: string
  /** Absolute source path (for "open in editor"). */
  path: string
  modifiedAt: number
  /** Populated when the module failed to import/validate (one bad module ≠ broken catalog). */
  loadError?: string
}

export interface CapabilitiesResponse {
  capabilities: CapabilityCatalogEntry[]   // both tiers, tier-tagged
}

/** Safe metadata view of one prompt template (safe to ship to browser; prompt
 *  bodies are non-sensitive by design — NO secrets, NO effect fns). */
export interface PromptCatalogEntry {
  /** Namespace member name (== filename bareName == JS identifier). */
  name: string
  tier: 'project' | 'user'
  /** Declared parameters (drives typing + preview sample seed). */
  params: PromptParam[]
  /** TS object-type literal for the `prompts.<name>(data: <T>)` dts member. */
  paramsDts: string
  /** Hover/tooltip snippet ONLY (truncated). NEVER used as a render input. */
  preview: string
  /** FULL template body (frontmatter-stripped source). Used by the live preview
   *  to register partials at full fidelity so preview render == server render. */
  body: string
  path: string
  modifiedAt: number
  /** Populated when frontmatter parse / Handlebars compile failed. */
  loadError?: string
}

export interface PromptsResponse {
  prompts: PromptCatalogEntry[]   // both tiers, tier-tagged
}

/** One editor extra-lib: a virtual file the Monaco TS service resolves against. */
export interface ToolLib {
  /** Virtual path, e.g. file:///tools/helpers.ts or file:///node_modules/lodash/index.d.ts. */
  filePath: string
  content: string
}

/** Every tool source file — loaded into the editor's virtual fs for sibling resolution. */
export interface ToolSourcesResponse {
  libs: ToolLib[]
}

/** Resolve the .d.ts graph for the npm specifiers Monaco reported unresolved. */
export interface ToolTypesRequest {
  specifiers: string[]
}

export interface ToolTypesResponse {
  libs: ToolLib[]
}
