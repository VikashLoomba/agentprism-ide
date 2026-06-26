// runtime/workspace.ts
//
// The Workspace abstraction (§1): a single-root project that OWNS every
// per-project filesystem path + resolution method, derived from its `root` and
// never from process.cwd(). A WorkspaceRegistry hosts N workspaces in one
// process. This is the only layer that touches the user's filesystem for user
// content. See docs/workspace-architecture-plan.md §1, §5.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  PACKAGE_ROOT,
  USER_TOOLS_DIR,
  USER_PROMPTS_DIR,
  deriveWorkspaceDirs,
} from './paths.ts'
import {
  loadCapabilities,
  type LoadedCapabilities,
} from './engine/capability-loader.ts'
import { loadPrompts, type LoadedPrompts } from './engine/prompt-loader.ts'
import {
  listWorkflows,
  readWorkflow,
  writeWorkflow,
  deleteWorkflow,
} from './store/workflows.ts'
import {
  readCapabilityFile,
  writeCapabilityFile,
  type CapabilityFileInfo,
} from './store/capabilities.ts'
import { readPrompt, writePrompt, type PromptFileInfo } from './store/prompts.ts'
import { listToolSourceLibs, resolvePackageTypeLibs } from './tool-intellisense.ts'
import { RunController, type Prepared } from './run-controller.ts'
import type { RunHandle, RunOptions } from './run-controller.ts'
import { resolveWorkflow, type WorkflowRef } from './resolve.ts'
import { validateWorkflow } from '../shared/validate.ts'
import { validateInputs } from '../shared/validate-inputs.ts'
import type { WorkflowFileInfo, ToolLib, WorkspaceInfo } from '../shared/protocol.ts'
import type { CapabilityCatalog } from '../shared/capability-resolve.ts'
import type { PromptCatalog } from '../shared/prompt-resolve.ts'
import type { AcpAgentId } from '../shared/agents.ts'

export type { WorkspaceInfo } from '../shared/protocol.ts'

export type Tier = 'project' | 'user'

/** The four conventional subdirs of a workspace root (LOCKED decision 1). */
export interface WorkspaceDirs {
  readonly root: string
  readonly tools: string
  readonly prompts: string
  readonly workflows: string
  readonly nodeModules: string
}

/** One tiered search dir (project shadows user — LOCKED decision 2). */
export interface WorkspaceTier {
  readonly dir: string
  readonly tier: Tier
}

/** Per-workspace engine surface — today's Runtime.run/get/list, scoped to one
 *  workspace's own RunController (its own run registry, env, default cwd=root). */
export interface WorkspaceRuntime {
  run(workflow: WorkflowRef, input?: Record<string, unknown>, options?: RunOptions): RunHandle
  get(runId: string): RunHandle | undefined
  list(): RunHandle[]
}

/** A single-root workspace. Owns ALL per-project filesystem + resolution. */
export interface Workspace {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly dirs: WorkspaceDirs
  /** Secret/env source threaded into capability effects + secret-status. */
  readonly env: NodeJS.ProcessEnv

  readonly capabilityDirs: readonly WorkspaceTier[]
  readonly promptDirs: readonly WorkspaceTier[]

  toolDir(tier: Tier): string
  promptDir(tier: Tier): string

  // --- Workflows store (project tier only) ---
  listWorkflows(): Promise<WorkflowFileInfo[]>
  readWorkflow(name: string): Promise<string>
  writeWorkflow(name: string, content: string): Promise<WorkflowFileInfo>
  deleteWorkflow(name: string): Promise<void>

  // --- Catalog loaders (anchored at this workspace's dirs + node_modules) ---
  loadCapabilities(env?: NodeJS.ProcessEnv): Promise<LoadedCapabilities>
  loadPrompts(): Promise<LoadedPrompts>
  catalogs(): Promise<{ capabilities: CapabilityCatalog; prompts: PromptCatalog }>

  // --- Single-file editor IO (two-tier) ---
  readToolFile(tier: Tier, fileName: string): Promise<{ path: string; content: string }>
  writeToolFile(tier: Tier, fileName: string, content: string): Promise<CapabilityFileInfo>
  readPromptFile(tier: Tier, name: string): Promise<{ path: string; content: string }>
  writePromptFile(tier: Tier, name: string, content: string): Promise<PromptFileInfo>

  // --- Editor intellisense (anchored at dirs.nodeModules; namespaced by id) ---
  toolSources(): ToolLib[]
  resolveToolTypes(specifiers: string[]): ToolLib[]

  // --- Engine surface (per-workspace RunController). Assigned ONCE during
  //     construction; never reassigned (see createWorkspace step 4). ---
  runtime: WorkspaceRuntime
}

export interface WorkspaceOpenOptions {
  env?: NodeJS.ProcessEnv
  /** Honor AGENTPRISM_*_DIR overrides for THIS workspace's dir derivation. The
   *  registry passes true ONLY to the default workspace (§11.E). */
  useEnvDirOverrides?: boolean
}

/** Hosts N workspaces in one process (the LSP added/removed delta model). */
export interface WorkspaceRegistry {
  open(root: string, opts?: WorkspaceOpenOptions): Workspace
  get(id: string): Workspace | undefined
  getOrThrow(id: string): Workspace
  has(id: string): boolean
  list(): WorkspaceInfo[]
  default(): Workspace
  defaultId(): string
  close(id: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Workspace id (§1.1)
// ---------------------------------------------------------------------------

/** slug-shorthash of the CANONICALIZED real root. Stable across restarts,
 *  URL/path-segment safe, no '@' (dodges the Monaco scoped-URI bug). */
export function computeWorkspaceId(root: string): string {
  const real = canonicalizeRoot(root)
  const base = path.basename(real) || 'workspace'
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}

/** Canonicalize symlinks + case-variant spellings so the SAME root collapses to
 *  ONE id (mirrors LSP keying on folder URI / Node keying on resolved URL). */
export function canonicalizeRoot(root: string): string {
  const abs = path.resolve(root)
  try {
    return fs.realpathSync.native(abs)
  } catch {
    return abs
  }
}

// ---------------------------------------------------------------------------
// Capability-API shim (§5.4) — the load-bearing runtime fix
// ---------------------------------------------------------------------------

const SHIM_SENTINEL = '// @agentprism-capability-shim (generated; safe to delete)'

/** Ensure `<root>/shared/capability.ts` exists and re-exports AgentPrism's API,
 *  so a tool's on-disk `../shared/capability.ts` import resolves at runtime to
 *  the PACKAGE_ROOT source (§0). Idempotent; no-op when `<root>/shared` already
 *  IS PACKAGE_ROOT's (ws == package); never clobbers a user's own non-shim file. */
function ensureCapabilityShimAt(root: string): void {
  const pkgCap = path.join(PACKAGE_ROOT, 'shared', 'capability.ts')
  const cap = path.join(root, 'shared', 'capability.ts')
  // root == package (default single-workspace / back-compat): leave it untouched.
  try {
    if (fs.realpathSync.native(cap) === fs.realpathSync.native(pkgCap)) return
  } catch {
    /* cap absent — fall through to write */
  }
  // A user file that is NOT our shim shadows the API on purpose: do not overwrite.
  if (fs.existsSync(cap)) {
    const head = fs.readFileSync(cap, 'utf8').slice(0, SHIM_SENTINEL.length)
    if (head !== SHIM_SENTINEL) {
      console.warn(`[agentprism] ${cap} exists and is not a generated shim; leaving as-is`)
      return
    }
  }
  fs.mkdirSync(path.dirname(cap), { recursive: true })
  // Re-export from PACKAGE_ROOT by relative specifier (portable; tsx-loadable).
  const spec = path.relative(path.dirname(cap), pkgCap).split(path.sep).join('/')
  const rel = spec.startsWith('.') ? spec : `./${spec}`
  fs.writeFileSync(cap, `${SHIM_SENTINEL}\nexport * from ${JSON.stringify(rel)}\n`)
}

/** Project-tier shim (the workspace root). */
function ensureCapabilityShim(root: string): void {
  ensureCapabilityShimAt(root)
}

/** User-tier shim (~/.agentprism). Written only when the user tools dir actually
 *  holds capability files. Idempotent + process-global; a no-op after the first. */
function ensureUserCapabilityShim(): void {
  let hasUserCaps = false
  try {
    hasUserCaps = fs.readdirSync(USER_TOOLS_DIR).some((f) => /\.(ts|mts|js|mjs)$/.test(f))
  } catch {
    /* USER_TOOLS_DIR absent → no user library → nothing to shim */
  }
  if (!hasUserCaps) return
  ensureCapabilityShimAt(path.dirname(USER_TOOLS_DIR)) // ~/.agentprism
}

// ---------------------------------------------------------------------------
// prepareRun (§WU-6 LOCKED) — the run-prep body shared with the old index.ts path
// ---------------------------------------------------------------------------

async function prepareRun(
  wf: WorkflowRef,
  ws: Workspace,
  input: Record<string, unknown> | undefined,
  agent: AcpAgentId,
): Promise<Prepared> {
  const source = await resolveWorkflow(wf, ws)
  // Best-effort meta extraction to gate inputs before the engine starts. `meta`
  // is undefined whenever the meta literal has ANY validation error, so this
  // falls back to "no declared inputs"; the engine re-validates fully at start().
  const validation = validateWorkflow(source, agent)
  const result = validateInputs(validation.meta?.inputs, input)
  if (!result.ok) return { ok: false, errors: result.errors }
  return { ok: true, source, args: result.value }
}

// ---------------------------------------------------------------------------
// createWorkspace (§WU-6 LOCKED construction sequence)
// ---------------------------------------------------------------------------

export function createWorkspace(root: string, opts: WorkspaceOpenOptions = {}): Workspace {
  const id = computeWorkspaceId(root)
  const env = opts.env ?? process.env
  const dirs = deriveWorkspaceDirs(root, { env, useEnvOverrides: opts.useEnvDirOverrides === true })
  ensureCapabilityShim(dirs.root) // §5.4 (project tier)
  ensureUserCapabilityShim() // §5.4 (user tier, idempotent across workspaces)
  const capabilityDirs: readonly WorkspaceTier[] = [
    { dir: dirs.tools, tier: 'project' as const },
    { dir: USER_TOOLS_DIR, tier: 'user' as const },
  ]
  const promptDirs: readonly WorkspaceTier[] = [
    { dir: dirs.prompts, tier: 'project' as const },
    { dir: USER_PROMPTS_DIR, tier: 'user' as const },
  ]

  // 1. Allocate the Workspace object FIRST, with `runtime` left unassigned.
  const ws = {
    id,
    name: path.basename(dirs.root) || 'workspace',
    root: dirs.root,
    dirs,
    env,
    capabilityDirs,
    promptDirs,
    toolDir: (t: Tier) => (t === 'project' ? dirs.tools : USER_TOOLS_DIR),
    promptDir: (t: Tier) => (t === 'project' ? dirs.prompts : USER_PROMPTS_DIR),
    listWorkflows: () => listWorkflows(dirs.workflows),
    readWorkflow: (n: string) => readWorkflow(dirs.workflows, n),
    writeWorkflow: (n: string, c: string) => writeWorkflow(dirs.workflows, n, c),
    deleteWorkflow: (n: string) => deleteWorkflow(dirs.workflows, n),
    loadCapabilities: (e?: NodeJS.ProcessEnv) =>
      loadCapabilities({ capabilityDirs, workspaceRoot: dirs.root, packageRoot: PACKAGE_ROOT, env: e ?? env }),
    loadPrompts: () => loadPrompts(promptDirs),
    catalogs: async () => {
      const [c, p] = await Promise.all([ws.loadCapabilities(), ws.loadPrompts()])
      return { capabilities: c.catalog, prompts: p.catalog }
    },
    readToolFile: (t: Tier, f: string) => readCapabilityFile(ws.toolDir(t), f),
    writeToolFile: (t: Tier, f: string, c: string) => writeCapabilityFile(ws.toolDir(t), f, c, t),
    readPromptFile: (t: Tier, n: string) => readPrompt(ws.promptDir(t), n),
    writePromptFile: (t: Tier, n: string, c: string) => writePrompt(ws.promptDir(t), n, c, t),
    toolSources: () => listToolSourceLibs({ workspaceId: id, nodeModulesRoot: dirs.root, capabilityDirs }),
    resolveToolTypes: (specs: string[]) =>
      resolvePackageTypeLibs({ workspaceId: id, nodeModulesRoot: dirs.root, capabilityDirs }, specs),
    runtime: undefined as unknown as WorkspaceRuntime, // assigned in step 4
  } satisfies Workspace as Workspace

  // 2. Construct the RunController with the ALREADY-ALLOCATED `ws` reference.
  const controller = new RunController({ env, cwd: dirs.root, workspace: ws })

  // 3. Build the WorkspaceRuntime over that controller (run/get/list — §1).
  const runtime: WorkspaceRuntime = {
    run: (wf, input, options) =>
      controller.launch(() => prepareRun(wf, ws, input, options?.agent ?? 'claude'), options),
    get: (runId) => controller.get(runId),
    list: () => controller.list(),
  }

  // 4. Assign once. No reader observed `ws.runtime` before this point.
  ws.runtime = runtime
  return ws
}
