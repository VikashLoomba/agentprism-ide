# AgentPrism Workspace Architecture — Implementation Plan (Binding Contract)

Status: **LOCKED**. Downstream implementers follow this exactly and make **zero**
architectural decisions. Every signature, type, file, and resolution anchor is
specified. Where research flagged something unverifiable, it is resolved here
explicitly (see §11).

Branch: `feat/embeddable-runtime`. Repo root: `/home/vikash/prism-editor-web`.

---

## 0. Problem statement (the "weird hybrid") and the one-sentence fix

Today three independent mechanisms answer "where do things live":

1. **Eager `process.cwd()` module consts** in `server/config.ts` (`WORKFLOWS_DIR`,
   `DEFAULT_CWD`, `PROJECT_TOOLS_DIR`, `CAPABILITY_DIRS`, `PROJECT_PROMPTS_DIR`,
   `PROMPT_DIRS`) — frozen at first import.
2. **A `process.chdir(--cwd)` hack** in `bin/agentprism-ide.mjs:62`, run *before*
   importing the runtime so those consts capture the user's dir.
3. **`PACKAGE_ROOT`-anchored npm type resolution** in
   `server/workflow/tool-intellisense.ts:146` and the `REPO_ROOT` anchor in
   `server/workflow/derive-capability-dts.ts:22` — both wrongly anchored at
   AgentPrism's own install dir instead of the user's `node_modules`.

**The fix:** introduce a first-class `Workspace` (a single root directory) that
*owns* every per-project dir and every resolution method, derived from its `root`
(never from `process.cwd()`). A `WorkspaceRegistry` in the runtime hosts N
workspaces. `PACKAGE_ROOT` is retained for exactly one job: serving AgentPrism's
own bundled `dist/` and resolving its own agent bins. A `workspaceId` flows
through protocol → runtime → server → frontend so requests, runs, and editor
state are scoped to a workspace.

This is grounded in four research sources (cited inline as **[R1]** codebase
cartography, **[R2]** Monaco shipped-artifact analysis, **[R3]** TS/Node module
resolution docs, **[R4]** VS Code / LSP / multi-root prior art).

### Critical pre-existing fact the design must honor

In the current repo the workspace **is** the AgentPrism repo (cwd == repo root).
Real tools (`tools/gitlab.ts`, `tools/git.ts`, `tools/jira.ts`) import the
AgentPrism API as a **relative path**: `import { defineCapability } from
'../shared/capability.ts'`, which resolves to the repo's `shared/capability.ts`
**because ws == package today**. Once ws ≠ package, a tool at
`<ws>/tools/foo.ts` resolves `../shared/capability.ts` to `<ws>/shared/capability.ts`,
which will not exist. The capability API is **AgentPrism-owned** (PACKAGE_ROOT,
LOCKED decision 3); the editor already proves this by injecting
`@shared/capability.ts?raw` as a virtual lib (`monaco-setup.ts:12,20`).

This single AgentPrism-owned source — `<PACKAGE_ROOT>/shared/capability.ts` — must
back **three** consumers identically (LOCKED decision 4, "one source"):
1. **Runtime `await import()`** of the real tool module (`capability-loader.ts:89`)
   — resolved on disk via a **materialized shim** the workspace writes at
   `<ws>/shared/capability.ts` that re-exports PACKAGE_ROOT's source (§5.4). This is
   the load-bearing fix; without it every capability fails to load when ws ≠ package.
2. **`derive-capability-dts.ts`** Program — resolved via an in-memory CompilerHost
   overlay at the same `<ws>/shared/capability.ts` virtual path (§5.3).
3. **Monaco editor** — resolved via a virtual extra-lib at `file:///<wsId>/shared/capability.ts` (§2.4, §5).

All three point at the SAME file (`<PACKAGE_ROOT>/shared/capability.ts`), while npm
packages and `@types/node` resolve from the **workspace** `node_modules`. This keeps
the AgentPrism API on PACKAGE_ROOT and user npm deps on the workspace — exactly
LOCKED decisions 3 & 4. `shared/capability.ts` is **self-contained** (verified: no
relative sibling imports), so a single-file shim/overlay/lib is sufficient.

**This is true PER TIER, not just for the workspace root.** LOCKED decision 2 keeps a
**user tier** (`~/.agentprism/tools`) that the loader scans and `await import()`s
identically (`server/store/capabilities.ts` iterates BOTH tiers; `capability-loader.ts:88-90`
imports each). A user-tier tool at `~/.agentprism/tools/foo.ts` resolves
`../shared/capability.ts` to `~/.agentprism/shared/capability.ts`. So the SAME
three-consumer guarantee must hold at the **user root** too: runtime shim at
`~/.agentprism/shared/capability.ts` (§5.4 `ensureUserCapabilityShim`), derive-dts
overlay at the same path (§5.3 `userToolsParent`), and the editor's existing
user-tier mapping (`tool-intellisense.ts:80-81` → `file:///<wsId>/tools/<rel>` whose
`../shared/capability.ts` → `file:///<wsId>/shared/capability.ts`, §2.4/§5). All
point at the one PACKAGE_ROOT source.

---

## 1. The Workspace abstraction (TypeScript interfaces)

New file: **`runtime/workspace.ts`**. These interfaces are the contract.

```ts
// runtime/workspace.ts
import type { NodeJS } from 'node:process' // (illustrative; use ambient NodeJS.ProcessEnv)
import type { WorkflowFileInfo, ToolLib } from '../shared/protocol.ts'
import type { CapabilityCatalog } from '../shared/capability-resolve.ts'
import type { PromptCatalog } from '../shared/prompt-resolve.ts'
import type { LoadedCapabilities } from './engine/capability-loader.ts' // relocated, WU-R
import type { LoadedPrompts } from './engine/prompt-loader.ts'          // relocated, WU-R
import type { CapabilityFileInfo } from './store/capabilities.ts'       // relocated, WU-R
import type { PromptFileInfo } from './store/prompts.ts'                // relocated, WU-R
import type { WorkflowRef, RunHandle, RunOptions } from './index.ts'

export type Tier = 'project' | 'user'

/** The four conventional subdirs of a workspace root (LOCKED decision 1). */
export interface WorkspaceDirs {
  readonly root: string
  readonly tools: string        // <root>/tools
  readonly prompts: string      // <root>/prompts
  readonly workflows: string    // <root>/workflows
  readonly nodeModules: string  // <root>/node_modules  (npm import anchor, LOCKED decision 1/4)
}

/** One tiered search dir (project shadows user — LOCKED decision 2). */
export interface WorkspaceTier {
  readonly dir: string
  readonly tier: Tier
}

/** Safe, serializable description of a workspace (ships to the browser). */
export interface WorkspaceInfo {
  readonly id: string
  readonly name: string         // human slug (UI/debug only)
  readonly root: string         // absolute, canonicalized
  readonly isDefault: boolean
}

/** Per-workspace engine surface — today's Runtime.run/get/list, scoped to one
 *  workspace's own RunController (its own run registry, env, default cwd=root). */
export interface WorkspaceRuntime {
  run(workflow: WorkflowRef, input?: Record<string, unknown>, options?: RunOptions): RunHandle
  get(runId: string): RunHandle | undefined
  list(): RunHandle[]
}

/** A single-root workspace. Owns ALL per-project filesystem + resolution. The ONLY
 *  layer that touches the user's filesystem for user content. Stateless w.r.t.
 *  process.cwd(): every path derives from `dirs.root`. */
export interface Workspace {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly dirs: WorkspaceDirs
  /** Secret/env source threaded into capability effects + secret-status. Defaults
   *  to the registry's env (process.env). Never serialized. (Fixes B12.) */
  readonly env: NodeJS.ProcessEnv

  /** Ordered two-tier search dirs (project = this workspace, user = ~/.agentprism). */
  readonly capabilityDirs: readonly WorkspaceTier[] // [{tools, 'project'}, {USER_TOOLS_DIR, 'user'}]
  readonly promptDirs: readonly WorkspaceTier[]      // [{prompts, 'project'}, {USER_PROMPTS_DIR, 'user'}]

  toolDir(tier: Tier): string     // project -> dirs.tools ; user -> USER_TOOLS_DIR
  promptDir(tier: Tier): string   // project -> dirs.prompts ; user -> USER_PROMPTS_DIR

  // --- Workflows store (project tier only; workflows have no user tier today) ---
  listWorkflows(): Promise<WorkflowFileInfo[]>
  readWorkflow(name: string): Promise<string>
  writeWorkflow(name: string, content: string): Promise<WorkflowFileInfo>
  deleteWorkflow(name: string): Promise<void>

  // --- Catalog loaders (anchored at this workspace's dirs + node_modules) ---
  loadCapabilities(env?: NodeJS.ProcessEnv): Promise<LoadedCapabilities>
  loadPrompts(): Promise<LoadedPrompts>
  catalogs(): Promise<{ capabilities: CapabilityCatalog; prompts: PromptCatalog }>

  // --- Single-file editor IO (two-tier; tier selects project vs user dir) ---
  readToolFile(tier: Tier, fileName: string): Promise<{ path: string; content: string }>
  writeToolFile(tier: Tier, fileName: string, content: string): Promise<CapabilityFileInfo>
  readPromptFile(tier: Tier, name: string): Promise<{ path: string; content: string }>
  writePromptFile(tier: Tier, name: string, content: string): Promise<PromptFileInfo>

  // --- Editor intellisense (moved off PACKAGE_ROOT; anchored at dirs.nodeModules;
  //     virtual paths namespaced by `id` — §2.4, §5) ---
  toolSources(): ToolLib[]                      // file:///<id>/tools/<rel> ...
  resolveToolTypes(specifiers: string[]): ToolLib[] // file:///<id>/node_modules/<pkg>/... + package.json

  // --- Engine surface (per-workspace RunController, §2.5) ---
  /** NOT `readonly`: it is a plain mutable field assigned exactly once during
   *  construction (WU-6 step 4 `ws.runtime = runtime`) to resolve the
   *  Workspace ↔ RunController ↔ WorkspaceRuntime mutual reference, then never
   *  reassigned. Declaring it non-readonly here is what makes WU-6's post-build
   *  assignment compile (no TS2540); the two sites are deliberately consistent. */
  runtime: WorkspaceRuntime
}

/** Hosts N workspaces in one process. Open/close are first-class runtime
 *  mutations (the LSP `added`/`removed` delta model — [R4]), not boot params. */
export interface WorkspaceRegistry {
  /** Idempotent by id (realpath -> id). Returns the existing workspace if already
   *  open. `isDefault` is true only for the FIRST workspace opened. */
  open(root: string, opts?: WorkspaceOpenOptions): Workspace
  get(id: string): Workspace | undefined
  /** Throws a 404-style Error('Unknown workspace: <id>') when absent. */
  getOrThrow(id: string): Workspace
  has(id: string): boolean
  list(): WorkspaceInfo[]
  /** The current default workspace. Throws Error('No workspaces open') if the
   *  registry is empty (never returns undefined — callers like the server banner,
   *  /api/agents, and back-compat runtime.run depend on this). */
  default(): Workspace
  /** Id of the current default. Throws Error('No workspaces open') when empty. */
  defaultId(): string
  /** Close + tear down a workspace (§1.2). Cancels its in-flight runs, evicts its
   *  workspace-keyed derive-dts cache entry (`evictCapabilityDtsCache(ws.dirs.root)`,
   *  §5.3 — the ONLY per-workspace catalog cache the runtime owns), removes it from
   *  the map. REJECTS (throws
   *  Error('Cannot close the last open workspace')) when it is the only open
   *  workspace. When the closed id === the current defaultId, REASSIGNS defaultId to
   *  the next-oldest still-open workspace BEFORE removal, so default()/defaultId()/
   *  getOrThrow never dangle. */
  close(id: string): Promise<void>
}

export interface WorkspaceOpenOptions {
  env?: NodeJS.ProcessEnv
  /** When true, AGENTPRISM_*_DIR env overrides are honored for THIS workspace's
   *  dir derivation (back-compat single-workspace). The registry passes true ONLY
   *  to the default workspace; additionally-opened ones get false → pure
   *  root-derived dirs. (Resolves the "global env override vs N workspaces"
   *  ambiguity — §11.E.) */
  useEnvDirOverrides?: boolean
}
```

### 1.1 `workspaceId` scheme (justified from research)

```ts
// runtime/workspace.ts
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** slug-shorthash of the CANONICALIZED real root. Stable across restarts (pure
 *  function of the path), URL/path-segment safe, human-debuggable, collision
 *  resistant. Contains NO '@' (avoids Monaco scoped-URI bug [R2 #2295]).
 *
 *  Hash = first 8 hex chars of sha256(realRoot). Rationale for sha256-hex (NOT a
 *  hand-rolled base32): hex is already `[0-9a-f]` — URL-safe, path-segment-safe,
 *  no '@', deterministic across platforms, zero alphabet/endianness ambiguity. 8
 *  hex chars = 32 bits of the digest; for the tens of workspaces a single host
 *  realistically holds, collision probability is negligible (birthday bound
 *  ~1e-5 at 100 roots), and `WorkspaceRegistry.open` is keyed by THIS id so the
 *  same real root is always the same entry (idempotent). The slug is purely the
 *  human label (the VS Code `name` analogue); the hash is the real key. */
export function computeWorkspaceId(root: string): string {
  const real = canonicalizeRoot(root)
  const base = path.basename(real) || 'workspace'
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 8)
  return `${slug}-${hash}` // e.g. "myproj-1a2b3c4d"
}

/** Canonicalize symlinks + case-variant spellings so the SAME root collapses to
 *  ONE id. Mirrors LSP keying on folder URI and Node keying the module cache on
 *  resolved URL [R3, R4]. */
export function canonicalizeRoot(root: string): string {
  const abs = path.resolve(root)
  try { return fs.realpathSync.native(abs) } catch { return abs }
}
```

**Justification (cite):** VS Code identifies a folder by **URI**, not a path string,
and maps a resource back to its owning root by URI containment **[R4: VS Code
multi-root]**. LSP keys workspace folders by URI and treats open/close as an
`added`/`removed` delta **[R4: LSP 3.17]**. Node ESM caches modules by **resolved
URL** — symlinked/case-variant paths must collapse first **[R3: Node ESM URLs]**.
Hence: canonicalize via `realpathSync.native` first, then `sha256(realRoot)`. Two
roots that share a basename get DISTINCT ids because the 8 hex chars derive from
the full canonical path, not the basename — so the registry never overwrites one
workspace with another. There is no `base32` helper; the id is `slug-<8 hex>`,
fully specified above with no downstream implementation choices.

### 1.2 Workspace CLOSE lifecycle (the teardown half — fully specified)

`open()` is first-class; `close()` must be equally first-class or closing the
default/active workspace dangles the registry and 500s every core endpoint that
depends on `default()` (the server banner §WU-9, `GET /api/agents`'s `defaultCwd`,
WS `hello`'s `registry.defaultId()`, `GET /api/workspaces`'s `defaultId()`, and the
back-compat `runtime.run`/`catalogs` that delegate to `workspaces.default()`). The
registry maintains **insertion order** (a `Map` preserves it) and a `defaultId`
string. `close(id)` semantics are LOCKED:

1. **Reject closing the last open workspace.** If `list().length === 1` (i.e. `id`
   is the only one), `close` throws `Error('Cannot close the last open workspace')`.
   The DELETE route (§WU-9) surfaces this as a **409** (not 500). There is ALWAYS at
   least one workspace, so `default()`/`defaultId()`/`getOrThrow` can rely on a
   non-empty registry post-construction.
2. **Cancel in-flight runs + evict the one per-workspace cache** for `id`: iterate
   the workspace's `RunController.list()` and call each handle's `cancel()`; then call
   `evictCapabilityDtsCache(ws.dirs.root)` (the runtime's ONLY per-workspace catalog
   cache — the workspace-keyed `Map` in `runtime/engine/derive-capability-dts.ts`,
   §5.3; `loadCapabilities`/`loadPrompts` build fresh local Maps each call and hold no
   module-global cache to drop). It cannot evict Node's ESM module cache (§2.3).
3. **Reassign `defaultId` BEFORE removal when closing the default.** If
   `id === defaultId`, set `defaultId = ` the id of the **next-oldest still-open**
   workspace (the first remaining entry in insertion order after `id` is excluded).
   Because step 1 guarantees ≥1 other workspace remains, this never yields
   `undefined`. (A closed NON-default leaves `defaultId` untouched.)
4. **Remove `id` from the map.** After this, `default()`/`getOrThrow(defaultId)`
   resolve the reassigned default; no endpoint dangles.

`default()` and `getOrThrow(<missing>)` **throw a defined error** rather than
returning `undefined`: `default()`/`defaultId()` throw `Error('No workspaces open')`
(unreachable post-construction given rule 1, but defined so a future bug surfaces as
a clean error, not a `undefined.root` TypeError); `getOrThrow(id)` throws
`Error('Unknown workspace: <id>')` (the 404-style error from §1).

---

## 2. Multi-workspace as a first-class concern

### 2.1 Where `workspaceId` lives in each layer

| Concern | Carrier | Value |
|---|---|---|
| HTTP resource routes | **path segment** `/api/workspaces/:workspaceId/...` | scoped resource access [R4 LSP "scope by URI"] |
| HTTP registry routes | unprefixed `/api/workspaces` (list/open/close) | the registry surface |
| WS messages | **field** `workspaceId` on every run-scoped `ClientMessage`/`ServerMessage` | one socket multiplexes N workspaces [R4] |
| `RunRequest` | new field `workspaceId: string` | the run's owning workspace |
| Runtime API | `runtime.workspaces` registry + per-call `registry.get(id)` | createRuntime hosts the registry |
| Frontend | zustand `useStore.activeWorkspaceId` (single source of truth, no React context) + `localStorage('agentprism.activeWorkspaceId')` | active selection + persistence |
| Monaco URIs | **path prefix** `file:///<workspaceId>/...` on every model + extra lib | collision fix (§2.4) |

### 2.2 Concurrent runs across workspaces

Each `Workspace` owns its **own** `RunController` (`workspace.runtime`), so
concurrent runs in different workspaces share **no mutable engine state** — their
catalogs, `env`, default `cwd`, and `node_modules` all come from distinct
`Workspace` objects **[R4: "one resolver/loader per root"]**. `runId` is globally
unique (`nanoid`, `run-controller.ts:29`), so the WS layer can multiplex. The
server's `RunManager` keys by the **client-supplied runId** and additionally
records the owning `workspaceId` per entry (§WU-10), so `subscribe`/`cancel`/etc.
route without ambiguity.

### 2.3 `import()` module cache implications (and the leak)

`pathToFileURL(file.path)?v=<mtime>` (`capability-loader.ts:89`) already keys the
ESM cache by the **absolute** tool path + mtime query **[R3: Node ESM URLs]**.
Two workspaces with same-named tools sit at **different absolute paths** → distinct
cache entries → **no module-identity bleed** (this is free, provided we import by
the workspace's absolute path, which we do). **Known, accepted limitations,
documented here (no action required, do not "fix"):**
- Shared npm deps that resolve to the **same real path** across workspaces share
  one module instance + module-level state (Node has no per-workspace import
  sandbox) **[R3 §4]**.
- Every distinct `?v=` is a **permanent** registry entry; long-lived multi-workspace
  hosts leak module instances on repeated edits (no ESM uncache API) **[R3 §4, R4]**.
  `Workspace.close()` therefore cancels runs and evicts the **one per-workspace
  catalog cache** it owns — the workspace-keyed derive-dts `Map` in
  `runtime/engine/derive-capability-dts.ts` (§5.3), via the exported
  `evictCapabilityDtsCache(workspaceRoot)` — but cannot evict tool modules from
  Node's ESM cache. (The capability/prompt loaders build fresh local Maps per call
  and own no module-global cache.) A future
  `worker_thread`-per-workspace boundary is the only true reset; **design for it,
  do not build it now** **[R4]**.

### 2.4 The Monaco global-extra-libs collision (the hard part) — solved explicitly

**Constraint (verified against shipped artifacts [R2]):** `addExtraLib` /
`setExtraLibs` live on the **singleton** `monaco.languages.typescript.typescriptDefaults`
— there is exactly **one** `_extraLibs` map per TS worker, and the worker's project
is the **union of all live TS models + all extra libs**
(`ts.worker.js:getScriptFileNames`). Two workspaces both shipping
`file:///node_modules/zod/index.d.cts` (different versions) collide
last-writer-wins. Two models cannot share a URI **[R2 #899]**.

**Solution (two layers, both mandatory):**

1. **Namespace EVERY Monaco URI by `workspaceId`, in the PATH segment**
   (not the authority — keep `node_modules/@scope/...` out of the authority to
   dodge the `@`-in-authority resolution bug **[R2 #2295]**):
   - tool model URI: `file:///<wsId>/tools/<fileName>` (was `file:///tools/<fileName>`,
     `WorkflowEditor.tsx:118,145,153`).
   - capability API lib: `file:///<wsId>/shared/capability.ts` (was
     `file:///shared/capability.ts`, `monaco-setup.ts:20`). The tool model's
     relative `../shared/capability.ts` resolves to exactly this under its `<wsId>/`
     subtree **[R3: relative resolution from importing file's dir]**.
   - tool source libs: `file:///<wsId>/tools/...`.
   - npm type libs: `file:///<wsId>/node_modules/...`.
   Because TS resolves a buffer's relative + bare imports **relative to the
   importing file's URI** **[R3]**, prefixing makes each workspace's resolution
   self-contained inside its own subtree — wsA's `lodash` can never resolve into
   wsB's.

2. **Publish ONLY the active workspace's libs; dispose the inactive workspace's
   tool models on switch.** This is alexdima's documented active-context-swap
   pattern **[R2 #3783, R4]**, applied per-active-workspace. Namespacing alone does
   NOT prevent diagnostics-level collisions (all models still join one project,
   `ts.worker.js`), so on switch:
   ```
   typescriptDefaults.setExtraLibs([])                  // clear all
   typescriptDefaults.setExtraLibs(libsFor(activeWsId)) // base + sources + pkgs for active ws
   disposePriorWorkspaceToolModels()                    // remove stale models from the project
   ```
   This yields exact single-project semantics for the active workspace. Cost: one
   worker re-sync per switch (debounced) — acceptable **[R2 §6 option 1]**.

**The DSL globals `.d.ts` on `javascriptDefaults` is ALSO workspace-dependent — it
must be rebuilt on switch.** Correcting an earlier misstatement: the dts passed to
`updateWorkflowDts` (`monaco-setup.ts:251,255`) is built in the store by
`workflowDtsFor` (`useStore.ts:34-48`) from the **active workspace's** capability
and prompt catalogs (`buildWorkflowDts` emits the capability namespaces and
`declare const prompts`, scoped to the workflow's declared entries —
`useStore.ts:51-92`). Since `javascriptDefaults.setExtraLibs` is a module singleton
(`monaco-setup.ts:255`), after switching A→B the workflow-editor intellisense would
otherwise still show **workspace A's** capabilities/prompts — a real cross-workspace
bleed. **Fix (sequenced in the switch lifecycle, WU-13e + WU-14):** on
`setActiveWorkspace`, AFTER the store has re-fetched workspace B's
capabilities/prompts and rebuilt `workflowDts` STATE (WU-13e steps 5-7), the
`WorkflowEditor`'s `workflowDts`-subscribed effect (WU-14) calls
`updateWorkflowDts(monaco, workflowDts)` so `javascriptDefaults` reflects the active
workspace. (The store rebuilds the dts via `workflowDtsFor(...)` against B's catalogs;
it holds no monaco ref, so the editor applies it.) This runs alongside the
`typescriptDefaults`
extra-libs swap below; the two surfaces (workflow `.js` on `javascriptDefaults`,
tool `.ts` on `typescriptDefaults`) are swapped together on every switch. Only the
genuinely ws-independent part — the connected-agent union in the DSL dts — is shared;
the catalog-derived part is rebuilt per active workspace.

Multi-pane "two workspaces visible at once" is explicitly **out of scope** for v1;
if ever needed it requires separate editor instances each with its own TS worker
via `setWorkerOptions({ customWorkerPath })` because `typescriptDefaults` is a
module singleton **[R2 §6 option 3]**. Do not attempt it here.

### 2.5 Runtime API: `createRuntime` hosts the registry

```ts
// runtime/index.ts
export interface RuntimeOptions {
  /** Pre-open these roots; the FIRST is the default. Back-compat: omit -> a single
   *  default workspace at `cwd ?? process.cwd()` (today's behavior). */
  workspaces?: Array<string | { root: string; env?: NodeJS.ProcessEnv }>
  cwd?: string                    // back-compat: default workspace root when `workspaces` omitted
  env?: NodeJS.ProcessEnv         // registry-wide default env
}

export interface Runtime {
  readonly workspaces: WorkspaceRegistry
  /** Back-compat convenience delegating to `workspaces.default()`. */
  run(workflow: WorkflowRef, input?: Record<string, unknown>, options?: RunOptions): RunHandle
  get(runId: string): RunHandle | undefined   // searches all open workspaces
  list(): RunHandle[]                          // flattens all open workspaces
  catalogs(): Promise<{ capabilities: CapabilityCatalog; prompts: PromptCatalog }> // default ws
  /** Process-global agent catalog + PACKAGE_ROOT install probe (§4.1). NOT
   *  workspace-scoped: agent bins ship with AgentPrism. Delegates to
   *  runtime/agents.ts `listAgents()`. The server PROJECTS this; it performs no
   *  fs/path resolution of its own. */
  listAgents(): AcpAgentSpec[]
}
```

`createRuntime({})` with no `workspaces` opens ONE workspace at
`cwd ?? process.cwd()` with `useEnvDirOverrides: true` and marks it default →
**byte-for-byte today's single-workspace behavior** (back-compat, §8).

---

## 3. PACKAGE_ROOT vs WORKSPACE — applied to every current site

Derived from the **[R1]** cartography. "Move" = becomes Workspace-derived (from
`root`). "Keep" = stays `PACKAGE_ROOT`/process-global (LOCKED decision 3).

| Site (file:line) | Today anchored at | Verdict | New anchor |
|---|---|---|---|
| `config.ts:24` `PACKAGE_ROOT` | install dir | **KEEP** | PACKAGE_ROOT (dist + agent bins only) |
| `config.ts:27` `WORKFLOWS_DIR` | `cwd()/workflows` | **MOVE** | `Workspace.dirs.workflows` |
| `config.ts:31` `DEFAULT_CWD` | `cwd()` | **MOVE** | `Workspace.root` (per run via RunController default) |
| `config.ts:55` `PROJECT_TOOLS_DIR` | `cwd()/tools` | **MOVE** | `Workspace.dirs.tools` |
| `config.ts:59` `USER_TOOLS_DIR` | `~/.agentprism/tools` | **KEEP** | process-global user tier (shared lib, LOCKED 2) |
| `config.ts:62` `CAPABILITY_DIRS` | globals | **MOVE** | `Workspace.capabilityDirs` |
| `config.ts:68` `PROJECT_PROMPTS_DIR` | `cwd()/prompts` | **MOVE** | `Workspace.dirs.prompts` |
| `config.ts:72` `USER_PROMPTS_DIR` | `~/.agentprism/prompts` | **KEEP** | process-global user tier |
| `config.ts:75` `PROMPT_DIRS` | globals | **MOVE** | `Workspace.promptDirs` |
| `config.ts:46` `resolveAgentBin` | PACKAGE_ROOT | **KEEP** | PACKAGE_ROOT |
| `tool-intellisense.ts:146` probe | PACKAGE_ROOT | **MOVE** | `Workspace.dirs.nodeModules` (§5) |
| `derive-capability-dts.ts:22,83` REPO_ROOT | install dir | **MOVE** | `Workspace.root` + PACKAGE_ROOT cap-overlay (§5.3) |
| `inline.ts:71` `TOOLS_DIRS` | globals | **MOVE** | per-call `opts.toolsDirs` from Workspace |
| `factory.ts:67-77` `isInstalled` (candidate-path compose + `fs.existsSync`) | PACKAGE_ROOT, **in server** | **MOVE** | `runtime/agents.ts` `isAgentInstalled` (PACKAGE_ROOT, in runtime) — §4.1 |
| `factory.ts:76-77` `agentsWithStatus()` | PACKAGE_ROOT, **in server** | **MOVE** | `runtime/agents.ts` `listAgents()`; server PROJECTS `runtime.listAgents()` |
| `factory.ts:250` `distDir` static serve | PACKAGE_ROOT | **KEEP** | PACKAGE_ROOT |
| `factory.ts:150-154,176-180` tier→dir maps | globals (B13) | **MOVE** | `workspace.toolDir/promptDir` |
| `run-controller.ts:17,165` `DEFAULT_CWD` | global | **MOVE** | `Workspace.root` via RunController ctor |
| `resolve.ts:19` `readWorkflow(name)` | global dir | **MOVE** | `workspace.readWorkflow(name)` |
| `bin:62` `process.chdir` | process-global | **DELETE** | pass `root` to `registry.open` |

### 3.1 Eliminating the chdir hack and the eager consts

- `bin/agentprism-ide.mjs`: delete the `process.chdir(cwd)` (line 62). Instead pass
  `{ workspaces: [cwd, ...extraWorkspaces] }` to `createRuntime`. The eager consts
  no longer exist, so nothing depends on cwd at import time (B1, B2 closed).
- `server/config.ts`: the six cwd-derived eager consts are DELETED and the
  process-global resolution values move to `runtime/paths.ts`; `config.ts` is left as
  `PORT` + a re-export of `{ PACKAGE_ROOT, resolveAgentBin }` (§WU-R, §6.1).

---

## 4. Move `tool-intellisense.ts` onto the Workspace (runtime layer)

**[R1 §8]** is the prior art. The relocation:

- Create **`runtime/tool-intellisense.ts`** with pure functions parameterized by a
  resolution anchor (no globals):
  ```ts
  export interface ToolIntellisenseAnchor {
    workspaceId: string
    nodeModulesRoot: string          // = workspace.dirs.root (probe lives here; bundler walks its node_modules)
    capabilityDirs: readonly { dir: string }[]  // workspace.capabilityDirs
  }
  export function listToolSourceLibs(a: ToolIntellisenseAnchor): ToolLib[]
  export function resolvePackageTypeLibs(a: ToolIntellisenseAnchor, specifiers: string[]): ToolLib[]
  ```
- The synthetic probe entry moves from `path.join(PACKAGE_ROOT, '__prism_types_probe__.ts')`
  (`:146`) to `path.join(a.nodeModulesRoot, '__prism_types_probe__.ts')`. Under
  `moduleResolution: Bundler`, TS resolves bare specifiers by walking `node_modules`
  upward from the **directory of the containing file** — so a probe physically at
  `<workspace>/__prism_types_probe__.ts` resolves `lodash`/`zod` from
  `<workspace>/node_modules`, independent of `process.cwd()` and of where the
  `typescript` package is installed **[R3 §1: `bundlerModuleNameResolver` →
  `getDirectoryPath(containingFile)`]**. This is the **exact** same upward
  `node_modules` walk Node's `await import()` uses for the same tool file **[R3 §4:
  `PACKAGE_RESOLVE`]**, satisfying LOCKED decision 4 (editor types == runtime
  behavior, one source).
- **Add `preserveSymlinks: true`** to the probe's `CompilerOptions` (§5.2).
- **Namespace virtual paths by `workspaceId`** in `nodeModulesVirtual` and the
  tool-source mapping: `file:///<wsId>/node_modules/...` and `file:///<wsId>/tools/<rel>`
  (was `file:///node_modules/...` / `file:///tools/...`). Carry over unchanged: the
  `/\.d\.[mc]?ts$/` flavour match (`:170`), the `typescript/` + `@types/node/`
  skips (`:173-174`), and shipping each package's `package.json` (`:184-195`) **[R3 §2,§3]**.
- `Workspace.toolSources()` / `resolveToolTypes()` call these with the workspace's
  anchor.
- The file is relocated to `runtime/tool-intellisense.ts` by WU-R (no copy remains
  under `server/`) and its body rewritten by WU-5. The server's
  `/api/tool-sources` and `/api/tool-types` routes delegate to
  `req.workspace.toolSources()` / `req.workspace.resolveToolTypes(specifiers)`
  (§WU-9). The server holds NO resolution logic (B13 closed).

### 4.1 Move the agent-installed probe onto the runtime (B16)

The agent-installed probe is **filesystem resolution executed in the projection
layer** today: `server/factory.ts:67-77` composes
`path.join(PACKAGE_ROOT, 'node_modules', '@agentclientprotocol', '<id>-agent-acp')`
(two variants), runs `fs.existsSync` over the candidates (`isInstalled`), and
`agentsWithStatus()` computes `installed` per agent **inside the server**. That is
the mandate's "the ONLY layer that touches the filesystem" being violated, and it
directly contradicts the §6 server MUST-NOT cell. It anchors at **PACKAGE_ROOT**
(AgentPrism's own install dir — the agent bins ship with AgentPrism, LOCKED
decision 3), so it does NOT become Workspace-derived; it moves to the runtime
**alongside the `PACKAGE_ROOT`/`resolveAgentBin` it already owns**.

- Create **`runtime/agents.ts`** (runtime-tier, sibling of `runtime/paths.ts`):
  ```ts
  // runtime/agents.ts
  import fs from 'node:fs'
  import path from 'node:path'
  import { PACKAGE_ROOT, resolveAgentBin } from './paths.ts'
  import { ACP_AGENT_LIST } from '../shared/agents.ts'
  import type { AcpAgentSpec } from '../shared/agents.ts'

  /** True iff agentId's ACP bin is installed under AgentPrism's PACKAGE_ROOT.
   *  This is the EXACT candidate-path composition + fs.existsSync moved verbatim
   *  out of server/factory.ts:67-73 — no behavior change, only relocation. */
  export function isAgentInstalled(agentId: string): boolean {
    const candidates = [
      resolveAgentBin(agentId),
      path.join(PACKAGE_ROOT, 'node_modules', '@agentclientprotocol', `${agentId}-agent-acp`),
      path.join(PACKAGE_ROOT, 'node_modules', '@agentclientprotocol', `${agentId}-acp`),
    ].filter(Boolean) as string[]
    return candidates.some((p) => fs.existsSync(p))
  }

  /** The agent catalog with per-agent installed status (was factory.ts
   *  agentsWithStatus()). Process-global (not workspace-scoped): agent bins ship
   *  with AgentPrism at PACKAGE_ROOT, identical for every workspace. */
  export function listAgents(): AcpAgentSpec[] {
    return ACP_AGENT_LIST.map((a) => ({ ...a, installed: isAgentInstalled(a.id) }))
  }
  ```
- Expose `listAgents` on the `Runtime` surface (§2.5) so the server PROJECTS it.
- In `server/factory.ts` (WU-9): **delete** `isInstalled` and `agentsWithStatus`,
  and drop the agent-probe-only import `resolveAgentBin` and the `@agentclientprotocol`
  list import `ACP_AGENT_LIST`. **KEEP the `fs` and `path` imports** — they are NOT
  agent-probe-only: `fs.existsSync(distDir)` + `path.join(PACKAGE_ROOT,'dist')` /
  `path.join(distDir,'index.html')` back the PACKAGE_ROOT static-dist serve
  (`factory.ts:250-255`, kept UNCHANGED per LOCKED decision 3), and the new
  `POST /api/workspaces` route uses `path.resolve(root)` (§WU-9). KEEP `PACKAGE_ROOT`
  imported (from `runtime/paths.ts`) solely for that `distDir` join. The legitimate
  remaining `fs.existsSync` is the dist probe ONLY; the server composes **zero**
  agent candidate paths and calls **zero** `path.join(PACKAGE_ROOT, 'node_modules', …)`
  / agent `fs.existsSync` of its own. `GET /api/agents` becomes
  `{ agents: runtime.listAgents(), defaultCwd: runtime.workspaces.default().root }`
  and the WS `hello` uses `runtime.listAgents()`.
- Gate (§9.6) — scoped to AGENT-PROBE tokens only (the bare `existsSync` term is
  DELETED because the legitimate PACKAGE_ROOT dist `existsSync` at `factory.ts:251`
  must remain and is allowed by LOCKED decision 3):
  `grep -nE "@agentclientprotocol|isInstalled|agentsWithStatus|resolveAgentBin" server/factory.ts`
  → **zero matches**. The dist `fs.existsSync(distDir)` is intentionally NOT matched
  by this gate.

---

## 5. Resolution-anchor details (the load-bearing TS/Node facts)

### 5.1 Why moving the probe is sufficient (no custom resolver)
`ts.createProgram` reaches the FS only via the CompilerHost's `fileExists`/`readFile`/
`getDirectories`/`directoryExists`/`realpath`. The default `ts.sys`-backed host
already resolves from the workspace **provided the entry file lives in the
workspace** — because the bundler walk is driven by the absolute `containingFile`,
NOT `getCurrentDirectory()` **[R3 §1]**. Keep the existing synthetic-entry overlay
(`tool-intellisense.ts:149-158`) verbatim; only change the anchor path. Optionally
also set `getCurrentDirectory: () => a.nodeModulesRoot` to drop the residual
`process.cwd()` dependency (cheap; do it).

### 5.2 The symlink/realpath fix (private/patched/monorepo-linked deps)
Default `preserveSymlinks: false` rewrites external `node_modules` imports to their
**real path**; for a `pnpm`/`npm link`/monorepo dep, the harvested `fileName` is the
real path (e.g. `<monorepo>/packages/<pkg>/index.d.cts`) which does **not** contain
`node_modules/` → the substring filter (`:167`) silently drops it, losing types for
exactly the private/patched/linked packages LOCKED decision 4 cares most about
**[R3 §5]**. **Resolution (locked, option 1):** set `preserveSymlinks: true` on the
throwaway intellisense Program's `CompilerOptions`. Resolved paths then stay under
`<workspace>/node_modules/<pkg>/…`, so both the `node_modules/` filter and the
`file:///<wsId>/node_modules/...` re-keying keep working unchanged, and the editor's
virtual paths match the bare specifier the tool author typed. This affects only the
intellisense Program, never the runtime.

### 5.3 `derive-capability-dts.ts` re-anchor (B10) + the capability-API overlay
`deriveCapabilityDts` derives each capability's namespace `.d.ts` from effect
signatures; a tool whose effect **return type** depends on a workspace npm package
must derive from the **workspace** `node_modules`, and its relative
`../shared/capability.ts` must resolve to **AgentPrism's** API (§0). Locked changes:
- `getCurrentDirectory = () => workspaceRoot` (was `REPO_ROOT`, `:83`).
- `INJECT_PATH`/`CHECK_PATH` move under `workspaceRoot` (was `REPO_ROOT`, `:24-25`).
- Keep `types: ['node']` (`:39`) → `@types/node` now resolves from the **workspace**
  `node_modules` (walking up) **[R3 §1]**.
- **Overlay AgentPrism's `shared/capability.ts`** (read once from
  `path.join(PACKAGE_ROOT, 'shared', 'capability.ts')`) into the host's overlay map
  at the workspace-relative virtual path the imports resolve to:
  `path.join(workspaceRoot, 'shared', 'capability.ts')`. This makes BOTH `INJECT_SRC`'s
  `import ... from './shared/capability.ts'` and each project-tier tool's
  `../shared/capability.ts` resolve to AgentPrism's real API source — while npm +
  `@types/node` come from the workspace. (Keeps the AgentPrism API on PACKAGE_ROOT
  per decision 3; user deps on the workspace per decision 4.)
- **ALSO overlay the SAME PACKAGE_ROOT source at the USER-tier path** (B15,
  symmetric with §5.4): a user-tier capability at `~/.agentprism/tools/foo.ts` is in
  the same scanned `files` set and resolves `../shared/capability.ts` to
  `~/.agentprism/shared/capability.ts`. `deriveCapabilityDts` therefore overlays the
  PACKAGE_ROOT source at `path.join(userToolsParent, 'shared', 'capability.ts')` too,
  where `userToolsParent = path.dirname(USER_TOOLS_DIR)` (= `~/.agentprism`). Pass
  `userToolsParent` into the options (`opts: { workspaceRoot; packageRoot;
  userToolsParent }`); the loader supplies `path.dirname(USER_TOOLS_DIR)`. Without
  this, a user-tier tool whose effect return type references the cap API loses its
  derived dts even though the runtime shim lets it load — the editor (which DOES map
  user-tier sources, §5.3-companion in tool-intellisense) and runtime would diverge,
  violating LOCKED decision 4. (Both overlays point at the one PACKAGE_ROOT source,
  so there is no duplication of truth.)
- **Add `preserveSymlinks: true`** here too (same rationale as §5.2).
- Make the module-global `cache` (`:118`) **workspace-keyed**: re-type it as
  `Map<string /*workspaceRoot*/, { sig: string; map: Map<string,string> }>` so two
  workspaces with same-path/same-mtime tools do not share a derived dts (B4). The
  per-call signature is stored as `cache.get(workspaceRoot)?.sig`; on a hit (same
  `sig`) reuse `.map`, else recompute and overwrite the `workspaceRoot` entry.
- **Export an eviction API** so `WorkspaceRegistry.close` (§1.2 step 2) can drop a
  closed workspace's entry without reaching into the module global:
  ```ts
  // runtime/engine/derive-capability-dts.ts
  export function evictCapabilityDtsCache(workspaceRoot: string): void {
    cache.delete(workspaceRoot)
  }
  ```
  This is the runtime's ONLY per-workspace catalog cache; `registry.close(id)` calls
  `evictCapabilityDtsCache(ws.dirs.root)` (the workspace's canonical root key).

### 5.4 Runtime `await import()` — the capability-API shim (the load-bearing runtime fix)
`capability-loader.ts:89` does a **real on-disk** `await import(pathToFileURL(file.path)?v=<mtime>)`.
There is NO CompilerHost overlay at runtime (overlays exist only for the throwaway
dts Program §5.3 and the Monaco lib §2.4). Node/tsx resolves the tool's
`import { defineCapability } from '../shared/capability.ts'` **relative to the tool
file's own directory** **[R3 §4: relative specifier resolution]**, i.e. to
`<ws>/shared/capability.ts`. When ws ≠ package that path does not exist → every
capability throws "cannot find module" (caught per-module as `loadError`) → the
whole catalog is empty. This MUST be fixed in the runtime, not only the editor.

**Mechanism (locked): materialize a re-export shim at `<root>/shared/capability.ts`
for EVERY tier that holds capabilities** (project AND user — LOCKED decision 2's
cross-project shared library is inherently multi-workspace, so it cannot be
skipped). The same on-disk `await import()` resolution that makes a project-tier
tool at `<ws>/tools/foo.ts` resolve `../shared/capability.ts` to
`<ws>/shared/capability.ts` ALSO makes a **user-tier** tool at
`~/.agentprism/tools/foo.ts` resolve `../shared/capability.ts` to
`~/.agentprism/shared/capability.ts` **[R3 §4]**. `capability-loader.ts:88-90`
`await import()`s EVERY scanned file across BOTH tiers
(`server/store/capabilities.ts` scans `for (const {dir,tier} of CAPABILITY_DIRS)`),
so a user-tier capability throws "cannot find module" at runtime unless the user
root ALSO carries the shim. One shared, parameterized writer backs both:

```ts
// runtime/workspace.ts — guarded + idempotent. Called from createWorkspace().
import { PACKAGE_ROOT, USER_TOOLS_DIR } from './paths.ts'

const SHIM_SENTINEL = '// @agentprism-capability-shim (generated; safe to delete)'

/** Ensure `<root>/shared/capability.ts` exists and re-exports AgentPrism's API,
 *  so a tool's on-disk `../shared/capability.ts` import resolves at runtime to the
 *  PACKAGE_ROOT source (§0). Idempotent; no-op when `<root>/shared` already IS
 *  PACKAGE_ROOT's (ws == package); never clobbers a user's own non-shim file. */
function ensureCapabilityShimAt(root: string): void {
  const pkgCap = path.join(PACKAGE_ROOT, 'shared', 'capability.ts')
  const cap = path.join(root, 'shared', 'capability.ts')
  // root == package (default single-workspace / back-compat): the real file already
  // IS PACKAGE_ROOT's — leave it untouched.
  try {
    if (fs.realpathSync.native(cap) === fs.realpathSync.native(pkgCap)) return
  } catch { /* cap absent — fall through to write */ }
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
function ensureCapabilityShim(root: string): void { ensureCapabilityShimAt(root) }

/** User-tier shim (~/.agentprism). Written only when the user tools dir actually
 *  holds capability files, so we never create `~/.agentprism/shared` for users who
 *  have no shared library. The user root is `path.dirname(USER_TOOLS_DIR)` =
 *  `~/.agentprism` (config.ts:59 `USER_TOOLS_DIR = <HOME>/.agentprism/tools`), so
 *  the shim lands at `~/.agentprism/shared/capability.ts` — exactly where a
 *  `~/.agentprism/tools/foo.ts`'s `../shared/capability.ts` resolves. Idempotent
 *  and process-global; calling it once per workspace open is a cheap no-op after
 *  the first. */
function ensureUserCapabilityShim(): void {
  let hasUserCaps = false
  try {
    hasUserCaps = fs.readdirSync(USER_TOOLS_DIR).some((f) => /\.(ts|mts|js|mjs)$/.test(f))
  } catch { /* USER_TOOLS_DIR absent → no user library → nothing to shim */ }
  if (!hasUserCaps) return
  ensureCapabilityShimAt(path.dirname(USER_TOOLS_DIR)) // ~/.agentprism
}
```

`export *` re-exports the values (`defineCapability`) **and** the types
(`Json`, `Capability`, `CapabilityContext`, `EffectFn`) because `capability.ts`
exports them as named exports; tsx erases the type-only ones at load. This is a
**documented on-disk side effect**: opening a workspace may create
`<ws>/shared/capability.ts` and/or `~/.agentprism/shared/capability.ts` (the latter
only when a user-tier library exists). `Workspace.close()` does NOT delete either (a
concurrent run may still be importing through it; both are harmless and idempotent
on reopen). The shims' existence makes the §5.3 derive-dts overlays and the Monaco
libs redundant-but-consistent (all resolve to the one PACKAGE_ROOT source) across
both tiers.

**Alternatives rejected:** (a) a Node/tsx `resolve` loader-hook redirecting the
`*/shared/capability.ts` specifier — rejected: global, order-sensitive with the
existing `tsx` register, and harder to make per-workspace; (b) changing the
authoring convention to a bare `@agentprism/runtime` specifier resolved from
`<ws>/node_modules` — rejected for v1: it breaks the in-repo case
(`<ws>/node_modules/agentprism` does not exist when ws is the repo) and would
require rewriting every existing tool + the `agentprism-authoring` skill. The shim
preserves the existing relative-import convention verbatim.

The only OTHER requirement is that `file.path` comes from the **selected
workspace's** scan, not a cwd const **[R3 §4]** — which holds once
`scanCapabilityFiles` takes the workspace's `capabilityDirs` (§WU-2/WU-3).

---

## 6. Layer delineation table (who owns what)

| Layer | OWNS | MUST NOT |
|---|---|---|
| **`@agentprism/runtime`** (`runtime/` — incl. `runtime/engine/*`, `runtime/store/*`, `runtime/acp/*`, `runtime/paths.ts`, `runtime/agents.ts`, `runtime/tool-intellisense.ts`, all relocated in WU-R) | `Workspace`, `WorkspaceRegistry`, `computeWorkspaceId`, the capability-shim, per-workspace `RunController`, ALL fs reads/writes (user content AND the PACKAGE_ROOT agent-installed probe), catalog loading, tool-intellisense, dts derivation, inliner, workflow store, agent (acp) transport + **agent discovery/install probe** (`isAgentInstalled`/`listAgents`, §4.1), `await import()`. The ONLY layer that touches the filesystem. | read `process.cwd()` **FOR RESOLUTION** — i.e. inside `Workspace`/`createWorkspace`/`deriveWorkspaceDirs`/the loaders/`WorkspaceRegistry`/`run-controller`/`run.ts`/`tool-intellisense`/`derive-capability-dts`, NONE of which may read `process.cwd()` (they derive every path from an explicit `root`/anchor). **SOLE permitted reader (carve-out, explicit):** the composition-root back-compat default in `runtime/index.ts` only — `createRuntime`/`runWorkflow` choosing `cwd ?? process.cwd()` ONCE at call time as the default workspace root (§2.5/WU-8/§8); nothing downstream of that one read touches `process.cwd()`. Also MUST NOT: read any eager dir const; know about HTTP/WS; import anything under `../server/` (gates §9.5 runtime-cwd scoping + §9.7) |
| **`@agentprism/server`** (`server/factory.ts`, `server/run-manager.ts`, `server/index.ts`, thin `server/config.ts`) | HTTP/WS transport; route `:workspaceId` → `registry.getOrThrow(id)`; project `Workspace` + `WorkspaceRuntime` + `runtime.listAgents()` to JSON/WS; PACKAGE_ROOT static dist serving (`PACKAGE_ROOT` imported FROM `runtime/paths.ts` for the `distDir` join only). | contain ANY resolution logic — including the agent-install probe (now `runtime.listAgents()`); compose any agent/user-content candidate path or call `fs.existsSync`/`path.join(PACKAGE_ROOT, 'node_modules', …)` for agent or user content. The SOLE permitted PACKAGE_ROOT/fs use is the dist static-serve join in the OWNS cell (`path.join(PACKAGE_ROOT, 'dist')` + `fs.existsSync(distDir)`, factory.ts:250-251, kept UNCHANGED per LOCKED decision 3 / §4.1 / §9.6); the server composes ZERO agent candidate paths. Also MUST NOT: import `*_DIR` consts; import `tool-intellisense`; construct an engine. (Importing runtime is allowed; runtime importing server is not.) |
| **frontend** (`src/`) | Monaco editor, workspace picker/switch, per-workspace lib managers + URI namespacing, active-workspace swap, localStorage persistence; threads `workspaceId` on every API/WS call. | touch the filesystem; resolve types itself (worker has no fs/network — [R2 §4]); rely on extra libs for cross-workspace isolation |
| **`agentprism-ide` bin** (`bin/agentprism-ide.mjs`) | boot: register tsx, `createRuntime({ workspaces: [cwd, ...--workspace] })`, `createServer(runtime)`, listen; PACKAGE_ROOT discovery for dist/agent bins. | `process.chdir`; pick a workspace via cwd |

### 6.1 Physical relocation: the resolution + engine tier MOVES into `runtime/`

The brief's layer contract — runtime is "the ONLY layer that touches the
filesystem" and the embeddable npm package; server is "a thin HTTP/WS adapter …
No resolution logic of its own" — is violated **at the module-graph level** by the
current tree: `runtime/index.ts:14-15` and `runtime/run-controller.ts:15-17`
already import the fs/resolution/engine helpers from `../server/…`. After WU-6 the
`Workspace` becomes their sole caller, so leaving them under `server/` would mean
`@agentprism/runtime` (the `.` export → `dist-lib/runtime/index.js`) cannot be
loaded without dragging in `@agentprism/server`. "Parameterize in place" does NOT
fix this — the import edge remains. **This plan therefore RELOCATES the entire
runtime-tier subtree** (WU-R), so that **zero `runtime/* → ../server/*` edges
remain**. This is the same relocation the brief already mandates for
`tool-intellisense.ts`, applied consistently.

Relocation (all via `git mv` + import-path rewrites; verified self-contained — see
WU-R for the dependency proof):

| From (server/) | To (runtime/) | Why it is runtime-tier |
|---|---|---|
| `server/workflow/*` (run.ts, executor.ts, inline.ts, instrument.ts, errors.ts, capability-loader.ts, prompt-loader.ts, derive-capability-dts.ts, `methods/`) | `runtime/engine/*` | the workflow engine + capability/prompt loading + inliner + dts derivation |
| `server/store/*` (workflows.ts, capabilities.ts, prompts.ts) | `runtime/store/*` | filesystem read/write of user content |
| `server/acp/connection.ts` | `runtime/acp/connection.ts` | agent-process transport used only by the engine (`run.ts:28`); NOT imported by `factory.ts`/`run-manager.ts` (verified) |
| resolution consts in `server/config.ts` (`findPackageRoot`, `PACKAGE_ROOT`, `HOME`, `USER_TOOLS_DIR`, `USER_PROMPTS_DIR`, `AGENT_BINS`, `resolveAgentBin`, the new `deriveWorkspaceDirs`) | `runtime/paths.ts` | path/anchor resolution owned by runtime |

What STAYS under `server/`: `factory.ts`, `run-manager.ts`, `index.ts`, and a thin
`server/config.ts` holding only `PORT` and re-exporting `{ PACKAGE_ROOT,
resolveAgentBin }` from `runtime/paths.ts` for the adapter's dist-serving + agent
probe. **A `server/* → runtime/*` edge is ALLOWED** (server is the consumer/adapter
of runtime); only the inverse is forbidden. `tool-intellisense.ts` becomes
`runtime/tool-intellisense.ts` (§4, not under `engine/` since it is editor-support,
not the run engine).

`package.json#files` already ships `runtime/` and `server/`; no manifest change is
needed, but `tsconfig.server.json#include` (today `["server","shared"]`) gains
`"runtime"` because `factory.ts` now imports runtime types (WU-R). `tsconfig.lib.json`
already includes `["runtime","server","shared"]`.

**Boundary is now testable (gate, §9 step 7):**
`grep -rn "from '\.\./server\|from '\.\./\.\./server" runtime/` → **zero matches**.

---

## 7. File-by-file work units (disjoint, parallelizable)

Each unit is fully specified — no "implementer decides", no TODO, no "for now".
`dependsOn` lists hard ordering. Units with no shared `dependsOn` run in parallel.

### WU-0 — Protocol & shared DTOs  ·  files: `shared/protocol.ts`  ·  dependsOn: []
- Add to `RunRequest` (after `cwd`): `workspaceId: string`.
- Add `workspaceId: string` to every run-scoped `ClientMessage` variant EXCEPT
  `ping`: `start` (already nests `run.workspaceId`; ALSO add top-level
  `workspaceId` for symmetry), `subscribe`, `resume`, `step`, `cancel`,
  `setBreakpoints`, `permission`, `input`. Final union:
  ```ts
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
  ```
- Extend `ServerMessage`: change `hello` to
  `{ t: 'hello'; agents: AcpAgentSpec[]; workspaces: WorkspaceInfo[]; defaultWorkspaceId: string }`.
  Add `workspaceId: string` to run-scoped server messages: `snapshot` (add a sibling
  `workspaceId` field), `event`, `permission`, `permission:resolved`, `input`,
  `input:resolved`, and optional `workspaceId?` on `error`. `pong` unchanged.
- Add DTOs:
  ```ts
  export interface WorkspaceInfo { id: string; name: string; root: string; isDefault: boolean }
  export interface WorkspacesResponse { workspaces: WorkspaceInfo[]; defaultWorkspaceId: string }
  export interface OpenWorkspaceRequest { root: string }
  ```
  (Import `WorkspaceInfo` type into `runtime/workspace.ts` rather than redefining.)
- `AgentsResponse.defaultCwd` stays (back-compat) but is now the **default
  workspace root** (§WU-9).

### WU-R — Relocate the runtime-tier subtree (§6.1)  ·  files: `server/workflow/* → runtime/engine/*`, `server/store/* → runtime/store/*`, `server/acp/* → runtime/acp/*` (incl. the interim `'../config.ts'`→`'../paths.ts'` rewrite of the relocated `runtime/acp/connection.ts:28`), `server/workflow/tool-intellisense.ts → runtime/tool-intellisense.ts`, NEW `runtime/paths.ts`, `server/config.ts`, `tsconfig.server.json`; **interim import-specifier rewrites ONLY** (substantive ownership stays with the named unit): `runtime/run-controller.ts` (→ WU-7), `runtime/index.ts` (→ WU-8), `runtime/resolve.ts` (→ WU-8), `server/factory.ts` (→ WU-9), `server/run-manager.ts` (→ WU-10)  ·  dependsOn: []
> **Ownership note (non-silent):** Moved files (engine/store/acp/tool-intellisense)
> are git-mv'd here and body-edited in their later unit — the plan's established
> move-then-edit pattern. The five *consumer* files above are NOT moved; WU-R only
> repoints their import specifiers (the pure path arithmetic enumerated below) and
> their substantive bodies are edited solely by the parenthesized unit. No file's
> SUBSTANTIVE ownership is dual-assigned; only the mechanical relocation/path-fix is
> WU-R's. Under the by-file fan-out, the WU-R agent performs all moves + interim
> specifier rewrites in one pass; later units edit bodies on top.
This is a MECHANICAL move sequenced FIRST so every later unit references the new
paths. No behavior change in this unit (parameterization happens in WU-1..WU-7).
- `git mv server/workflow runtime/engine`. Then `git mv runtime/engine/tool-intellisense.ts runtime/tool-intellisense.ts` (it is editor-support, not the run engine; §4). `server/workflow/` no longer exists.
- `git mv server/store runtime/store`.
- `git mv server/acp runtime/acp`.
- **Split `server/config.ts` → NEW `runtime/paths.ts`:** move `findPackageRoot`,
  `PACKAGE_ROOT`, `HOME`, `USER_TOOLS_DIR`, `USER_PROMPTS_DIR`, `AGENT_BINS`,
  `resolveAgentBin` into `runtime/paths.ts`. Leave `server/config.ts` containing ONLY
  `export const PORT` plus `export { PACKAGE_ROOT, resolveAgentBin } from '../runtime/paths.ts'`
  (so `factory.ts` keeps its import sites). The six eager cwd-derived consts
  (`WORKFLOWS_DIR`, `DEFAULT_CWD`, `PROJECT_TOOLS_DIR`, `CAPABILITY_DIRS`,
  `PROJECT_PROMPTS_DIR`, `PROMPT_DIRS`) are DELETED here (WU-1 adds the replacement
  helper to `runtime/paths.ts`).
- **Rewrite import specifiers** across the moved files (pure path arithmetic). This
  unit also performs the *interim* mechanical rewrites on the four consumer files
  (`runtime/run-controller.ts`, `runtime/index.ts`, `runtime/resolve.ts`,
  `server/factory.ts`, `server/run-manager.ts`) whose **substantive** ownership stays
  with their later editing units (WU-7/8/8/9/10 respectively) — WU-R only repoints
  their specifiers so the tree keeps resolving; the bodies change later. The rules:
  - **Engine-depth files (`runtime/engine/*`):** a former `'../store/x.ts'` stays
    `'../store/x.ts'` (both moved in parallel); `'../config.ts'` becomes
    `'../paths.ts'`; `'../acp/connection.ts'` stays `'../acp/connection.ts'`;
    `'../../shared/...'` stays `'../../shared/...'`.
  - **Store files (`runtime/store/{workflows,capabilities,prompts}.ts`) — parallel to
    the engine-depth rule, MUST be rewritten here:** each imports a now-DELETED eager
    const from `'../config.ts'` (verified: `server/store/workflows.ts:3` `WORKFLOWS_DIR`,
    `capabilities.ts:3` `CAPABILITY_DIRS`, `prompts.ts:3` `PROMPT_DIRS`). After
    `git mv server/store runtime/store`, a bare `'../config.ts'` would resolve to
    `runtime/config.ts`, which does NOT exist (config.ts STAYS thinned at
    `server/config.ts`) — a dangling MODULE edge that breaks typecheck. Therefore
    rewrite each store file's `from '../config.ts'` → `from '../paths.ts'` (the
    relocated `runtime/paths.ts` sits one level up from `runtime/store/`, the same depth
    the old `server/config.ts` sat from `server/store/`). The named symbols
    (`WORKFLOWS_DIR`/`CAPABILITY_DIRS`/`PROMPT_DIRS`) are NOT in `paths.ts` (they were
    deleted), so this leaves an interim dangling-NAMED-symbol that **WU-2** clears (it
    swaps these consts for the workspace-scoped dirs); the MODULE edge, however, is
    resolved HERE so no dangling module edge survives WU-R.
  - **acp-depth file (`runtime/acp/connection.ts`) — parallel to the engine-depth/
    store-files rule, MUST be rewritten here:** `server/acp/connection.ts:28` is
    `import { resolveAgentBin } from '../config.ts'` (verified in real code; the only
    non-`node:*`/non-`@agentclientprotocol`/non-`shared` import — `:27` is the type-only
    `'../../shared/agents.ts'`, which after `git mv server/acp runtime/acp` still resolves
    to the repo-root `shared/agents.ts` and is left untouched). After the move the file
    sits at `runtime/acp/connection.ts`, so a bare `'../config.ts'` would resolve to
    `runtime/config.ts`, which does NOT exist (config.ts STAYS thinned at
    `server/config.ts`) — a dangling MODULE edge that breaks typecheck. Therefore rewrite
    its line-28 `from '../config.ts'` → `from '../paths.ts'` (`runtime/acp/` is one level
    below the runtime root, the same depth `server/acp/` sat from `server/config.ts`, so
    the relocated `runtime/paths.ts` sits exactly one level up). `resolveAgentBin` SURVIVES
    in `paths.ts` (it is one of the consts moved there above), so this leaves **NO dangling
    named symbol AND NO dangling module edge**, and — because the target is `'../paths.ts'`,
    not `'../../server/config.ts'` — it introduces **NO `runtime/* → ../server/*` edge**
    (the §9.7 gate stays satisfiable). This is a BINDING rule, not an implementer choice:
    the only other path that compiles, `'../../server/config.ts'` (the thin re-export still
    exports `resolveAgentBin`), is FORBIDDEN because it violates the runtime→server boundary
    gate (§9.7).
  - **Relocated `runtime/tool-intellisense.ts` (lands at runtime/ ROOT, NOT under
    `engine/`) — SPECIAL-CASED, the engine-depth rules above do NOT apply:** after
    `git mv runtime/engine/tool-intellisense.ts runtime/tool-intellisense.ts`, rewrite
    its own line-4 config import `from '../config.ts'` (CAPABILITY_DIRS, PACKAGE_ROOT)
    to **`'./paths.ts'`** (runtime-root depth — `'./paths.ts'`, NOT `'../paths.ts'`,
    because the file now sits at `runtime/tool-intellisense.ts` beside `runtime/paths.ts`).
    Its body is rewritten by WU-5; this is only the interim path fix.
  - **`runtime/run-controller.ts` and `runtime/index.ts`:** rewrite
    `'../server/workflow/run.ts'` → `'./engine/run.ts'`,
    `'../server/workflow/capability-loader.ts'` → `'./engine/capability-loader.ts'`,
    `'../server/workflow/prompt-loader.ts'` → `'./engine/prompt-loader.ts'`.
    **Exception:** `run-controller.ts`'s `import { DEFAULT_CWD } from '../server/config.ts'`
    is NOT rewritten here — `DEFAULT_CWD` is deleted (no longer exists in `paths.ts`);
    WU-7 removes this import line and replaces the usage with `opts.workspace.root`.
    (WU-7 co-lands with WU-6; this PARTICULAR `run-controller.ts:17` dangle clears at
    WU-7. The runtime-subtree dangles clear once WU-2, WU-4, WU-5, AND WU-7 land, but the
    FULL tree — which also compiles `server/factory.ts` — goes green only after the
    larger set {WU-2, WU-4, WU-5, WU-7 (+WU-6), WU-9 (+WU-10)}; see the full enumeration
    and the first-green-checkpoint conclusion in the "Full inventory" subsection below.)
  - **`runtime/resolve.ts` (line 7) — MUST be rewritten here:** its
    `import { readWorkflow } from '../server/store/workflows.ts'` becomes
    **`'./store/workflows.ts'`** for the interim (the file is at `runtime/resolve.ts`
    and the store moved to `runtime/store/`). This import is then **removed entirely**
    by WU-8 when `resolveWorkflow` switches to `workspace.readWorkflow`. Omitting this
    rewrite would leave a `runtime/ → ../server/` dangling edge that both breaks
    typecheck and still matches the §9.7 gate.
  - **`server/factory.ts`/`server/run-manager.ts`:** rewrite `'./store/*'` imports to
    `'../runtime/store/*'` and `'./workflow/*'` imports to `'../runtime/engine/*'`,
    **with one exception:** `factory.ts:38`'s `'./workflow/tool-intellisense.ts'` is
    rewritten to **`'../runtime/tool-intellisense.ts'`** (NOT `'../runtime/engine/...'`,
    because tool-intellisense lands at runtime/ root, not under engine/). All these
    server-side imports are removed entirely in WU-9 (factory) / WU-10 (run-manager),
    but must compile in the interim.
- **`tsconfig.server.json`:** add `"runtime"` to `include` (was `["server","shared"]`),
  because `factory.ts` now imports runtime types. `tsconfig.lib.json` unchanged
  (already `["runtime","server","shared"]`).
- **Self-containment proof (verified):** `server/acp/connection.ts` external imports
  are only `node:*`, `@agentclientprotocol/sdk`, and `resolveAgentBin` (→ `runtime/paths.ts`
  via the acp-depth rewrite rule above — `'../config.ts'`→`'../paths.ts'`, the binding rule
  that clears this edge with no dangling symbol and no runtime→server edge);
  `server/workflow/run.ts` imports only `../store/*`, `../acp/connection.ts`,
  `../config.ts` (→ paths), `../executor.ts`, and `shared/*` — ALL of which move
  together or live in shared/runtime. `factory.ts`/`run-manager.ts` do NOT import
  `acp/` (verified).
- **Full inventory of `runtime/* → ../server/*` edges (verified by grep) and when
  each is cleared** — the §9.7 gate ("`grep -rn "from '\.\./server" runtime/` empty")
  is a **FINAL-STATE** assertion that holds only after WU-7 AND WU-8 land, NOT after
  WU-R alone (mirroring the "tree typechecks only after WU-7" note above):
  - `runtime/run-controller.ts:15,16` (`run.ts`, loaders) → rewritten to `./engine/*`
    **by WU-R**; `:17` `DEFAULT_CWD from '../server/config.ts'` → removed **by WU-7**.
  - `runtime/index.ts:14,15` (`run.ts`, loaders) → rewritten to `./engine/*` **by WU-R**.
  - `runtime/resolve.ts:7` `readWorkflow from '../server/store/workflows.ts'` →
    rewritten to `./store/workflows.ts` **by WU-R** (interim), then the import is
    **removed entirely by WU-8** (`resolveWorkflow` uses `workspace.readWorkflow`).
  (The store files' `'../config.ts'`→`'../paths.ts'` rewrite above — and, identically,
  the acp-depth `runtime/acp/connection.ts:28` `'../config.ts'`→`'../paths.ts'` rewrite —
  are NOT `runtime/* → ../server/*` edges: each is a bare `'../config.ts'`, invisible to
  the §9.7 grep — but each WOULD be a dangling MODULE edge after the move if left
  unrewritten; the store-files rule and the acp-depth rule resolve them, which is why the
  "NO dangling module edge" claim below holds. Note the asymmetry: `connection.ts` imports
  `resolveAgentBin`, which SURVIVES in `paths.ts`, so its rewrite leaves NO dangling named
  symbol either — unlike the store/inline/tool-intellisense rewrites whose named consts
  were deleted and are cleared later by WU-2/WU-4/WU-5.)
  After WU-R alone, `run-controller.ts:17`'s `'../server/config.ts'` still matches the
  §9.7 grep (it is cleared by WU-7); every other `../server/*` edge is already repointed
  inside `runtime/`. Therefore WU-R produces NO *dangling module edge* — `resolve.ts:7`
  now points at the real `runtime/store/workflows.ts`, the three `runtime/store/*.ts`
  files now point at the real `runtime/paths.ts` (store-files rule above),
  `runtime/acp/connection.ts:28` now points at the real `runtime/paths.ts` (acp-depth
  rule above, importing the surviving `resolveAgentBin`), and
  `run-controller.ts:17`'s `'../server/config.ts'` still resolves to the thin re-export
  `server/config.ts`. **What remains after WU-R is NOT a single dangling named symbol —
  it is a SET of interim dangling-NAMED-symbol imports, each cleared by a specific later
  unit** (the module edges all resolve; only these named bindings are absent from the
  importer's resolved target — `runtime/paths.ts` for the runtime-side
  deleted-cwd-const dangles, and the thinned `server/config.ts` re-export surface for the
  factory-side re-export-gap dangles — until their owning unit removes/replaces them):
  - `DEFAULT_CWD` — `runtime/run-controller.ts:17` (import line untouched by WU-R) →
    cleared by **WU-7** (removes the import; usage becomes `opts.workspace.root`).
  - `CAPABILITY_DIRS` (+ `PACKAGE_ROOT`, which survives) — `runtime/tool-intellisense.ts:4`
    (WU-R rewrote its config import to `'./paths.ts'` per the special-case; `PACKAGE_ROOT`
    exists there, `CAPABILITY_DIRS` does not) → cleared by **WU-5**.
  - `PROJECT_TOOLS_DIR` (+ `USER_TOOLS_DIR`, which survives) — `runtime/engine/inline.ts:6`
    (WU-R rewrote its config import to `'../paths.ts'` per the engine-depth rule;
    `USER_TOOLS_DIR` exists there, `PROJECT_TOOLS_DIR` does not) → cleared by **WU-4**.
  - `WORKFLOWS_DIR` / `CAPABILITY_DIRS` / `PROMPT_DIRS` — `runtime/store/workflows.ts` /
    `capabilities.ts` / `prompts.ts` respectively (WU-R rewrote their config import to
    `'../paths.ts'` per the store-files rule) → all cleared by **WU-2**.
  - `DEFAULT_CWD`, `PROJECT_PROMPTS_DIR`, `USER_PROMPTS_DIR`, `PROJECT_TOOLS_DIR`,
    `USER_TOOLS_DIR` — **`server/factory.ts:26-34`** (the eight-symbol
    `import { … } from './config.ts'`). WU-R does NOT rewrite this server-side config
    import (it only repoints factory's `./store/*`→`'../runtime/store/*'` and
    `./workflow/*`→`'../runtime/engine/*'` specifiers, and `./workflow/tool-intellisense.ts`
    →`'../runtime/tool-intellisense.ts'`). After WU-R thins `server/config.ts` to `PORT`
    + a re-export of `{ PACKAGE_ROOT, resolveAgentBin }`, exactly FIVE of the eight named
    imports dangle: `DEFAULT_CWD` / `PROJECT_PROMPTS_DIR` / `PROJECT_TOOLS_DIR` are
    **deleted-const dangles** (the cwd-derived consts removed in WU-R), while
    `USER_PROMPTS_DIR` / `USER_TOOLS_DIR` are **RE-EXPORT-GAP dangles, NOT deletions** —
    both SURVIVE in `runtime/paths.ts`, but the thinned `server/config.ts` no longer
    re-exports them, so factory's `from './config.ts'` import of them is unresolved until
    rewritten. (The other three of the eight — `PORT` / `PACKAGE_ROOT` / `resolveAgentBin`
    — still resolve.) The `./config.ts` MODULE edge stays intact (config.ts exists); only
    these five NAMED bindings are absent. All five are cleared by **WU-9** (which drops
    the `DEFAULT_CWD, PROJECT_PROMPTS_DIR, USER_PROMPTS_DIR, PROJECT_TOOLS_DIR,
    USER_TOOLS_DIR` imports as the routes move to `req.workspace`-scoped delegation; WU-9
    co-lands with WU-10).
  Consequently **the first green FULL-TREE typecheck checkpoint — `tsc -p
  tsconfig.server.json`, which includes `server/` and gains `"runtime"` per WU-R, so it
  compiles BOTH `runtime/*` AND `server/factory.ts` — is reached ONLY after
  {WU-2, WU-4, WU-5, WU-7 (+ co-pair WU-6), WU-9 (+ co-pair WU-10)} have all landed —
  NOT after WU-R alone, NOT at any per-wave checkpoint between WU-R and that set, and
  NOT after only {WU-2, WU-4, WU-5, WU-7}.** The runtime-side dangles enumerated above
  clear at WU-2 / WU-4 / WU-5 / WU-7, but because the full tree ALSO compiles
  `server/factory.ts`, its FIVE dangling `./config.ts` imports (the `factory.ts` bullet
  above) AND its two deleted-symbol banner references (`DEFAULT_CWD` and
  `agentsWithStatus()`, cf. WU-9's own "else two deleted symbols dangle and §9.1
  typecheck fails" note) keep the full tree RED until they are cleared — and they are
  cleared ONLY by **WU-9** (co-landing with WU-10). This is exactly consistent with
  WU-9's statement that the §9.1 full typecheck fails until WU-9 lands. No
  green-typecheck checkpoint is asserted in the interval between WU-R and
  {WU-2, WU-4, WU-5, WU-7 (+WU-6), WU-9 (+WU-10)}. The §9.7 "zero matches" gate is a
  SEPARATE FINAL-STATE assertion satisfied only once WU-7 (drops the config import) and
  WU-8 (drops the resolve store import) have landed.

### WU-1 — paths.ts: workspace-dir derivation  ·  files: `runtime/paths.ts`  ·  dependsOn: [WU-R]
- In `runtime/paths.ts` (post-WU-R), KEEP the relocated `PACKAGE_ROOT`, `findPackageRoot`,
  `AGENT_BINS`, `resolveAgentBin`, `HOME`, `USER_TOOLS_DIR`, `USER_PROMPTS_DIR`.
- ADD exported pure helper (no global reads):
  ```ts
  export interface DerivedDirs { root: string; tools: string; prompts: string; workflows: string; nodeModules: string }
  /** Derive a workspace's conventional subdirs. AGENTPRISM_*_DIR overrides are
   *  honored ONLY when useEnvOverrides is true (default workspace, back-compat). */
  export function deriveWorkspaceDirs(
    root: string,
    opts: { env?: NodeJS.ProcessEnv; useEnvOverrides?: boolean } = {},
  ): DerivedDirs {
    const env = opts.env ?? process.env
    const o = opts.useEnvOverrides === true
    return {
      root,
      tools:       o && env.AGENTPRISM_TOOLS_DIR     ? env.AGENTPRISM_TOOLS_DIR     : path.join(root, 'tools'),
      prompts:     o && env.AGENTPRISM_PROMPTS_DIR   ? env.AGENTPRISM_PROMPTS_DIR   : path.join(root, 'prompts'),
      workflows:   o && env.AGENTPRISM_WORKFLOWS_DIR ? env.AGENTPRISM_WORKFLOWS_DIR : path.join(root, 'workflows'),
      nodeModules: path.join(root, 'node_modules'),
    }
  }
  ```
  (`AGENTPRISM_DEFAULT_CWD` becomes irrelevant: the default cwd IS the workspace
  root; the bin may still resolve `--cwd`/positional to choose that root.)

### WU-2 — Stores parameterized  ·  files: `runtime/store/workflows.ts`, `runtime/store/capabilities.ts`, `runtime/store/prompts.ts` (post-WU-R)  ·  dependsOn: [WU-R]
- `workflows.ts`: drop the `WORKFLOWS_DIR` import; every fn takes `dir: string`:
  `ensureDir(dir)`, `listWorkflows(dir)`, `readWorkflow(dir, name)`,
  `writeWorkflow(dir, name, content)`, `deleteWorkflow(dir, name)`. Keep `safeName`.
- `capabilities.ts`: `scanCapabilityFiles(capabilityDirs: readonly { dir: string; tier: 'project'|'user' }[])`
  (was reading `CAPABILITY_DIRS`). `readCapabilityFile`/`writeCapabilityFile`
  already take `tierDir`; ADD a `tier: 'project'|'user'` param to
  `writeCapabilityFile(tierDir, fileName, content, tier)` and return that `tier`
  (fix the hardcoded `tier:'project'` at `:123`, B14).
- `prompts.ts`: `scanPromptFiles(promptDirs: readonly {...}[])`. ADD `tier` param to
  `writePrompt(tierDir, name, content, tier)` and return it (fix `:112`, B14).

### WU-3 — Loaders parameterized  ·  files: `runtime/engine/capability-loader.ts`, `runtime/engine/prompt-loader.ts`, `runtime/engine/derive-capability-dts.ts` (post-WU-R)  ·  dependsOn: [WU-R, WU-2]
- `derive-capability-dts.ts`: signature becomes
  `deriveCapabilityDts(files, opts: { workspaceRoot: string; packageRoot: string; userToolsParent: string }): Map<string,string>`.
  Apply §5.3 (anchor at `workspaceRoot`, overlay `<packageRoot>/shared/capability.ts`
  at BOTH `<workspaceRoot>/shared/capability.ts` AND
  `<userToolsParent>/shared/capability.ts` (B15, user-tier symmetry),
  `preserveSymlinks: true`, workspace-keyed cache). `userToolsParent` is
  `path.dirname(USER_TOOLS_DIR)` (= `~/.agentprism`), supplied by the loader.
  Also **export `evictCapabilityDtsCache(workspaceRoot: string): void`** (deletes the
  `workspaceRoot` key from the workspace-keyed `cache` Map, §5.3) — consumed by
  `WorkspaceRegistry.close` (WU-6) as the workspace's catalog-cache teardown.
- `capability-loader.ts`:
  ```ts
  export interface LoadCapabilitiesOptions {
    capabilityDirs: readonly { dir: string; tier: 'project'|'user' }[]
    workspaceRoot: string
    packageRoot: string
    env?: NodeJS.ProcessEnv
  }
  export async function loadCapabilities(o: LoadCapabilitiesOptions): Promise<LoadedCapabilities>
  ```
  Internally: `scanCapabilityFiles(o.capabilityDirs)`, then
  `deriveCapabilityDts(scanned.map(...), { workspaceRoot: o.workspaceRoot, packageRoot: o.packageRoot, userToolsParent: path.dirname(USER_TOOLS_DIR) })`
  (import `USER_TOOLS_DIR` from `../paths.ts`),
  `computeSecretStatus(..., o.env ?? process.env)`. `getCapabilityModules` unchanged.
- `prompt-loader.ts`: `loadPrompts(promptDirs: readonly {...}[]): Promise<LoadedPrompts>`
  (was zero-arg). `getPromptTemplates` unchanged.

### WU-4 — Inliner parameterized  ·  files: `runtime/engine/inline.ts` (post-WU-R)  ·  dependsOn: [WU-R]
- Drop the `PROJECT_TOOLS_DIR`/`USER_TOOLS_DIR` import and module-global `TOOLS_DIRS`.
- Extend `InlineOptions`:
  ```ts
  export interface InlineOptions {
    workflowPath?: string
    toolsDirs: readonly string[]   // workspace.capabilityDirs.map(d => d.dir)  [project, user]
    projectToolsDir: string        // workspace.dirs.tools (the unsaved-buffer base)
  }
  ```
- `isUnderToolsDir(file, toolsDirs)` and `inlineHelpers(source, opts)` use
  `opts.toolsDirs`; the unsaved-buffer fallback uses `opts.projectToolsDir` (was
  `PROJECT_TOOLS_DIR`, `:321`) and `path.dirname(opts.projectToolsDir)` (was `:325`).
- **`isUnderToolsDir` signature + body (LOCKED).** Change its signature from
  `isUnderToolsDir(file: string)` (`:112`) to
  `isUnderToolsDir(file: string, toolsDirs: readonly string[])` and iterate the
  `toolsDirs` PARAMETER where it currently iterates the deleted module-global
  `TOOLS_DIRS` (`for (const dir of TOOLS_DIRS)`, `:113` → `for (const dir of toolsDirs)`).
  Its `:113` loop is the ONLY consumer of `TOOLS_DIRS`; after this change `TOOLS_DIRS`
  has zero references and is removed (already mandated by the first bullet).
- **`buildHelperBody` must THREAD `toolsDirs` (LOCKED — it has no other access to it).**
  The recursive helper `buildHelperBody` (`:187-269`) calls `isUnderToolsDir(resolved)`
  at `:231` but has no `opts`/`toolsDirs` in scope. Change its signature from
  `buildHelperBody(file: string, seen: Set<string>)` (`:187`) to
  `buildHelperBody(file: string, seen: Set<string>, toolsDirs: readonly string[])`, then:
  - `:231` becomes `if (!resolved || !isUnderToolsDir(resolved, toolsDirs)) {` (threads
    the received `toolsDirs`).
  - the in-`buildHelperBody` RECURSIVE call at `:237`
    (`const nested = buildHelperBody(resolved, seen)`) becomes
    `buildHelperBody(resolved, seen, toolsDirs)` (threads the same param onward).
- **`inlineHelpers` declaration drops its `= {}` default (LOCKED).** Change the
  declaration at `:309` from
  `export function inlineHelpers(normalizedSource: string, opts: InlineOptions = {}): InlineResult {`
  to
  `export function inlineHelpers(normalizedSource: string, opts: InlineOptions): InlineResult {`
  (drop the `= {}` default). Once `toolsDirs`/`projectToolsDir` are REQUIRED on
  `InlineOptions`, `{}` is no longer assignable, so the default would be a hard
  TS2739 ('{}' is missing properties `toolsDirs`, `projectToolsDir`) under
  tsconfig.server.json `strict: true`, breaking the §9.1 full-tree typecheck. Safe:
  both call sites (`runtime/engine/run.ts:790`/`:943`, per WU-7) always pass a full
  `{ workflowPath?, toolsDirs, projectToolsDir }` opts object, so no caller relies on
  the default.
- **Both `inlineHelpers` call sites pass `opts.toolsDirs` (LOCKED).** Inside
  `inlineHelpers(normalizedSource, opts)`:
  - `:339` (`if (!resolved || !isUnderToolsDir(resolved)) continue`) becomes
    `if (!resolved || !isUnderToolsDir(resolved, opts.toolsDirs)) continue`.
  - `:342` (`const helper = buildHelperBody(resolved, seen)`) becomes
    `const helper = buildHelperBody(resolved, seen, opts.toolsDirs)` (the entry call that
    seeds the recursion's `toolsDirs` from `opts`).
  These are the ONLY two `isUnderToolsDir`/`buildHelperBody` call sites and the ONLY
  `TOOLS_DIRS` references in the file (verified: defn `:71`, sole use `:113`, calls
  `:231`/`:237`/`:339`/`:342`), and the `inlineHelpers` declaration carrying the
  `= {}` default is the ONLY `InlineOptions` default in the file (`:309`); after the
  above there is zero implementer choice and no dangling `TOOLS_DIRS`/`toolsDirs`
  symbol and no TS2739 from the now-required `InlineOptions` fields.

### WU-5 — Tool-intellisense rewritten (anchor-parameterized)  ·  files: `runtime/tool-intellisense.ts` (moved in WU-R)  ·  dependsOn: [WU-R]
- The file is already at `runtime/tool-intellisense.ts` after WU-R; this unit
  REWRITES its body per §4: `ToolIntellisenseAnchor`, probe at `a.nodeModulesRoot`,
  `preserveSymlinks: true`, virtual paths prefixed `file:///<a.workspaceId>/...`.
- Preserve the `/\.d\.[mc]?ts$/` match, `typescript/`+`@types/node/` skips, and
  `package.json` shipping. `nodeModulesVirtual` returns `file:///<wsId>/node_modules/...`.
- WU-9 removes the (now-dangling) `server/factory.ts` import of it.

### WU-6 — Workspace + Registry + id  ·  files: NEW `runtime/workspace.ts`, NEW `runtime/workspace-registry.ts`  ·  dependsOn: [WU-R, WU-1, WU-2, WU-3, WU-4, WU-5]  ·  **co-lands with WU-7 (atomic pair)**
> **Co-landing pair (LOCKED).** WU-6 and WU-7 are MUTUALLY dependent and land as ONE
> atomic unit: `createWorkspace` (WU-6) constructs `new RunController({ env, cwd,
> workspace })` and calls `controller.launch(...)`, a ctor shape DEFINED ONLY by WU-7;
> conversely WU-7's `run-controller.ts`/`run.ts` import the `Workspace` *type* from
> WU-6. Neither typechecks alone. They are implemented together and the WU-6/WU-7
> checkpoint typecheck passes ONLY after BOTH land (mirroring WU-R's "typechecks only
> after WU-7" note). The DAG keeps WU-7's `dependsOn` listing WU-6 (and WU-6's listing
> its prerequisites) to fix a single topological position for the pair; the "mutual"
> build dependency is satisfied by co-landing, not by a cyclic edge. Under the by-file
> fan-out, `runtime/workspace.ts` + `runtime/workspace-registry.ts` (WU-6) and
> `runtime/run-controller.ts` + `runtime/engine/run.ts` (WU-7) are implemented in the
> same wave and verified together.
> **One co-prerequisite from WU-8:** WU-6's module-scope `prepareRun` helper calls
> `resolveWorkflow(wf, ws)` (the 2-arg, workspace-scoped form CREATED by WU-8's
> `runtime/resolve.ts` edit), and `resolve.ts` in turn imports the `Workspace` *type*
> from WU-6 — a third mutual reference. So WU-8's `resolve.ts` signature change is the
> ONE WU-8 edit that co-lands with this wave; the remainder of WU-8 (`index.ts`,
> `runtime/agents.ts`) still lands afterward per its `dependsOn: [WU-6, WU-7]`. Net:
> the wave that makes the WU-6/WU-7 checkpoint typecheck is `{workspace.ts,
> workspace-registry.ts, run-controller.ts, run.ts, resolve.ts}` landing together;
> `resolve.ts` is OWNED by WU-8 (its body/signature spec lives there) and is only
> *sequenced* into this wave.
- `runtime/workspace.ts`: `computeWorkspaceId`, `canonicalizeRoot` (§1.1; NO
  `base32`), `ensureCapabilityShim` (§5.4), and a
  `createWorkspace(root, opts): Workspace` factory implementing §1's interface.
  Imports `PACKAGE_ROOT`, `deriveWorkspaceDirs`, `USER_TOOLS_DIR`, `USER_PROMPTS_DIR`
  from `./paths.ts`; loaders from `./engine/*`; stores from `./store/*`
  (the named store fns the construction block calls: `listWorkflows`, `readWorkflow`,
  `writeWorkflow`, `deleteWorkflow`, `readCapabilityFile`, `writeCapabilityFile`,
  `readPrompt`, `writePrompt` — note the PROMPT-READ store fn is `readPrompt`, NOT
  `readPromptFile`; the `readPromptFile` identifier is a Workspace METHOD name only);
  intellisense (`listToolSourceLibs`, `resolvePackageTypeLibs`) from
  `./tool-intellisense.ts`; **`RunController` (a VALUE import) from `./run-controller.ts`**
  (the construction block at step 2 does `new RunController(...)`) **and the TYPE
  `Prepared` from `./run-controller.ts`** (`import type { Prepared } from
  './run-controller.ts'`) — required by the module-scope `prepareRun` helper's
  `Promise<Prepared>` return type below; `Prepared` is a type export of
  `./run-controller.ts` (per `runtime/index.ts:9`); `prepareRun`'s
  helpers (`resolveWorkflow` from `./resolve.ts`, `validateWorkflow`/`validateInputs`
  from `../shared/*`) — all WORKSPACE-LOCAL imports (no `../server/`). `workspace-registry.ts`
  additionally imports `evictCapabilityDtsCache` from `./engine/derive-capability-dts.ts`
  for `close()`.
  - **`createWorkspace` materializes BOTH capability-API shims synchronously before
    returning** (§5.4): `ensureCapabilityShim(dirs.root)` for the project tier AND
    `ensureUserCapabilityShim()` for the user tier (`~/.agentprism/shared/capability.ts`,
    written only when `USER_TOOLS_DIR` holds capabilities), so every tier's on-disk
    `../shared/capability.ts` resolves before any `await import()` of a tool. Both are
    idempotent and guarded; `ensureUserCapabilityShim` is safe to call once per
    workspace open (no-op after the first).
  - The remaining field/method wiring (`dirs`, `capabilityDirs`/`promptDirs`,
    `toolDir/promptDir`, the workflow store delegation, `loadCapabilities`/`loadPrompts`/
    `catalogs`, the four single-file IO methods, `toolSources`/`resolveToolTypes`) is
    specified concretely in the LOCKED construction block below — read it as the
    authoritative source; the bullets are summary only.
  - **Construction sequence (LOCKED — resolves the `this`/mutual-reference order,
    B17).** `createWorkspace` is a factory (no `this` binding) and the `Workspace`
    ↔ `RunController` ↔ `WorkspaceRuntime` references are mutual, so the object is
    built in exactly this order and `this` NEVER appears in the factory body — a
    named local `ws` is used everywhere the interface prose said `this`:
    ```ts
    export function createWorkspace(root: string, opts: WorkspaceOpenOptions = {}): Workspace {
      const id = computeWorkspaceId(root)
      const env = opts.env ?? process.env
      const dirs = deriveWorkspaceDirs(root, { env, useEnvOverrides: opts.useEnvDirOverrides === true })
      ensureCapabilityShim(dirs.root)                 // §5.4 (project tier)
      ensureUserCapabilityShim()                      // §5.4 (user tier, idempotent across workspaces)
      const capabilityDirs = [{ dir: dirs.tools, tier: 'project' as const }, { dir: USER_TOOLS_DIR, tier: 'user' as const }]
      const promptDirs     = [{ dir: dirs.prompts, tier: 'project' as const }, { dir: USER_PROMPTS_DIR, tier: 'user' as const }]

      // 1. Allocate the Workspace object FIRST, with `runtime` left unassigned.
      //    `runtime` is a plain mutable field on the §1 `Workspace` interface
      //    (NOT `readonly` — §1 declares it non-readonly precisely so this builder
      //    can assign it once in step 4). Because `ws` is typed `Workspace` (via the
      //    `satisfies Workspace as Workspace` below) and `Workspace.runtime` is NOT
      //    readonly, the step-4 `ws.runtime = runtime` compiles cleanly (no TS2540).
      const ws = {
        id, name: path.basename(dirs.root) || 'workspace', root: dirs.root, dirs, env,
        capabilityDirs, promptDirs,
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
        runtime: undefined as unknown as WorkspaceRuntime,   // assigned in step 4
      } satisfies Workspace as Workspace

      // 2. Construct the RunController with the ALREADY-ALLOCATED `ws` reference
      //    (WU-7 ctor `{ env, cwd, workspace }`). `ws` exists; only `ws.runtime`
      //    is still a placeholder, and the controller does not read it at construct.
      const controller = new RunController({ env, cwd: dirs.root, workspace: ws })

      // 3. Build the WorkspaceRuntime over that controller (run/get/list — §1).
      //    `agent` is hoisted out of `options` HERE (mirroring index.ts:46) and
      //    threaded into prepareRun so `validateWorkflow(source, agent)` keeps the
      //    exact parity with index.ts:53 — see the LOCKED prepareRun signature below.
      const runtime: WorkspaceRuntime = {
        run: (wf, input, options) =>
          controller.launch(() => prepareRun(wf, ws, input, options?.agent ?? 'claude'), options),
        get: (runId) => controller.get(runId),
        list: () => controller.list(),
      }

      // 4. Assign once. No reader observed `ws.runtime` before this point: the
      //    controller (step 2) never dereferences it at construct time, and no run
      //    can start until the caller (registry) returns `ws` to the API surface.
      ws.runtime = runtime
      return ws
    }
    ```
    **`prepareRun` LOCKED signature (resolves the missing-`agent` param, B-shortcut).**
    The closure at `index.ts:45-58` captures `agent = runOptions.agent ?? 'claude'` and
    passes it to `validateWorkflow(source, agent)` (`index.ts:53`; `agent` =
    `selectedAgentId`, `shared/validate.ts:283`). A 3-arg `prepareRun(wf, ws, input)`
    could NOT see `agent` (it lives in `options`, not the closure's params), so the
    signature carries `agent` explicitly as a 4th parameter:
    ```ts
    // runtime/workspace.ts (module-scope helper used by createWorkspace)
    import type { AcpAgentId } from '../shared/agents.ts'
    async function prepareRun(
      wf: WorkflowRef,
      ws: Workspace,
      input: Record<string, unknown> | undefined,
      agent: AcpAgentId,                 // = options.agent ?? 'claude' (hoisted at the call site)
    ): Promise<Prepared> {
      const source = await resolveWorkflow(wf, ws)            // WU-8: ws-scoped read
      const validation = validateWorkflow(source, agent)     // parity with index.ts:53
      const result = validateInputs(validation.meta?.inputs, input)
      if (!result.ok) return { ok: false, errors: result.errors }
      return { ok: true, source, args: result.value }
    }
    ```
    This wraps the SAME `prepare` body as `runtime/index.ts:45-58` (byte-for-byte
    except `resolveWorkflow(wf, ws)` per WU-8) and preserves `validateWorkflow(source,
    agent)` parity. The call site (step 3 above) supplies `options?.agent ?? 'claude'`,
    so a run's selected agent reaches `validateWorkflow` exactly as today — no behavior
    delta, no `agent: undefined` fallback. The lone correctness obligation —
    "`RunController` must not touch `workspace.runtime`
    during construction" — is satisfied: WU-7's ctor stores `opts.workspace` and
    reads only `opts.workspace.root`/`.id`/loaders, never `.runtime`. (`ws.runtime`
    is read only inside `run()`, which cannot fire before step 4 completes and the
    registry hands `ws` back.)
- `runtime/workspace-registry.ts`: `createWorkspaceRegistry(opts: { env?: NodeJS.ProcessEnv }): WorkspaceRegistry`.
  - Backing state: a `Map<string, Workspace>` (preserves **insertion order**, used
    for default reassignment) + a `defaultId: string` (`''` until the first open).
  - `open(root, o?)`: `const id = computeWorkspaceId(root)`; idempotent (`has(id)` →
    return existing). First-ever open sets `defaultId = id`. `useEnvDirOverrides`
    defaults to `(id === defaultId)`; `open` may force it via `o.useEnvDirOverrides`.
  - `close(id)` (LOCKED per §1.2): `getOrThrow(id)` first (throws if unknown). If
    `map.size === 1` throw `Error('Cannot close the last open workspace')`. Cancel
    each in-flight run via the workspace's `RunController.list()` `cancel()`; then
    `evictCapabilityDtsCache(ws.dirs.root)` (imported from `./engine/derive-capability-dts.ts`
    — the only per-workspace catalog cache, §5.3). If `id === defaultId`, set
    `defaultId = [...map.keys()].find((k) => k !== id)!` (next entry in insertion
    order — guaranteed to exist because size > 1). THEN `map.delete(id)`. (Cannot
    evict ESM modules — §2.3.)
  - `default()`: `if (!defaultId || !map.has(defaultId)) throw new Error('No workspaces open'); return map.get(defaultId)!`.
    `defaultId()`: `if (!defaultId) throw new Error('No workspaces open'); return defaultId`.
  - `list()`/`getOrThrow` per §1 (`getOrThrow` throws `Error('Unknown workspace: <id>')`).

### WU-7 — RunController + WorkflowRun take a Workspace  ·  files: `runtime/run-controller.ts`, `runtime/engine/run.ts` (post-WU-R)  ·  dependsOn: [WU-R, WU-6, WU-3, WU-4]  ·  **co-lands with WU-6 (atomic pair — see WU-6)**
- `run-controller.ts`: drop the `DEFAULT_CWD` import (it no longer exists; the
  former `'../server/config.ts'` import was removed in WU-R). Constructor:
  `constructor(opts: { env?: NodeJS.ProcessEnv; cwd?: string; workspace: Workspace })`.
  `this.defaultCwd = opts.cwd ?? opts.workspace.root`; store `this.workspace`.
  In `boot()` construct `new WorkflowRun(request, callbacks, { env: this.env, workspace: this.workspace })`.
  `RunRequest` built in `boot()` (`:240`) adds `workspaceId: this.workspace.id`.
- `run.ts`: constructor `opts: { env?; workspace: Workspace }`; store `this.workspace`.
  - `start()`: replace `loadCapabilities(this.env)` (`:866`) with
    `this.workspace.loadCapabilities(this.env)`, and `loadPrompts()` (`:877`) with
    `this.workspace.loadPrompts()`.
  - **Drop the now-unused named imports (mirrors WU-9's `AcpAgentSpec` removal; REQUIRED
    or the §9.1 typecheck fails).** `:866`/`:877` are the ONLY usages of the named values
    `loadCapabilities`/`loadPrompts` in `run.ts` (verified). After the `this.workspace.*`
    rewrite both become unused, and since the relocated `runtime/engine/run.ts` is
    typechecked under `tsconfig.server.json` (WU-R adds `"runtime"` to its `include`) with
    `noUnusedLocals: true` (tsconfig.server.json:17), leaving them imported emits 2× TS6133.
    Therefore: in `runtime/engine/run.ts` line 33 drop `loadCapabilities`, keeping
    `import { getCapabilityModules, type LoadedCapabilities } from './capability-loader.ts'`
    (`getCapabilityModules` is still used at `:897`, `LoadedCapabilities` is a used type);
    and line 34 drop `loadPrompts`, keeping
    `import { getPromptTemplates, type LoadedPrompts } from './prompt-loader.ts'`
    (`getPromptTemplates` still used at `:902`, `LoadedPrompts` a used type).
  - Both `inlineHelpers(...)` calls (`:790`, `:943`) pass
    `{ workflowPath?, toolsDirs: this.workspace.capabilityDirs.map(d => d.dir), projectToolsDir: this.workspace.dirs.tools }`.
  - `this.cwd` stays `request.cwd` (per-run cwd unchanged; defaults to workspace root
    via the controller).

### WU-8 — createRuntime + resolve + agents  ·  files: `runtime/index.ts`, `runtime/resolve.ts`, NEW `runtime/agents.ts`  ·  dependsOn: [WU-6, WU-7]
- `resolve.ts`: `resolveWorkflow(ref: WorkflowRef, workspace: Workspace): Promise<string>`
  — `'source' in ref ? ref.source : workspace.readWorkflow(ref.name)` (was the global
  store read, B8).
- Create **`runtime/agents.ts`** per §4.1 (`isAgentInstalled`, `listAgents`),
  importing `PACKAGE_ROOT`/`resolveAgentBin` from `./paths.ts` and `ACP_AGENT_LIST`
  from `../shared/agents.ts`. (Pure relocation of factory.ts:67-77; no behavior
  change.)
- `index.ts`: `createRuntime(options)` builds `createWorkspaceRegistry({ env })`,
  opens each `options.workspaces` (first = default; back-compat: none →
  `open(cwd ?? process.cwd(), { useEnvDirOverrides: true })`). Returns the `Runtime`
  (§2.5): `workspaces` = the registry; `run/get/list/catalogs` delegate to
  `workspaces.default()` (run/catalogs) or fan across `workspaces.list()` (get/list);
  `listAgents()` re-exports `runtime/agents.ts`'s `listAgents`.
  Export `WorkspaceInfo`, `Workspace`, `WorkspaceRegistry`, `WorkspaceRuntime`,
  `computeWorkspaceId` types. `runWorkflow` convenience opens a one-shot workspace at
  `options.cwd ?? process.cwd()`.

### WU-9 — Server factory: workspace-scoped routes  ·  files: `server/factory.ts`  ·  dependsOn: [WU-0, WU-6, WU-8, WU-10]  ·  **co-lands with WU-10 (atomic pair)**
> **Co-landing pair (LOCKED).** WU-9 and WU-10 are MUTUALLY build-coupled across the
> `RunManager` constructor handshake and land as ONE atomic unit, exactly like the
> WU-6/WU-7 pair. WU-9 changes the call site to `new RunManager(runtime.workspaces)`
> (passing a `WorkspaceRegistry`), while WU-10 is what changes the ctor to
> `constructor(private registry: WorkspaceRegistry)` and rewrites the internals to
> `this.registry.get(...)` + `ws.runtime.run(...)`. Current code is `new
> RunManager(runtime)` (factory.ts:265) against `constructor(private runtime: Runtime)`
> (run-manager.ts:39). EITHER landing order breaks `tsc`: WU-9 alone passes a
> `WorkspaceRegistry` into a `Runtime` param; WU-10 alone leaves factory's old `new
> RunManager(runtime)` passing a `Runtime` into a `WorkspaceRegistry` param. Therefore
> the §9.1 full-typecheck checkpoint between their waves PASSES ONLY AFTER BOTH LAND.
> Under by-file fan-out, `server/factory.ts` (WU-9) and `server/run-manager.ts` (WU-10)
> are implemented together in a single wave. WU-9's `dependsOn` lists WU-10 to pin the
> pair into one topological position (the reverse edge is the co-landing annotation, not
> a `dependsOn` cycle — mirroring WU-7→WU-6).
- Change signature to `createServer(runtime: Runtime, opts?)` (unchanged param name;
  `runtime.workspaces` is the registry). Remove imports of
  `DEFAULT_CWD, PROJECT_PROMPTS_DIR, USER_PROMPTS_DIR, PROJECT_TOOLS_DIR, USER_TOOLS_DIR`
  and of `listToolSourceLibs/resolvePackageTypeLibs` and the stores'/loaders' direct
  imports that resolve dirs. **Also drop the agent-probe-only imports `resolveAgentBin`,
  `ACP_AGENT_LIST`, and the now-unused `import type { AcpAgentSpec } from
  '../shared/agents.ts'`** (the probe moved to `runtime/agents.ts`, §4.1).
  `AcpAgentSpec` was used ONLY by the deleted `agentsWithStatus()` (factory.ts:76);
  leaving it imported trips `noUnusedLocals` (tsconfig.server.json:17 → TS6133), so it
  MUST be removed. `AgentsResponse` STAYS imported — it still types the rewritten
  `GET /api/agents` response. **KEEP the
  `fs` and `path` imports** — they are still required by the PACKAGE_ROOT static-dist
  serve (`fs.existsSync(distDir)`, `path.join(PACKAGE_ROOT,'dist')`,
  `path.join(distDir,'index.html')` at `factory.ts:250-255`, UNCHANGED) and the new
  `POST /api/workspaces` route (`path.resolve(root)`). Keep `PACKAGE_ROOT`
  (dist static-serve join only) and `PORT`.
- **Registry routes (unprefixed):**
  - `GET /api/workspaces` → `{ workspaces: registry.list(), defaultWorkspaceId: registry.defaultId() }`.
  - `POST /api/workspaces` body `{ root }` → `registry.open(path.resolve(root))` → 200 `WorkspaceInfo`.
  - `DELETE /api/workspaces/:workspaceId` → `await registry.close(id)` → `{ ok: true }`.
    Map `close`'s defined errors (§1.2) to status codes: `Cannot close the last open
    workspace` → **409**; `Unknown workspace: <id>` → **404**; otherwise 500. The
    response body is `{ error: <message> }` on the non-200 paths.
- **Workspace middleware (LOCKED: one `express.Router()` mounted at
  `/api/workspaces/:workspaceId`, `mergeParams: true`, with a single resolver
  middleware; NO `app.param`).** Typed via a module augmentation so `req.workspace`
  needs no `as any`:
  ```ts
  // server/factory.ts (top-level, once)
  import type { Workspace } from '../runtime/workspace.ts'
  declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express { interface Request { workspace: Workspace } }
  }

  // inside createServer(runtime), after the unprefixed registry routes:
  const wsRouter = express.Router({ mergeParams: true })
  wsRouter.use((req, res, next) => {
    const ws = runtime.workspaces.get(req.params.workspaceId)
    if (!ws) return res.status(404).json({ error: 'Unknown workspace' })
    req.workspace = ws
    next()
  })
  // ...attach all resource routes below to wsRouter (paths are now relative)...
  app.use('/api/workspaces/:workspaceId', wsRouter)
  ```
  (`mergeParams: true` is required so `req.params.workspaceId` is visible inside the
  mounted router.) The 404 here is the single source of the "Unknown workspace"
  response; `registry.getOrThrow` is used only off the HTTP path.
- **Attach every resource route to `wsRouter`** (relative paths), delegating to `req.workspace`:
  - `GET    /api/workspaces/:workspaceId/workflows` → `ws.listWorkflows()`
  - `GET    /api/workspaces/:workspaceId/workflows/:name` → `ws.readWorkflow(name)`
  - `PUT    /api/workspaces/:workspaceId/workflows/:name` → `ws.writeWorkflow(name, content)`
  - `DELETE /api/workspaces/:workspaceId/workflows/:name` → `ws.deleteWorkflow(name)`
  - `GET    /api/workspaces/:workspaceId/capabilities` → `(await ws.loadCapabilities(env)).entries`
  - `GET    /api/workspaces/:workspaceId/prompts` → `(await ws.loadPrompts()).entries`
  - `GET/PUT /api/workspaces/:workspaceId/prompts/:tier/:name` → `ws.readPromptFile/writePromptFile(tier, name[, content])`
  - `GET/PUT /api/workspaces/:workspaceId/tools/:tier/:name` → `ws.readToolFile/writeToolFile(tier, name[, content])`
  - `POST   /api/workspaces/:workspaceId/validate` → `ws.catalogs()` then `validateWorkflow(source, undefined, undefined, caps, prompts)`
  - `GET    /api/workspaces/:workspaceId/tool-sources` → `ws.toolSources()`
  - `POST   /api/workspaces/:workspaceId/tool-types` → `ws.resolveToolTypes(specifiers)`
- **Delete `isInstalled` + `agentsWithStatus` (factory.ts:67-77) and their
  `fs`/`path`/`PACKAGE_ROOT` agent-probe imports (B16, §4.1).** `GET /api/agents`
  stays unprefixed and becomes
  `{ agents: runtime.listAgents(), defaultCwd: runtime.workspaces.default().root }`
  — it PROJECTS the runtime, composing no candidate path and calling no
  `fs.existsSync`. `PACKAGE_ROOT` stays imported ONLY for the `distDir` static-serve
  join below.
- `GET /api/health`, static `dist` serving: UNCHANGED (PACKAGE_ROOT, dist only).
- WS `hello`: `{ t:'hello', agents: runtime.listAgents(), workspaces: registry.list(), defaultWorkspaceId: registry.defaultId() }`.
- **`listen()` startup banner rewrite (factory.ts:295-297) — REQUIRED, else two
  deleted symbols dangle and §9.1 typecheck fails.** Both `DEFAULT_CWD` (removed in
  WU-R) and `agentsWithStatus()` (deleted above) are referenced by the banner; replace
  them with runtime projections (consistent with §4.1):
  - line 295 `Default work dir: ${DEFAULT_CWD}` → `Default work dir: ${runtime.workspaces.default().root}`.
  - line 297 `agentsWithStatus().filter((a) => a.installed)...` →
    `runtime.listAgents().filter((a) => a.installed).map((a) => a.id).join(', ') || 'none (will use npx)'`.
  After this edit no banner line references a deleted symbol.
- Construct `new RunManager(runtime.workspaces)` (WU-10).

### WU-10 — Run manager routes by workspaceId  ·  files: `server/run-manager.ts`  ·  dependsOn: [WU-0, WU-8]  ·  **co-lands with WU-9 (atomic pair — see WU-9)**
- `constructor(private registry: WorkspaceRegistry)`.
- `RunEntry` gains `workspaceId: string`.
- `start(message)`: `const ws = this.registry.get(message.workspaceId); if (!ws) { send error; return }`.
  Drive `ws.runtime.run({ source: request.source }, request.args, { ...same options... })`.
  Store `workspaceId` on the entry. All broadcasts add `workspaceId` to the
  ServerMessage (per WU-0). The map stays keyed by client `runId`; subscribe/cancel/
  etc look up by `runId` (entry already bound to its workspace) — `message.workspaceId`
  is validated against `entry.workspaceId` for `subscribe` (mismatch → error).
- `handle()` switch: unchanged shape; pass `message.workspaceId` where needed.

### WU-11 — Bin + composition root  ·  files: `bin/agentprism-ide.mjs`, `server/index.ts`  ·  dependsOn: [WU-8, WU-9]
- `bin`: DELETE `process.chdir` (line 62). Compute
  `const root = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd()`.
  Collect repeatable `--workspace <path>` into `extraRoots` (parseArgs already handles
  repeated flags only as last-wins; extend parseArgs to push `--workspace` values into
  an array). `createRuntime({ workspaces: [root, ...extraRoots] })`. `createServer(runtime)`.
  PACKAGE_ROOT discovery + built-vs-source selection UNCHANGED.
- `server/index.ts`: `createRuntime()` (no opts → default workspace at cwd, back-compat),
  `createServer(runtime)`, `listen(PORT)`.

### WU-12 — Frontend API + WS thread workspaceId  ·  files: `src/lib/api.ts`, `src/lib/ws.ts`  ·  dependsOn: [WU-0]
- `api.ts`: add `fetchWorkspaces(): Promise<WorkspacesResponse>` (`/api/workspaces`),
  `openWorkspace(root): Promise<WorkspaceInfo>` (POST), `closeWorkspace(id)` (DELETE).
  Every existing resource fn gains a leading `workspaceId: string` and builds
  `/api/workspaces/${encodeURIComponent(workspaceId)}/...`: `fetchCapabilities(ws)`,
  `fetchPrompts(ws)`, `fetchPromptFile(ws,tier,name)`, `savePromptFile(ws,...)`,
  `fetchToolFile(ws,...)`, `saveToolFile(ws,...)`, `fetchToolSources(ws)`,
  `fetchToolTypes(ws, specs)`, `fetchFiles(ws)`, `fetchFile(ws,name)`,
  `saveFile(ws,...)`, `deleteFile(ws,name)`. `fetchAgents()` stays unprefixed.
- `ws.ts`: `WsClient.send` signature unchanged (`ClientMessage` already carries
  `workspaceId` per WU-0); the caller includes it. URL stays `/ws`.

### WU-13 — Store: workspace state + per-workspace runs + catalogs + editor buffer + file list (single source of truth)  ·  files: `src/store/useStore.ts`  ·  dependsOn: [WU-12]
**Decision (resolves the context-vs-store ambiguity): the zustand `useStore` is the
SINGLE source of truth for `activeWorkspaceId`, the workspace list, per-workspace
runs, and per-workspace catalogs. There is NO separate React `WorkspaceContext`/
provider** (it would duplicate state the store already owns: the `WsClient`,
catalogs, and run snapshots all live here — `useStore.ts:94,325,331-347`). The
picker (WU-13b) reads/writes the store directly via `useStore(...)`. This also
dissolves the "where to mount the provider" question — nothing to mount.

(a) **Workspace fields + actions.** Add to `State`:
```ts
workspaces: WorkspaceInfo[]
activeWorkspaceId: string                 // '' until init resolves
defaultWorkspaceId: string                // from hello / fetchWorkspaces; reselect target on close
setActiveWorkspace: (id: string) => Promise<void>
refreshWorkspaces: () => Promise<void>
openWorkspace: (root: string) => Promise<string>   // RETURNS the new workspace id (B-shortcut)
closeWorkspace: (id: string) => Promise<void>
```
Import `WorkspaceInfo` from `@shared/protocol`.

**`openWorkspace(root)` (LOCKED, resolves the missing-`newId` contract).** The
frontend CANNOT compute the id itself (`computeWorkspaceId` is a runtime-layer
function the browser never imports; the brief forbids frontend resolution). The id
comes from the server: the WU-12 api `openWorkspace(root): Promise<WorkspaceInfo>`
returns the freshly-opened `WorkspaceInfo`, and the store action **returns its
`.id`**:
```ts
openWorkspace: async (root) => {
  const info = await api.openWorkspace(root)         // WU-12: POST /api/workspaces -> WorkspaceInfo
  // Add-or-replace by id, INLINED (no helper) so no undefined symbol remains and the
  // implementer makes ZERO decisions: if a WorkspaceInfo with this id is already in the
  // list (the registry's open() is idempotent by id, §1/§WU-6, so a re-open returns the
  // same id, possibly with refreshed fields), replace that entry with the freshly-fetched
  // `info`; otherwise append it. Pure, order-preserving, idempotent.
  set((s) => ({
    workspaces: s.workspaces.some((w) => w.id === info.id)
      ? s.workspaces.map((w) => (w.id === info.id ? info : w))
      : [...s.workspaces, info],
  }))
  return info.id                                     // <-- the id WU-13b needs
},
```
`openWorkspace` does NOT itself switch the active workspace — the caller decides
(WU-13b switches; a future "open without focus" caller may not). The picker's
"Open folder…" therefore does `const id = await openWorkspace(root); await
setActiveWorkspace(id)` (WU-13b).

**`closeWorkspace(id)` (LOCKED, the frontend teardown half — symmetric with §1.2).**
```ts
closeWorkspace: async (id) => {
  const s = get()
  // 0. LAST-WORKSPACE GUARD (mirrors the server 409, §1.2 rule 1). If this is the only
  //    open workspace, the close cannot proceed: surface the error and return WITHOUT
  //    mutating any state or calling the API. This is what actually produces the
  //    "close simply did not happen" outcome, and it makes the `find(...)!.id`
  //    non-null assertion in step 1 provably safe (step 1 runs only when length > 1,
  //    so a workspace other than `id` always exists).
  if (s.workspaces.length <= 1) {
    set({ lastError: 'Cannot close the last open workspace' })  // existing store field (useStore.ts:235), surfaced by the picker (WU-13b)
    return
  }
  // 1. If closing the ACTIVE ws, switch away FIRST (so the mirror never points at a
  //    deleted slot). Target: defaultWorkspaceId if it is still open and != id, else
  //    any other open ws id. (Guaranteed to exist: step 0 proved length > 1.)
  if (id === s.activeWorkspaceId) {
    const target = (s.defaultWorkspaceId && s.defaultWorkspaceId !== id)
      ? s.defaultWorkspaceId
      : s.workspaces.find((w) => w.id !== id)!.id
    await get().setActiveWorkspace(target)           // repoints ALL mirrors (WU-13e)
  }
  // 2. Server close. Step 0 already excluded the local last-workspace case, so a 409
  //    here can only arise from a stale-state race (another client closed a workspace
  //    concurrently, making this the server's last). `api.closeWorkspace` rejects on a
  //    non-2xx; the throw propagates to the caller, which surfaces it — step 3 below
  //    never runs, so NO state is mutated on that path.
  await api.closeWorkspace(id)
  // 3. Drop the closed ws's per-workspace slots + list entry, and (if it WAS the
  //    default) recompute defaultWorkspaceId to the new server default.
  set((s2) => {
    const { [id]: _r, ...runByWs }     = s2.runByWs
    const { [id]: _c, ...catalogByWs } = s2.catalogByWs
    const { [id]: _e, ...editorByWs }  = s2.editorByWs
    const { [id]: _f, ...filesByWs }   = s2.filesByWs
    const { [id]: _a, ...workspaceAttention } = s2.workspaceAttention   // FIFTH per-ws map (c4) — prune so a closed ws never leaves a dangling needs-input entry
    const workspaces = s2.workspaces.filter((w) => w.id !== id)
    const defaultWorkspaceId = s2.defaultWorkspaceId === id
      ? (workspaces[0]?.id ?? '')
      : s2.defaultWorkspaceId
    return { runByWs, catalogByWs, editorByWs, filesByWs, workspaceAttention, workspaces, defaultWorkspaceId }
  })
},
```
Step 1 runs BEFORE the server call, so the active mirror is already repointed to a
surviving workspace before the slot is deleted; step 3 deletes the
`runByWs/catalogByWs/editorByWs/filesByWs/workspaceAttention` slots (all FIVE
per-workspace maps) so no stale per-workspace state leaks — in particular a closed
workspace can never leave a dangling `workspaceAttention[id] = { status:
'needs-input' }` entry that would otherwise permanently light the global needs-input
indicator (WU-13b) and let a click `setActiveWorkspace(closedId)` re-seed an empty
editor slot + `fetchCatalogsFor(closedId)` against the now-closed server workspace. The last-workspace case is handled deterministically by the step-0 guard:
`closeWorkspace` returns early, mutating nothing and never calling the API, and
surfaces `'Cannot close the last open workspace'` — exactly matching the server 409
(§1.2 rule 1). The only way to reach the server call on a would-be-last workspace is a
stale-state race (a concurrent close elsewhere); on that path step 2's awaited
`api.closeWorkspace` rejects (409) and throws BEFORE step 3, so the list is unchanged
and the previously-active workspace (or the step-1 switch target, if step 1 ran) stays
active — the close simply did not happen, with no state mutated. `refreshWorkspaces`
re-fetches the canonical list + `defaultWorkspaceId` from `GET /api/workspaces` to
reconcile the stale local view. There is exactly ONE account of the last-workspace
path: the step-0 guard.

(b) **Per-workspace catalogs (replace the single-valued fields).** Today
`capabilities/capabilityCatalog/prompts/promptCatalog` are single values fetched
once at connect (`useStore.ts:288-294,331-347`). Replace with workspace-keyed
storage and a derived "active" view:
```ts
// keyed by workspaceId
catalogByWs: Record<string, {
  capabilities: CapabilityCatalogEntry[]; capabilityCatalog: CapabilityCatalog
  prompts: PromptCatalogEntry[];          promptCatalog: PromptCatalog
}>
```
Keep the existing top-level `capabilities/capabilityCatalog/prompts/promptCatalog`
as a **mirror of `catalogByWs[activeWorkspaceId]`** (so every existing read site —
`validateWorkflow`, `scopedCapabilityEntries`, `workflowDtsFor` — keeps working
unchanged). A private `setActiveCatalogMirror(id)` copies the keyed entry into the
four top-level fields and re-runs `validateWorkflow` + recomputes `workflowDts`
(the WU-14 DSL-dts rebuild on the active catalogs — fixes the §2.4 javascriptDefaults
bleed) + `inputStatePatch`. A new `fetchCatalogsFor(id)` does
`Promise.all([api.fetchCapabilities(id), api.fetchPrompts(id)])`, builds the two
catalogs, stores them in `catalogByWs[id]`, and (if `id === activeWorkspaceId`)
calls `setActiveCatalogMirror(id)`.

(c) **Per-workspace run registry (replaces the single `run`/`activeRunId`).** Today
`run: RunSnapshot|null` + `activeRunId` hold exactly one run and `startRun` clobbers
them (`useStore.ts:225-226,694-695`). Add:
```ts
runByWs: Record<string, {
  activeRunId: string | null
  run: RunSnapshot | null
  permission: PermissionRequest | null
  input: InputRequest | null
}>
```
Keep the top-level `run/activeRunId/permission/input` as a **mirror of
`runByWs[activeWorkspaceId]`** (so `Header`, `RunPanel`, dialogs render the
foreground = active workspace's run with no prop changes). `currentRun` /
`scheduleFlush` become per-active: `scheduleFlush` flushes
`runByWs[activeWorkspaceId].run` into the top-level mirror. On `setActiveWorkspace`,
the mirror is repointed to the target ws's slot — so switching A→B and back
**restores** A's still-executing run (it kept streaming into `runByWs[A]`; see (e)).
`startRun` writes into `runByWs[activeWorkspaceId]` (never another ws's slot) and
includes `workspaceId: activeWorkspaceId` on the `RunRequest` and the `start`
message (WU-0). `cancel/resume/step/permission/input` read the active slot's
`activeRunId` and send `{ ...payload, workspaceId: activeWorkspaceId }` (WU-0). The
`ws.send` calls at `useStore.ts:696,701,705,709,715,723` and `:420`
(`setBreakpoints`) each gain `workspaceId: activeWorkspaceId`.

(c2) **Per-workspace editor buffer + file list (B18 — make the WHOLE editor
surface workspace-scoped, symmetric with `catalogByWs`/`runByWs`).** Today the open
buffer and file tree are SINGLE top-level fields: `source` (`useStore.ts:202/296`),
`fileName` (`:203/297`), `openKind` (`:197/293`), `openTier` (`:294`), `dirty`
(`:204/298`), `breakpoints` (`:209/302`), `cwd` (`:213/306`), and `files`
(`:234/320`). Leaving them global causes four concrete cross-workspace failures: (1)
**save corruption** — open wsA's `foo.ts`, switch to wsB, save → `saveCurrent` passes
`activeWorkspaceId=B` (WU-12) and writes wsA's content into wsB; (2) **stale file
tree** — `files` still shows wsA after switching to B; (3) **disposing the displayed
model** — WU-14 disposes prior-ws tool models while @monaco-editor/react still owns
the shown model via the `path` prop (`WorkflowEditor.tsx:153,157`); (4) **lost dirty
edits** — A's unsaved buffer is clobbered by B's. FIX — add a per-workspace editor
slot and make the top-level fields MIRRORS of the active slot (same mirror pattern as
runs/catalogs):
```ts
// keyed by workspaceId
editorByWs: Record<string, {
  source: string
  fileName: string | null
  openKind: 'workflow' | 'prompt' | 'tool'
  openTier: 'project' | 'user' | null
  dirty: boolean
  breakpoints: number[]
  cwd: string                 // per-workspace agent-cwd OVERRIDE ('' = use ws root; B19/§Issue-1)
}>
filesByWs: Record<string, WorkflowFileInfo[]>
```
The existing top-level `source/fileName/openKind/openTier/dirty/breakpoints/cwd` and
`files` are **redefined as mirrors of `editorByWs[activeWorkspaceId]` /
`filesByWs[activeWorkspaceId]`** — every existing read site (`WorkflowEditor`,
`Header`, `FileTree`, `saveCurrent`) keeps working unchanged because it reads the
top-level mirror. Mutators write the active slot AND the mirror:
- `setSource`, `toggleBreakpoint`, `setCwd`, `openFile`, `openPrompt`, `openTool`,
  `newFile` write `editorByWs[activeWorkspaceId]` and copy to the top-level mirror.
- `refreshFiles(id?)` (signature gains an optional `id`, default `activeWorkspaceId`)
  calls `api.fetchFiles(id)`, stores into `filesByWs[id]`, and mirrors to top-level
  `files` only when `id === activeWorkspaceId`.
- `saveCurrent` reads the active mirror (`s.openKind/s.fileName/s.source/s.openTier`)
  and the WU-12 api fns with `s.activeWorkspaceId` — now self-consistent (the mirror
  IS the active workspace's buffer), so the save-corruption path is closed.
A private `setActiveEditorMirror(id)` copies `editorByWs[id]` (and `filesByWs[id]`)
into the eight top-level fields. **Seeding an absent slot:** when `editorByWs[id]` is
undefined (first time the ws becomes active), seed it to
`{ source: DEFAULT_WORKFLOW, fileName: null, openKind: 'workflow', openTier: null,
dirty: false, breakpoints: [], cwd: '' }` (the same defaults the store inits today,
`:296-306`).
**Rule for an open buffer whose file does not exist in the target workspace
(LOCKED):** the buffer lives in `editorByWs[id]`, so it is NEVER carried across
workspaces — there is no "open wsA's file under wsB" case. On switch we mirror the
TARGET ws's OWN slot (its last buffer, or the seeded default if first activation); we
do NOT attempt to re-open the previous ws's `fileName` in the new ws. A buffer thus
either (i) is the target ws's previously-edited (possibly dirty, possibly unsaved)
content — KEPT verbatim as an unsaved buffer, or (ii) is the seeded `DEFAULT_WORKFLOW`
on first activation. This guarantees a save always targets a file under the
workspace whose buffer is shown.

(c3) **The cwd↔workspace contract (B19 — tie per-run agent cwd to the active
workspace; resolves the "defaultCwd seeded once from the default ws" gap).** Chosen
option **(a): `defaultCwd` is per-active-workspace, and the run's cwd is sourced from
the active workspace.** The mechanism, fully specified:
- `defaultCwd` (top-level) is **redefined as the active workspace's root**, not a
  once-seeded constant. Its value comes from `WorkspaceInfo.root` (already on every
  `workspaces[]` entry via WU-0 — no new protocol field needed). It is set in `init`
  (f) to the resolved active workspace's `root`, and **repointed on every switch**
  (WU-13e step 5: `defaultCwd = workspaces.find(w => w.id === id)!.root`). The
  `/api/agents.defaultCwd` (default-ws root) is used only as the pre-`hello` bootstrap
  value; once `workspaces` arrives, `defaultCwd` always tracks the active ws root.
- The user's explicit `cwd` OVERRIDE is **per-workspace** (`editorByWs[id].cwd`,
  defaulting to `''`, (c2)); `setCwd` writes the active slot + mirror. So switching
  workspaces swaps the override too — wsA's typed cwd never leaks into a wsB run.
- `startRun` builds `cwd: s.cwd || s.defaultCwd` (UNCHANGED line shape,
  `useStore.ts:686`) but now BOTH operands are active-workspace-scoped: `s.cwd` is the
  active ws's per-ws override (usually `''`) and `s.defaultCwd` is the active ws's
  root. Net: `RunRequest.cwd` is ALWAYS the active workspace's root unless the user
  deliberately overrode it for that workspace.
- This agrees with the server: WU-10 drives `ws.runtime.run(..., { cwd: request.cwd })`
  and WU-7 keeps `this.cwd = request.cwd`; since `request.cwd` now always equals the
  owning workspace's root (or a deliberate same-workspace override), it matches the
  per-workspace `RunController.defaultCwd = workspace.root` (WU-7) rather than
  contradicting it. The explicit-override path (`run-controller.ts:188`
  `cwd = options.cwd ?? this.defaultCwd`) therefore resolves to the active workspace's
  root by construction. (A power user CAN still point a run elsewhere by typing a cwd
  override; that is intentional and stays within that workspace's UI slot.)

(c4) **Per-workspace attention state — make concurrent backgrounded runs
DISCOVERABLE (resolves the silent-deadlock issue).** A run in a NON-active workspace
that hits a permission/input request blocks the ACP agent waiting on a response the
user cannot see (the request lands in `runByWs[wsId].permission/input` but the
top-level dialog only mirrors the ACTIVE ws — WU-13d). Without a signal the user has
no way to know to switch back, so the run silently deadlocks. FIX — add a **derived**
per-workspace status, computed purely from `runByWs[*]` (no new transport):
```ts
// STORED, derived-from-runByWs map (its VALUE is a pure function of runByWs[id], but it
// IS a real store field — recomputed on every runByWs mutation, NOT a non-stored
// selector). LOCKED as a stored field (not a memoized selector): it is initialized
// (workspaceAttention: {}) and pruned on close (WU-13a step 3), so it must be a real
// State entry. Recompute per-id in onServerMessage after the slot mutation, and on
// startRun/setActiveWorkspace; the entry is deleted on closeWorkspace.
type WsStatus = 'idle' | 'running' | 'needs-input' | 'error'
workspaceAttention: Record<string, { status: WsStatus; needsInputSince?: number }>
```
Derivation for a workspace `id` from `slot = runByWs[id]`:
- `needs-input` if `slot.permission` or `slot.input` is non-null (a run is BLOCKED on
  a user response);
- else `error` if `slot.run?.status === 'failed'`;
- else `running` if `slot.run?.status === 'running' | 'paused'`;
- else `idle`.
This map is recomputed whenever `runByWs` changes (in `onServerMessage` after the
slot mutation, and on `startRun`/`setActiveWorkspace`), and its per-workspace entry
is DELETED on `closeWorkspace` (WU-13a step 3 prunes `workspaceAttention[id]` as the
FIFTH per-workspace map, symmetric with `runByWs`/`catalogByWs`/`editorByWs`/
`filesByWs`) — so a closed workspace never leaves a dangling attention entry. **`State`
initializes it to `workspaceAttention: {}`** (the empty map, alongside the other
per-workspace `Record` defaults — `runByWs`/`catalogByWs`/`editorByWs`/`filesByWs`);
it is the store's initial value, never `undefined`. It drives the WorkspacePicker
badges and the global needs-input indicator (WU-13b).

(d) **Inbound routing by `msg.workspaceId` (not a single `activeRunId`).** Rewrite
`onServerMessage` (`useStore.ts:735-792`) so every run-scoped case routes by the
message's `workspaceId` (carried per WU-0) into `runByWs[msg.workspaceId]`, then —
only if `msg.workspaceId === activeWorkspaceId` — mirrors to the top-level fields +
`scheduleFlush()`. After EVERY run-scoped case that mutates a slot, recompute
`workspaceAttention[msg.workspaceId]` (c4).

**LOCKED missing-slot guard (REQUIRED, binds EVERY run-scoped case —
`snapshot`/`event`/`permission`/`input`/`permission:resolved`/`input:resolved`, plus
the `workspaceAttention[msg.workspaceId]` recompute under `error`).** Each run-scoped
case MUST begin by looking up the slot and DROPPING the message — mutating nothing —
when the slot is absent:
```ts
const slot = runByWs[msg.workspaceId]
if (!slot) return   // closed/unknown workspace — drop late terminal events, mutate no state
```
This guard is REQUIRED, not an implementer option, precisely because
`WorkspaceRegistry.close()` (§1.2 step 2) cancels in-flight runs with a
**fire-and-forget** `handle.cancel()` (verified `cancel(): void` in
`runtime/run-controller.ts`) and does NOT await the asynchronous terminal
`run:finished`/`snapshot`/`permission:resolved` that the engine callbacks →
`RunManager.broadcast` → WS emit on a channel INDEPENDENT of the DELETE HTTP response.
The originating socket is a subscriber (`server/run-manager.ts:129`), so it DOES
receive those terminal broadcasts — and `closeWorkspace` step 3 (WU-13a) has already
`delete`d `runByWs[id]` by the time they arrive. A post-close broadcast tagged with
the closed `workspaceId` is therefore EXPECTED; without this guard the first
`slot.activeRunId`/`slot.run`/`slot.permission`/`slot.input` dereference is
`undefined.x` and crashes the store. The guard makes the drop silent and total: a
message for a missing/closed workspace returns immediately — no slot write, no
top-level mirror, no `workspaceAttention` change, no `scheduleFlush`, no toast. This
guard REPLACES (and strictly strengthens) the per-case
`msg.runId === get().activeRunId` filter the old code relied on
(`useStore.ts:762/768/775/781`): slot-existence is checked first, then the per-case
`=== slot.activeRunId` checks below still apply. (Server-side, §1.2 step 2's
`RunManager` MAY additionally prune the closed workspace's run entries so it stops
broadcasting to them; that is an optional optimization — the load-bearing, REQUIRED
fix is THIS frontend missing-slot guard, because `close()` cannot await the terminal
flush.) Concretely (every bullet runs AFTER the guard, so `slot` is non-null):
- `snapshot`: if `msg.snapshot.runId === slot.activeRunId` set `slot.run = msg.snapshot` (+ mirror if active).
- `event`: reduce into `slot.run` when `msg.runId === slot.activeRunId` (+ flush if active).
- `permission`/`input`: set `slot.permission`/`slot.input` when `msg.runId === slot.activeRunId`. **If `msg.workspaceId === activeWorkspaceId`**, ALSO mirror to the
  top-level dialog (current behavior). **If `msg.workspaceId !== activeWorkspaceId`**
  (a BACKGROUND workspace's run is now blocked), DO NOT mirror to the foreground
  dialog, but set `workspaceAttention[msg.workspaceId].status = 'needs-input'`
  (recompute, c4) AND raise a non-blocking toast/notification
  ("Workspace <name> needs input — click to switch") whose action calls
  `setActiveWorkspace(msg.workspaceId)`. The pending request stays in
  `runByWs[msg.workspaceId].permission/input` and is surfaced as the foreground dialog
  the moment the user switches (WU-13e step 4 repoints the mirror). This is what makes
  the backgrounded blocked run discoverable and answerable.
- `permission:resolved`/`input:resolved`: clear in the (guarded, non-null) slot keyed by `msg.workspaceId` (+ mirror if active); recompute that ws's attention.
- `error`: set top-level `lastError` (ws-tagged optional per WU-0) — this is a GLOBAL surface and is shown REGARDLESS of slot existence (an error for a since-closed ws still informs the user). The `workspaceAttention[msg.workspaceId]` recompute, however, is slot-scoped and MUST obey the same missing-slot guard: recompute ONLY when `runByWs[msg.workspaceId]` still exists (a late error for a closed ws updates no attention entry and never dereferences a deleted slot).
- `hello`: NOT run-scoped — carries no per-workspace `runByWs` slot reference, so it is EXEMPT from the missing-slot guard. It now also carries `workspaces` + `defaultWorkspaceId` (WU-0) — seed
  `workspaces` + `defaultWorkspaceId`, and if `activeWorkspaceId` is unset pick it per
  (f); rebuild `workflowDts` from the active catalogs.

(e) **Switch lifecycle — the EXACT, ORDERED rule (B18: buffer/files repointed +
refreshed BEFORE any Monaco dispose).** There is ONE persistent `WsClient` for the
whole app (`useStore.ts:94,325`); the frontend never sends `subscribe` for its own
runs (it is the originator). Runs multiplex over that one socket and are routed by
`msg.workspaceId`/`runId` (d). **Therefore on `setActiveWorkspace(id)` we DO NOT tear
down, unsubscribe, or cancel anything** — background runs in other workspaces keep
streaming into their `runByWs[*]` slots. The switch is a snapshot → repoint → refresh
→ Monaco-swap, in EXACTLY this order (the Monaco dispose/lib-swap MUST run LAST, after
the buffer mirror already points at the target slot, so the disposed models are never
the freshly-mirrored active buffer):
```
setActiveWorkspace(id):   // id === current activeWorkspaceId → no-op early return
  const prevId = get().activeWorkspaceId
  1. SNAPSHOT the outgoing buffer: write the current top-level
     {source,fileName,openKind,openTier,dirty,breakpoints,cwd} back into
     editorByWs[prevId] (so prevId's possibly-dirty unsaved edits are preserved).
  2. persist localStorage['agentprism.activeWorkspaceId'] = id
  3. set activeWorkspaceId = id
  4. REPOINT run mirror -> runByWs[id]      (seed empty slot if absent, (c))
     This copies runByWs[id].{run,activeRunId,permission,input} into the top-level
     mirror — so if the target ws had a BACKGROUNDED run blocked on a permission/input
     request (c4), that request now becomes the FOREGROUND dialog, answerable on
     switch. Clear workspaceAttention[id] back to its derived value (the request is no
     longer "background"). (This is the repoint the global needs-input indicator and
     picker badge, WU-13b, drive the user toward.)
  5. REPOINT editor mirror -> editorByWs[id] via setActiveEditorMirror(id)
     (seed DEFAULT_WORKFLOW slot when absent, (c2)); ALSO repoint defaultCwd to the
     target ws root: defaultCwd = workspaces.find(w => w.id === id)!.root  (§Issue-1)
  6. await refreshFiles(id)                  // (c2): filesByWs[id] + mirror; tree now shows id
  7. if !catalogByWs[id]: await fetchCatalogsFor(id)   // lazy; populates + mirrors (recomputes workflowDts state)
     else: setActiveCatalogMirror(id)                  // re-validate + rebuild workflowDts state
```
**Steps 1-7 are PURE STORE-STATE mutations** — the store holds NO monaco instance
(today it only computes `workflowDts` as state; the editor applies it, verified:
`useStore.ts` never references `monaco`). The Monaco-side effects (TS extra-libs
swap, prior-ws tool-model dispose, and `updateWorkflowDts`) are performed by WU-14's
`WorkflowEditor` effect, which is subscribed to `activeWorkspaceId` + `workflowDts`
and therefore fires AFTER this synchronous store update has already repointed the
buffer mirror (step 5) and rebuilt `workflowDts` (step 7). Ordering is thus
guaranteed by React's render→effect sequencing: the editor disposes ONLY `prevId`'s
tool models — which by step 5 are no longer the mirrored active buffer — so the
currently-displayed model is never disposed out from under @monaco-editor/react.
Steps 1 and 5 are the buffer fix: the open buffer/file-list/breakpoints are
workspace-keyed, so switching A→B→A restores A's exact (even dirty) buffer and never
clobbers it with B's, and a save after switching always targets the shown
workspace's filesystem. Step 5 also repoints `defaultCwd` to the active workspace
root so a run started after a switch uses the right cwd (§Issue-1/c3). The only WS
message a switch could send is a `cancel` the USER explicitly clicks; switching never
auto-cancels. No `unsubscribe` call exists or is added.

(f) **init() keys the first fetch by the resolved active id.** Rewrite `init`
(`useStore.ts:323-375`): after the `WsClient` is created, `await api.fetchWorkspaces()`
+ `api.fetchAgents()`; store `workspaces` and the response's `defaultWorkspaceId` into
the store field (used as the close-reselect target, WU-13a). Choose `activeWorkspaceId`
= `localStorage['agentprism.activeWorkspaceId']` if still listed, else
`defaultWorkspaceId`; persist. Then, BEFORE the first catalog/file fetch:
- seed the active editor slot if absent (`editorByWs[activeWorkspaceId]` ← the
  `DEFAULT_WORKFLOW` defaults of (c2)) and call `setActiveEditorMirror(activeWorkspaceId)`;
- set `defaultCwd = workspaces.find(w => w.id === activeWorkspaceId)!.root` (the
  active ws root, (c3)) — superseding the bootstrap `/api/agents.defaultCwd`.
Then `await fetchCatalogsFor(activeWorkspaceId)` (NOT a bare `fetchCapabilities()`)
and `await refreshFiles(activeWorkspaceId)` (now ws-scoped, WU-12/(c2)).
`refreshCapabilities/refreshPrompts/refreshFiles/openFile/openPrompt/openTool/
saveCurrent/deleteFileByName` all pass `get().activeWorkspaceId` to the WU-12 api fns
and write through the active-keyed slot (`catalogByWs`/`filesByWs`/`editorByWs`) +
the matching `setActive*Mirror`.

### WU-13b — Workspace picker + Header mount  ·  files: NEW `src/features/workspace/WorkspacePicker.tsx`, `src/features/layout/Header.tsx`  ·  dependsOn: [WU-13]
- `WorkspacePicker.tsx`: a store-connected component (no props) reading
  `useStore(s => s.workspaces)`, `s.activeWorkspaceId`, the derived
  `workspaceAttention` map (c4), and calling
  `s.setActiveWorkspace`, `s.openWorkspace`, `s.closeWorkspace`, `s.refreshWorkspaces`.
  Render a `Select` (reuse `@/components/ui/select`, as `Header` already imports UI
  primitives) listing `workspaces` by `name` (title=`root`), bound to
  `activeWorkspaceId`. Each row renders a **per-workspace status dot/badge** driven by
  `(workspaceAttention[id]?.status ?? 'idle')` (c4 — a freshly-opened, never-activated
  workspace has no entry yet since `workspaceAttention` inits `{}` and is only
  recomputed on `startRun`/`setActiveWorkspace`/`onServerMessage`, so the optional-chain
  `?? 'idle'` is REQUIRED, not optional): `running` (spinner/blue dot),
  `needs-input` (amber pulsing dot — a backgrounded run is blocked on a
  permission/input request the user cannot otherwise see), `error` (red dot),
  `idle` (no dot). A close ("×") affordance per non-active row calls
  `closeWorkspace(id)` (disabled when `workspaces.length === 1`, matching the
  server's 409). Plus an **"Open folder…"** item that prompts for a path and does
  `const id = await openWorkspace(root); await setActiveWorkspace(id)` — `id` is the
  value RETURNED by the store's `openWorkspace` (WU-13a), which obtained it from
  `api.openWorkspace(root).id`. There is no client-side id computation.
- **Global "background workspace needs input" indicator.** Next to the picker (still
  in `Header`), render a single attention bell/badge that is visible iff
  `s.workspaces.some((w) => w.id !== s.activeWorkspaceId && s.workspaceAttention[w.id]?.status === 'needs-input')`.
  This iterates the **live `workspaces` list** (NOT `Object.entries(workspaceAttention)`
  directly), so a stale/dangling attention entry for a since-closed workspace can never
  relight the indicator. Clicking it switches to the FIRST such still-open workspace —
  `const target = s.workspaces.find((w) => w.id !== s.activeWorkspaceId && s.workspaceAttention[w.id]?.status === 'needs-input'); if (target) s.setActiveWorkspace(target.id)`
  — so the click can only ever target an id present in `workspaces` (never a closed one,
  which would otherwise seed an empty editor slot and `fetchCatalogsFor` a now-404'd
  server workspace). This surfaces the target's still-pending permission/input dialog
  (repointed from `runByWs[target.id]` by WU-13e step 4), making a backgrounded, blocked
  run **discoverable** instead of a silent deadlock. (Close already prunes
  `workspaceAttention[id]` — WU-13a step 3 — so this list-scoping is defense-in-depth:
  the indicator is dangle-proof even if a stale entry ever survived.)
- **Exact mount point:** in `src/features/layout/Header.tsx`, immediately after the
  logo block (the `<div className="flex items-center gap-2.5"> … </div>` ending at
  the line before the first `<Separator orientation="vertical" className="mx-1 !h-7" />`),
  insert `<Separator orientation="vertical" className="mx-1 !h-7" /><WorkspacePicker />`.
  `Header` is the component App.tsx mounts at `src/App.tsx:28` (`<Header />`), so no
  `App.tsx` change is needed; the picker rides the existing single Header instance.

### WU-14 — Monaco namespacing + active-workspace swap  ·  files: `src/lib/monaco-setup.ts`, `src/features/editor/WorkflowEditor.tsx`  ·  dependsOn: [WU-12, WU-13, WU-13b]
- `monaco-setup.ts`:
  - `CAPABILITY_LIB_PATH` is no longer a constant: per active ws it is
    `file:///${wsId}/shared/capability.ts`. `baseToolLibs(wsId)` returns the cap
    source at that path + the (ws-independent) node:* shim.
  - Replace the module-global singletons (`toolSourceLibs`, `toolOpenPath`,
    `toolPackageLibs`, `toolAttemptedSpecs`) with **per-workspace maps keyed by
    wsId**, plus a module-global `activeWorkspaceId: string | null`.
  - `publishToolLibs()` publishes ONLY the active ws's libs:
    `setExtraLibs([...baseToolLibs(active), ...sources(active), ...pkgs(active)])`.
  - `refreshToolSources(monaco, wsId, openPath)` (add `wsId` param) populates that
    ws's source map (calling `fetchToolSources(wsId)`) and, if `wsId === active`,
    republishes.
  - `ensurePackages(wsId, specs)` keys into that ws's pkg + attempted maps.
  - The marker listener filters on `resource.path.startsWith('/' + activeWorkspaceId + '/tools/')`
    (was `/tools/`, `:143`) and calls `ensurePackages(activeWorkspaceId, specs)`.
  - ADD `setActiveWorkspace(monaco, wsId)`: sets module-global `activeWorkspaceId`,
    `setExtraLibs([])`, republishes active libs (`baseToolLibs(wsId)` puts the cap lib
    at `file:///${wsId}/shared/capability.ts`), and **disposes prior workspace tool
    models** (`monaco.editor.getModels().filter(m => m.uri.path.startsWith('/'+priorId+'/tools/')).forEach(m => m.dispose())`).
    This is invoked from the `WorkflowEditor`'s `activeWorkspaceId`-subscribed effect
    (WU-14), which fires AFTER the store's state-only switch (WU-13e steps 1-7) has
    repointed the buffer/catalog mirrors — so the disposed `priorId` models are never
    the freshly-mirrored active buffer. Note the **`javascriptDefaults` DSL dts is
    swapped separately** by the `WorkflowEditor`'s `workflowDts`-subscribed effect
    calling `updateWorkflowDts(monaco, workflowDts)` (the store rebuilt `workflowDts`
    state in WU-13e step 7) — `monaco-setup`'s
    `updateWorkflowDts` is unchanged but is now driven per active workspace (fixes the
    §2.4 javascriptDefaults cross-workspace bleed); the DSL dts is no longer assumed
    global.
- `WorkflowEditor.tsx`: replace the three `file:///tools/${fileName}` sites
  (`:118`, `:145`, `:153`) with `file:///${wsId}/tools/${fileName}` where `wsId` is
  `useStore(s => s.activeWorkspaceId)`; pass `wsId` into `refreshToolSources(monaco, wsId, openPath)`.
- **`WorkflowEditor` OWNS the Monaco-side switch sequence** (the store has no monaco
  ref — WU-13e steps 1-7 are state-only). Add a store-subscribed `useEffect` keyed on
  `activeWorkspaceId` that captures the previous id (a `useRef`) and, when it changes,
  runs IN ORDER: (1) `setActiveWorkspace(mon, wsId)` — TS extra-libs swap + dispose the
  PREVIOUS ws's tool models (the dispose targets `prevId`, never `wsId`; the
  now-displayed buffer is `wsId`'s, already mirrored by store step 5 before this effect
  fires). The model the editor renders is `file:///${wsId}/...`, a different URI from
  the disposed `file:///${prevId}/...` models, so @monaco-editor/react's current model
  is untouched. (2) A SEPARATE `useEffect` keyed on `workflowDts` calls
  `updateWorkflowDts(mon, workflowDts)` so the `javascriptDefaults` DSL dts reflects
  the active ws's catalogs (store step 7 rebuilt it). Because both effects run only
  after the synchronous store update (steps 1-7) has committed, the catalog refresh /
  buffer repoint always precede the Monaco swap — satisfying WU-13e's ordering with no
  store→monaco coupling.

---

## 8. Migration / back-compat

- **Default single-workspace == today.** `createRuntime()` and
  `createRuntime({ cwd })` with no `workspaces` open ONE workspace at
  `cwd ?? process.cwd()` with `useEnvDirOverrides: true`. Its derived dirs equal the
  old eager consts exactly (`AGENTPRISM_*_DIR` overrides still honored), so a
  single-project user sees identical behavior. `server/index.ts` (non-bin entry)
  keeps `createRuntime()` and works unchanged from whatever cwd it started in.
- **Bin:** `npx agentprism-ide --cwd /proj` now opens `/proj` as the default
  workspace WITHOUT chdir. `--cwd` semantics preserved (it picks the default root).
  New: repeatable `--workspace /other` pre-opens more (the LSP initial-set model).
- **Protocol:** `workspaceId` is required on new messages; the frontend always sends
  the active id. There is no wire compatibility with an un-upgraded client (single
  app, lockstep deploy) — acceptable.
- **REST path change** `/api/X` → `/api/workspaces/:id/X` is a breaking move; the
  frontend (WU-12) updates in lockstep. No external consumers exist.
- The `agentprism-authoring` skill's documented convention (tools at `<root>/tools/*.ts`
  importing `../shared/capability.ts`) is preserved **unchanged for BOTH tiers**: at
  **runtime** by the materialized `<ws>/shared/capability.ts` re-export shim AND the
  `~/.agentprism/shared/capability.ts` user-tier shim (§5.4), at **dts derivation** by
  the CompilerHost overlays at both `<workspaceRoot>/shared` and
  `<userToolsParent>/shared` (§5.3), and in the **editor** by the Monaco virtual lib
  at `file:///<wsId>/shared/capability.ts` (§2.4). All resolve to the one PACKAGE_ROOT
  source. (The §5.3 overlay alone does NOT cover runtime execution — the shims do.)

---

## 9. Verification plan

Run from repo root unless noted. All must pass.

1. **Typecheck (full):** `npm run typecheck` (or `npx tsc -p tsconfig.json --noEmit`
   and the frontend `tsc`/`vite build` typecheck). Zero errors. Targets touched:
   `runtime/*`, `server/*`, `shared/protocol.ts`, `src/*`.
2. **Single-workspace parity (back-compat):** boot `server/index.ts` from the repo
   root; confirm `GET /api/workspaces` lists one default workspace whose `root` is
   the repo, `GET /api/workspaces/<id>/capabilities` returns the same catalog as
   before, and a workflow run completes — identical to pre-change behavior.
3. **Intellisense from a NON-cwd workspace (the B5 proof):**
   - Create `/tmp/ws-a` with `tools/foo.ts` importing a package installed ONLY in
     `/tmp/ws-a/node_modules` (e.g. `npm i zod@3` there), and `npm i zod@4` in the
     repo. Boot the IDE from the REPO root, then `POST /api/workspaces { root:
     '/tmp/ws-a' }`. `POST /api/workspaces/<wsA-id>/tool-types { specifiers:['zod'] }`
     MUST return zod **v3** `.d.cts` libs keyed `file:///<wsA-id>/node_modules/zod/...`
     — proving resolution anchors at the workspace `node_modules`, not PACKAGE_ROOT.
   - Symlink proof: `npm link` a local package into `/tmp/ws-a/node_modules`; confirm
     `tool-types` still returns its `.d.ts` (preserveSymlinks keeps it under
     `node_modules/`, §5.2).
4. **Two-workspaces-at-once proof:** open `/tmp/ws-a` and `/tmp/ws-b` (each with a
   same-named `tools/foo.ts` but different deps). Concurrently start a run in each;
   confirm both complete with their own catalogs (no cross-bleed), distinct
   `workspaceId` on every WS message, and that `get(runId)` routes correctly. In the
   editor, switch A→B and confirm `setExtraLibs` now contains ONLY B's libs and A's
   tool models are disposed (inspect `getModels()` / `getExtraLibs()` keys —
   all under `file:///<wsB-id>/...`).
5. **chdir/eager-const elimination:** `grep -n "process.chdir" bin/` → none;
   `grep -n "process.cwd()" server/config.ts` → none (config is now PORT + a
   re-export only); `grep -rn "PROJECT_TOOLS_DIR\|WORKFLOWS_DIR\|CAPABILITY_DIRS\|PROMPT_DIRS\|DEFAULT_CWD" server/ runtime/`
   → only inside `deriveWorkspaceDirs`/removed. `grep -rn "PACKAGE_ROOT" runtime/engine/`
   → none (tool-intellisense is at `runtime/tool-intellisense.ts`, anchored at the
   workspace nodeModulesRoot).
   **Runtime `process.cwd()` scoping (enforces the §6 runtime MUST-NOT carve-out):**
   `grep -rn "process.cwd()" runtime/` → matches ONLY in `runtime/index.ts` (the
   `createRuntime`/`runWorkflow` composition-root back-compat default, the SOLE permitted
   reader per §6/§2.5/WU-8/§8). Specifically `grep -rn "process.cwd()" runtime/workspace.ts
   runtime/workspace-registry.ts runtime/paths.ts runtime/run-controller.ts runtime/resolve.ts
   runtime/tool-intellisense.ts runtime/engine/ runtime/store/` → **zero matches** (no
   `Workspace`/`deriveWorkspaceDirs`/loader/registry/controller path reads cwd for
   resolution; `deriveWorkspaceDirs` reads `process.env`, never `process.cwd()`).
6. **Layering (server has no resolution):** `grep -n "PROJECT_\|USER_\|_DIR\|tool-intellisense" server/factory.ts`
   → no dir-const or resolution imports remain (only PORT + PACKAGE_ROOT for the
   dist static-serve join). **Agent-probe relocation (B16, §4.1) — gate scoped to
   AGENT-PROBE tokens ONLY** (the bare `existsSync` term is intentionally NOT in this
   grep: the PACKAGE_ROOT dist `fs.existsSync(distDir)` at `factory.ts:251` legitimately
   REMAINS, allowed by LOCKED decision 3, and a bare-`existsSync` gate could never return
   zero nor distinguish it from the removed agent probe):
   `grep -nE "@agentclientprotocol|isInstalled|agentsWithStatus|resolveAgentBin" server/factory.ts`
   → **zero matches** (the probe now lives in `runtime/agents.ts`; `/api/agents`
   and `hello` PROJECT `runtime.listAgents()`). To prove the agent-probe `existsSync`
   specifically is gone while allowing the dist one, additionally assert
   `grep -n "existsSync" server/factory.ts` returns ONLY the `distDir` line
   (`fs.existsSync(distDir)`), i.e. no `@agentclientprotocol`/`node_modules` candidate.
   `grep -nE "isAgentInstalled|listAgents" runtime/agents.ts` → present.
7. **Package boundary (runtime imports zero server):**
   `grep -rn "from '\.\./server\|from '\.\./\.\./server\|from \"\.\./server" runtime/`
   → **zero matches**. Confirms `@agentprism/runtime` (`dist-lib/runtime/index.js`)
   loads without `@agentprism/server` (§6.1). Also `ls server/workflow server/store
   server/acp 2>/dev/null` → all absent (relocated by WU-R).
8. **Capability-shim correctness (the runtime §5.4 proof):** with the IDE booted
   from the REPO root, `POST /api/workspaces { root: '/tmp/ws-a' }` (where `/tmp/ws-a`
   has NO `shared/` dir). Assert: (i) `/tmp/ws-a/shared/capability.ts` now exists and
   begins with the `@agentprism-capability-shim` sentinel; (ii) a workflow that uses a
   `/tmp/ws-a/tools/foo.ts` capability RUNS — `loadCapabilities` returns the catalog
   with no `loadError` (proves the real `await import()` of `../shared/capability.ts`
   resolved through the shim to PACKAGE_ROOT's source). For the DEFAULT workspace (ws
   == repo) assert the shim is a NO-OP: `shared/capability.ts` is unchanged (git
   status clean — same realpath, §5.4 early-return).
9. **User-tier capability loads at runtime AND derives dts (the §5.4/§5.3 user-tier
   proof, B15):** place a capability at `~/.agentprism/tools/foo.ts` importing
   `../shared/capability.ts` (the uniform authoring convention), with NO
   `~/.agentprism/shared/` dir beforehand. Open ANY workspace (e.g. the repo). Assert:
   (i) `~/.agentprism/shared/capability.ts` now exists and begins with the
   `@agentprism-capability-shim` sentinel (written by `ensureUserCapabilityShim`);
   (ii) `GET /api/workspaces/<id>/capabilities` lists `foo` with **no `loadError`**
   (the runtime `await import()` resolved `../shared/capability.ts` through the
   user-tier shim to PACKAGE_ROOT); (iii) `foo`'s derived namespace `.d.ts` is
   non-empty when its effect return type references the cap API (the §5.3
   `userToolsParent` overlay fed the dts Program). This is the editor==runtime parity
   (LOCKED decision 4) extended to the user tier.
10. **Per-workspace editor buffer + save targeting (B18):** open `/tmp/ws-a` and
    `/tmp/ws-b`. In wsA open `foo.ts` and type an unsaved edit (buffer dirty). Switch
    to wsB. Assert: (i) the file tree now lists wsB's files (not wsA's) — proves
    `refreshFiles(id)` ran in the switch; (ii) the editor shows wsB's own last buffer
    (or `DEFAULT_WORKFLOW` on first activation), NOT wsA's `foo.ts`; (iii) hit Save —
    the write lands under `/tmp/ws-b` (NOT wsA), proving the save-corruption path is
    closed. Switch back to wsA: assert `foo.ts` reappears with the unsaved edit intact
    (buffer was preserved in `editorByWs[wsA]`, not clobbered). Inspect
    `monaco.editor.getModels()`: the displayed model is `file:///<wsB-id>/...` and no
    disposed model was the currently-shown one.
11. **cwd ties to the active workspace (B19):** with wsA (root `/tmp/ws-a`) and wsB
    (root `/tmp/ws-b`) open and NO user cwd override typed, switch to wsB and start a
    run. Assert the emitted `RunRequest.cwd === /tmp/ws-b` (the active ws root, via the
    repointed `defaultCwd`), and the run's agent process spawns with cwd `/tmp/ws-b`.
    Switch to wsA, start a run → `cwd === /tmp/ws-a`. Type a per-ws override in wsA and
    confirm it does NOT appear after switching to wsB (override is `editorByWs[id].cwd`).
12. **Close the DEFAULT workspace — registry + endpoints survive (§1.2):** boot from
    the repo (default ws), `POST /api/workspaces { root: '/tmp/ws-a' }`. Then
    `DELETE /api/workspaces/<repo-default-id>`. Assert: (i) the call returns 200
    `{ ok: true }` (NOT 409, since another ws is open); (ii) `registry.defaultId()`
    now resolves to `/tmp/ws-a`'s id (reassigned, §1.2 rule 3); (iii) `GET /api/agents`
    still 200s with `defaultCwd === /tmp/ws-a` and a fresh WS connection's `hello` still
    200s with a valid `defaultWorkspaceId` — neither dangles. Then `DELETE` the LAST
    remaining workspace → assert **409** `Cannot close the last open workspace` and the
    workspace stays open. Frontend: with the repo active, `closeWorkspace(<repo-id>)`
    → assert the store switched `activeWorkspaceId` to the surviving ws BEFORE removal,
    `runByWs/catalogByWs/editorByWs/filesByWs/workspaceAttention` (all FIVE per-ws maps)
    no longer contain the closed id, and the UI shows the surviving workspace's
    buffer/catalog (no blank mirror, no crash). Specifically, with a backgrounded
    `needs-input` run in `<repo-id>` at close time, assert AFTER close that the global
    needs-input indicator is NOT lit referencing the closed id (its
    `workspaceAttention[<repo-id>]` entry was pruned by WU-13a step 3, and the WU-13b
    selector — scoped to the live `workspaces` list — would ignore a stale entry anyway).
    Then, with only ONE workspace left, call the store's `closeWorkspace(<only-id>)`
    directly (bypassing the disabled picker button) → assert the step-0 guard returns
    early: `lastError === 'Cannot close the last open workspace'`, NO `api.closeWorkspace`
    request was issued, and `workspaces`/`activeWorkspaceId`/the per-ws slots are
    byte-for-byte unchanged (the `find(...)!.id` non-null assertion in step 1 is never
    reached). This proves the single, consistent last-workspace account holds on the
    frontend too.
    **Late-terminal-event drop (the WU-13d missing-slot guard, B-skeptic teardown
    race):** boot from the repo (default ws), `POST /api/workspaces { root: '/tmp/ws-a' }`,
    then start a run IN the repo default ws and, while that run is still executing,
    `closeWorkspace(<repo-default-id>)` from the store (length > 1, so it proceeds:
    switch-away → `api.closeWorkspace` → step-3 `delete runByWs[repo-id]`). Because
    `WorkspaceRegistry.close()` cancels the in-flight run fire-and-forget and does NOT
    await its terminal flush, the engine subsequently broadcasts that run's terminal
    `run:finished` (and a trailing `snapshot` and, if it was mid-permission,
    `permission:resolved`) tagged with the now-CLOSED `repo-default-id` over the same
    socket the store still listens on. Deliver those late broadcasts to `onServerMessage`
    AFTER the close completed. Assert: (i) `onServerMessage` does NOT throw (no
    `undefined.activeRunId`/`undefined.run` TypeError) — the `const slot =
    runByWs[msg.workspaceId]; if (!slot) return` guard drops each; (ii) the store
    mutates NO state — `runByWs` still has no entry for the closed id, and
    `activeWorkspaceId`, the surviving ws's slot, `workspaceAttention`, and the
    top-level run mirror are byte-for-byte unchanged; (iii) no toast fires. This proves
    a still-cancelling run's terminal events for a closed workspace cannot crash or
    corrupt the store.
13. **Concurrent backgrounded run needs input — discoverable + answerable (c4/WU-13d):**
    open wsA + wsB; start a run in wsA that triggers a permission request, then switch
    to wsB (wsA's run is now backgrounded and blocked). Assert: (i) the WorkspacePicker
    shows wsA's row with the **needs-input** badge and the global needs-input indicator
    is visible; (ii) a toast fired naming wsA; (iii) the foreground (wsB) dialog is NOT
    showing wsA's request; (iv) clicking the indicator / wsA's row calls
    `setActiveWorkspace(wsA)` and the still-pending permission dialog appears as the
    foreground dialog (repointed from `runByWs[wsA].permission`, WU-13e step 4);
    answering it unblocks wsA's run (it streams to completion). This proves a
    backgrounded blocked run cannot silently deadlock.

---

## 10. Decisions resolved (no implementer choices remain)

- Per-workspace `RunController` (not one shared) — concurrency isolation + env-per-
  workspace (B12) **[R4]**.
- `RunManager` keyed by client runId + `workspaceId` tag (not a global engine-runId
  index) — minimal surface, the WS message already carries both.
- Monaco: URI path-prefix namespacing + active-workspace lib swap + dispose inactive
  models. Multi-pane concurrent editing explicitly out of scope **[R2 §6]**.
- `preserveSymlinks: true` on BOTH the tool-intellisense Program and the
  derive-capability-dts Program (option 1, §5.2) **[R3 §5]**.
- Capability-API resolution stays AgentPrism-owned and identical across all three
  consumers (one PACKAGE_ROOT source) **for BOTH the project and user tiers**: runtime
  via the materialized `<ws>/shared/capability.ts` + `~/.agentprism/shared/capability.ts`
  re-export shims (§5.4), dts-derivation via CompilerHost overlays at both
  `<workspaceRoot>/shared` and `<userToolsParent>/shared` (§5.3), editor via the
  Monaco virtual lib (§2.4); npm/@types from the workspace. The user-tier
  (cross-project shared library, LOCKED decision 2) is covered first-class, not
  deferred (B15, gate §9.9).
- **Agent-installed probe RELOCATED to the runtime** (`runtime/agents.ts`,
  `isAgentInstalled`/`listAgents`, §4.1, B16): the candidate-path composition +
  `fs.existsSync` no longer execute in the server projection layer. The server
  PROJECTS `runtime.listAgents()`; gate §9.6 asserts zero agent-probe fs/path in
  `server/factory.ts`. Restores the brief's "the ONLY layer that touches the
  filesystem" without the prior "user filesystem" carve-out.
- `AGENTPRISM_*_DIR` env overrides honored ONLY for the default workspace
  (`useEnvDirOverrides`), ignored for additionally-opened ones (§11.E).
- **Runtime-tier subtree RELOCATED into `runtime/`** (WU-R): `server/workflow/* →
  runtime/engine/*`, `server/store/* → runtime/store/*`, `server/acp/* →
  runtime/acp/*`, resolution consts → `runtime/paths.ts`, `tool-intellisense.ts →
  runtime/tool-intellisense.ts`. Zero `runtime/* → ../server/*` edges remain (gate
  §9.7). Server keeps only `factory.ts`/`run-manager.ts`/`index.ts`/thin `config.ts`.
- **Frontend single source of truth = the zustand `useStore`** (no separate React
  workspace context/provider). `activeWorkspaceId`, the workspace list,
  per-workspace catalogs (`catalogByWs`), and per-workspace runs (`runByWs`) all live
  in the store; top-level `run`/`capabilities`/etc. are mirrors of the active slot.
- **Concurrent runs across workspaces are representable AND discoverable in the UI**:
  `runByWs` keeps each workspace's run streaming independently; switching repoints the
  mirror and restores the other workspace's run (no clobber). Inbound routing is by
  `msg.workspaceId` (WU-0), not a single `activeRunId`. A derived
  `workspaceAttention` map (WU-13 c4) surfaces each workspace's `idle/running/
  needs-input/error` status as a per-row badge + a global needs-input indicator
  (WU-13b); a permission/input for a BACKGROUND workspace sets its `needs-input` flag
  and raises a toast (WU-13d), so a backgrounded blocked run is never a silent
  deadlock — the user is prompted to switch, and the switch repoints the pending
  dialog to the foreground (WU-13e step 4, gate §9.13).
- **Workspace CLOSE lifecycle is first-class (§1.2, WU-6, WU-13a):** `close` rejects
  closing the last open workspace (409); reassigns `defaultId` to the next-oldest
  still-open workspace when the default is closed (so `default()`/`defaultId()`/
  `getOrThrow` never dangle); `default()`/`defaultId()` throw a defined
  `No workspaces open` rather than returning `undefined`. The store's `closeWorkspace`
  switches away from a closed ACTIVE workspace BEFORE removal and deletes its
  `runByWs/catalogByWs/editorByWs/filesByWs/workspaceAttention` slots (all FIVE
  per-workspace maps; gate §9.12) — so closing a backgrounded `needs-input` workspace
  from the picker leaves no dangling attention entry to permanently light the global
  needs-input indicator. The WU-13b indicator selector additionally scopes to the live
  `workspaces` list (not the raw `workspaceAttention` map) and its click handler targets
  only an id present in `workspaces`, so even a stale entry cannot relight it nor switch
  to a closed workspace.
- **`openWorkspace` returns the new workspace id (WU-13a):** the browser never
  computes ids (no `computeWorkspaceId` import — forbidden frontend resolution); the
  store action returns `api.openWorkspace(root).id`, and the picker's "Open folder…"
  does `const id = await openWorkspace(root); await setActiveWorkspace(id)` (WU-13b).
- **Switch never tears down WS subscriptions / cancels runs** (WU-13e): one socket,
  routed by `workspaceId`; no `unsubscribe` call exists.
- **The ENTIRE editor surface is workspace-scoped** (B18, WU-13 c2): `editorByWs`
  (source/fileName/openKind/openTier/dirty/breakpoints/cwd) + `filesByWs`; top-level
  fields are mirrors of the active slot. The switch lifecycle SNAPSHOTS the outgoing
  buffer, REPOINTS the mirror, `await refreshFiles(id)`, THEN does the Monaco
  dispose/lib-swap (state-before-effect ordering) — so no save-corruption, no stale
  tree, no disposing the displayed model, no lost dirty edits. A buffer is never
  carried across workspaces (each ws shows its own slot or the seeded default).
- **Agent cwd is tied to the active workspace** (B19, WU-13 c3): `defaultCwd` is the
  active ws root (repointed on switch from `WorkspaceInfo.root`), the user cwd override
  is per-workspace (`editorByWs[id].cwd`), and `startRun`'s `cwd: s.cwd || s.defaultCwd`
  therefore always resolves to the active workspace's root — matching the per-workspace
  `RunController.defaultCwd = workspace.root` rather than overriding it.
- **`createWorkspace` construction order is LOCKED** (B17, WU-6): allocate the
  `Workspace` object first (`runtime` field unassigned, non-readonly), construct
  `RunController` with that named `ws` reference (never `this`), build the
  `WorkspaceRuntime`, assign `ws.runtime` once. The controller reads only
  `workspace.root`/`.id`/loaders at construct, never `.runtime`.
- **Agent-installed probe lives in the runtime** (B16, §4.1, `runtime/agents.ts`):
  candidate-path compose + `fs.existsSync` moved off the server; the server PROJECTS
  `runtime.listAgents()`. Runtime is again "the ONLY layer that touches the
  filesystem" with no "user" carve-out.

---

## 11. Research-flagged items, resolved

- **A (Monaco extra libs global):** confirmed against shipped `monaco.d.ts` +
  `ts.worker.js` **[R2]**. Resolved by §2.4 (namespacing + active-swap + model
  dispose). The "per-authority lookup" trick is a community pattern, not a Microsoft
  guarantee **[R2 #5087]** — we therefore rely on the stronger single-active-project
  guarantee (one ws resident at a time), not on authority isolation.
- **B (scoped-package `@` URI bug):** keep `workspaceId` in the PATH, never the
  authority; ids contain no `@` **[R2 #2295]**.
- **C (TS resolves from containing file, not cwd):** confirmed
  (`bundlerModuleNameResolver` → `getDirectoryPath(containingFile)`) **[R3 §1]** —
  hence moving the probe path is sufficient; no custom `resolveModuleNameLiterals`.
- **D (symlink real-path harvest bug):** resolved by `preserveSymlinks: true` **[R3 §5]**.
- **E (global env override vs N workspaces):** resolved — `useEnvDirOverrides` true
  only for the default workspace; others derive purely from `root`.
- **F (ESM cache leak / shared-dep singleton):** acknowledged, accepted, documented
  (§2.3); not fixed in v1; `worker_thread`-per-workspace is the future escape hatch
  **[R3 §4, R4]**.
</content>
</invoke>
