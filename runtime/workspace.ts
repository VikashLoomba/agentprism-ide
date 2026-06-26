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
// Capability-API shim (P1-C) — the load-bearing runtime fix
// ---------------------------------------------------------------------------
//
// Tools import the collision-proof bare specifier `agentprism/capability`. It
// resolves in three ways, all backed by REAL on-disk artifacts written here:
//   - Default / package-root workspace: Node self-references the package's own
//     `exports['./capability']` (package.json) — NO shim written.
//   - External workspace: a generated, sentinel-guarded `node_modules/agentprism`
//     shim package under the root re-exports PACKAGE_ROOT's capability source;
//     standard Node resolution from `<root>/tools/foo.ts` walks up to it. The
//     shim lives under `node_modules/` (gitignored), so the user's source tree is
//     never polluted. A REAL installed `agentprism` (sentinel absent) is detected
//     and left intact so its `./capability` export resolves natively.
//   - User-tier tools: `~/.agentprism/node_modules/agentprism`, resolvable from
//     `~/.agentprism/tools/foo.ts`.
// Any pre-existing `<root>/shared/capability.ts` left by the prior project-tree
// shim is now INERT (nothing imports it) and is intentionally left in place —
// removing files from the user's tree is out of scope.

const SHIM_MARKER = '_agentprismShim'
const SHIM_SENTINEL = '// @agentprism-capability-shim (generated; safe to delete)'

/** Forward-slashed, `./`-prefixed relative specifier from a generated shim package
 *  dir to PACKAGE_ROOT's capability source (portable; tsx-loadable). */
function capabilityRelSpecifier(pkgDir: string): string {
  const target = path.join(PACKAGE_ROOT, 'shared', 'capability.ts')
  const spec = path.relative(pkgDir, target).split(path.sep).join('/')
  return spec.startsWith('.') ? spec : `./${spec}`
}

/** True when a pre-existing `<parent>/node_modules/agentprism/package.json` is
 *  FOREIGN (a real install or a user file) and must be left intact. A missing file
 *  (→ ours to write) is false; an unparseable file is treated as foreign (true). */
function agentprismShimIsForeign(parent: string): boolean {
  const pkgJson = path.join(parent, 'node_modules', 'agentprism', 'package.json')
  let raw: string
  try {
    raw = fs.readFileSync(pkgJson, 'utf8')
  } catch {
    return false // absent → ours to write
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed[SHIM_MARKER] !== true
  } catch {
    return true // unparseable → foreign, leave as-is
  }
}

/** (Re)write a `node_modules/agentprism` shim package under `parent` that re-exports
 *  PACKAGE_ROOT's capability API, so a bare `agentprism/capability` import resolves
 *  there via standard Node resolution. Always rewrites when we own it (cheap; self-
 *  heals a moved PACKAGE_ROOT). The mkdir + both writes are best-effort: a read-only /
 *  full / permission-denied root must NOT fail the whole workspace open — it degrades
 *  to a per-module loadError (capability-loader captures it), which also keeps P1-B
 *  from pruning the root on a transient write failure. */
function writeAgentprismShim(parent: string): void {
  const pkgDir = path.join(parent, 'node_modules', 'agentprism')
  const rel = capabilityRelSpecifier(pkgDir)
  try {
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: 'agentprism',
          version: '0.0.0-agentprism-shim',
          type: 'module',
          exports: { './capability': './capability.ts' },
          [SHIM_MARKER]: true,
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(pkgDir, 'capability.ts'),
      `${SHIM_SENTINEL}\nexport * from ${JSON.stringify(rel)}\n`,
    )
  } catch {
    /* best-effort: shim is a convenience; the tool degrades to a per-module loadError */
  }
}

/** Project-tier shim: write `<root>/node_modules/agentprism` for an EXTERNAL
 *  workspace. The in-repo / package-root workspace self-references the package's own
 *  `exports['./capability']` and gets NO shim, so it is skipped. A real installed
 *  `agentprism` (sentinel absent) is left intact.
 *  ORDERING INVARIANT (P1-C): this runs synchronously inside createWorkspace →
 *  registry.open(), BEFORE loadCapabilities → deriveCapabilityDts, so the on-disk
 *  artifact that BOTH the dts Program and the Node `import()` resolve through is
 *  guaranteed present when those run. */
function ensureAgentprismPackageShim(root: string): void {
  if (canonicalizeRoot(root) === canonicalizeRoot(PACKAGE_ROOT)) return
  if (agentprismShimIsForeign(root)) return
  writeAgentprismShim(root)
}

/** User-tier shim (~/.agentprism). Written only when the user tools dir actually
 *  holds capability files, so `~/.agentprism/tools/foo.ts` resolves the bare
 *  specifier via `~/.agentprism/node_modules/agentprism`. Idempotent + process-
 *  global; a real installed `agentprism` (sentinel absent) is left intact. */
function ensureUserAgentprismShim(): void {
  let hasUserCaps = false
  try {
    hasUserCaps = fs.readdirSync(USER_TOOLS_DIR).some((f) => /\.(ts|mts|js|mjs)$/.test(f))
  } catch {
    /* USER_TOOLS_DIR absent → no user library → nothing to shim */
  }
  if (!hasUserCaps) return
  const userParent = path.dirname(USER_TOOLS_DIR) // ~/.agentprism
  if (agentprismShimIsForeign(userParent)) return
  writeAgentprismShim(userParent)
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
  ensureAgentprismPackageShim(dirs.root) // P1-C (external project tier; package root self-refs)
  ensureUserAgentprismShim() // P1-C (user tier, idempotent across workspaces)
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
      loadCapabilities({ capabilityDirs, workspaceRoot: dirs.root, env: e ?? env }),
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
