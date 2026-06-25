# Capability system — implementation design

## 1. Summary (one paragraph)

AgentPrism gains a **capability system** so that deterministic workflow code can touch the world (Jira, GitLab, git, fs, network) without ever importing privileged code into the vm sandbox. Pure helper modules under `tools/` are **inlined verbatim into the sandbox header** by a purpose-built source transform (no esbuild — see §7), keeping the existing determinism prelude, IIFE wrap, top-level `await`/`return`, `meta` export-blanking, and the `codeLine − headerLines` source-line invariant exactly intact. World-touching **capabilities** are author-written modules that `defineCapability({ name, secrets, effects })`; they are loaded by the **host** in the trusted Node realm (real `fetch`/`fs`/`git`/`creds`), never by the sandbox. Each capability is injected into the realm as a **frozen namespace global** (e.g. `jira.getTicket(args)`), where the host binds `secrets`+`log` into a `ctx`, records every call as its own **effect node** in the run tree (args/result/duration, events + snapshot, leaving a clean replay seam), and translates recoverable failures to `null`. Workflows declare their effect surface in `meta.capabilities: string[]`, resolved **project-local `tools/` first, then user-level `~/.agentprism/tools/`** (project silently shadows user with an INFO note; an unresolved name is a hard validation ERROR). Capability signatures feed `declare const <ns>: { … }` blocks into the existing `buildWorkflowDts` pipeline (scoped by `meta.capabilities`, re-injected dynamically), the validator gains a threaded capability catalog, and the IDE surfaces a **"Shared tools" mount** plus a read-only per-secret required/present status panel — never plaintext secrets. The reference MR-review seed ships under `workflows/` + `tools/`.

## 2. Locked contracts

### 2.1 `Capability` type + `defineCapability()` — `shared/capability.ts` (create)

This is **isomorphic, metadata-only at the type level**, but capability *modules themselves* live under `tools/` and are loaded host-side. `defineCapability` is a pure identity-with-inference helper (like a typed factory); it does **not** import `node:*`. The effect author writes `(ctx, args) => result`; the workflow-facing surface is `(args) => Promise<result>`.

```ts
// shared/capability.ts  (isomorphic — NO node:* imports)

/** Anything JSON-serializable. Effect args + results MUST satisfy this
 *  (same constraint as agent() schema results — they are snapshotted/emitted). */
export type Json =
  | null | boolean | number | string
  | Json[]
  | { [k: string]: Json }

/** Host-injected context handed to every effect fn in the TRUSTED realm. */
export interface CapabilityContext {
  /** Resolved secret VALUES, keyed by the capability's declared secret names.
   *  Present only for declared names; missing/blank => undefined. Never crosses
   *  into the sandbox — the workflow body sees only (args)=>Promise<result>. */
  readonly secrets: Readonly<Record<string, string | undefined>>
  /** Structured host logger (writes to the run's acp log, redaction-safe). */
  log: (message: string, data?: Json) => void
}

/** One effect, as written by the capability author. */
export type EffectFn<A extends Json = Json, R extends Json = Json> =
  (ctx: CapabilityContext, args: A) => Promise<R> | R

/** A capability definition (the default export of a tools/<name>.ts module). */
export interface Capability {
  /** Namespace global injected into the sandbox, e.g. "jira" -> global `jira`. */
  name: string
  /** Names (NOT values) of secrets this capability needs from the host env. */
  secrets: string[]
  /** Effect functions, keyed by method name -> jira.getTicket etc. */
  effects: Record<string, EffectFn>
}

/** Identity helper that preserves inference and validates shape at author time.
 *  Pure: callable in either realm; the HOST imports the module for real.
 *  `effects` is captured as its own generic so per-effect signatures are NOT
 *  widened to the index signature — the namespace .d.ts is derived from them. */
export function defineCapability<E extends Record<string, EffectFn>>(
  cap: { name: string; secrets: string[]; effects: E },
): { name: string; secrets: string[]; effects: E } {
  if (!cap.name || !/^[A-Za-z_$][\w$]*$/.test(cap.name)) {
    throw new Error(`defineCapability: invalid namespace name "${cap.name}"`)
  }
  if (!cap.effects || Object.keys(cap.effects).length === 0) {
    throw new Error(`defineCapability("${cap.name}"): at least one effect required`)
  }
  return cap
}
```

### 2.2 Host-side effect binding (`ctx` injection + recording) — `server/workflow/run.ts` (modify)

The workflow-facing namespace is `Record<string, (args: Json) => Promise<Json>>`. The host method below is created **on the `WorkflowRun` instance** (arrow field, preserves `this`) so it can mutate the snapshot, emit, count effects, and honor `this.aborted`. It mirrors `runAgent` exactly: stack captured **synchronously at entry**, recoverable errors → `null`.

```ts
// server/workflow/run.ts  (new arrow-field method on WorkflowRun)
import type { Capability, CapabilityContext, Json } from '../../shared/capability.ts'
import type { EffectCallState } from '../../shared/events.ts'

/** Bind one capability into a frozen namespace object for the vm scope.
 *  Each effect is wrapped so the host injects ctx, records a run-tree node,
 *  and translates recoverable failures to null. */
private bindCapability = (cap: Capability, ctx: CapabilityContext): Readonly<Record<string, (args: Json) => Promise<Json | null>>> => {
  const ns: Record<string, (args: Json) => Promise<Json | null>> = {}
  for (const [method of Object.keys(cap.effects)] as unknown as [string]) { /* see runEffect below */ }
  for (const method of Object.keys(cap.effects)) {
    ns[method] = (args: Json) => this.runEffect(cap, ctx, method, args)
  }
  return Object.freeze(ns) // prevents sandbox monkey-patching of methods
}

/** The RECORDED effect — modeled 1:1 on runAgent (run.ts:442). */
private runEffect = async (
  cap: Capability,
  ctx: CapabilityContext,
  method: string,
  args: Json,
): Promise<Json | null> => {
  const stack = new Error().stack                    // capture BEFORE any await
  const line = sourceLineFromStack(stack, this.headerLines)
  if (this.aborted) throw new WorkflowAbortError()
  if (this.effectCounter >= MAX_EFFECTS_PER_RUN) throw new EffectLimitError(MAX_EFFECTS_PER_RUN)
  this.effectCounter++
  const callIndex = this.effectCounter
  const id = `e${callIndex}-${shortid()}`
  const phaseTitle = this.currentPhase || (this.snapshot.phases[0]?.title ?? 'main')
  const state: EffectCallState = {
    id, callIndex, capability: cap.name, method,
    phase: phaseTitle, line,
    args, status: 'running', startedAt: Date.now(),
  }
  this.effectMap.set(id, state)
  this.snapshot.effects.push(state)
  this.ensurePhase(phaseTitle).effectIds.push(id)
  this.emit({ type: 'effect:started', effect: state })
  this.logAcp('info', 'effect_start', `↯ ${cap.name}.${method}`, undefined, undefined)
  try {
    const result = (await cap.effects[method](ctx, args)) as Json
    state.result = result
    state.status = 'ok'
    state.finishedAt = Date.now()
    this.emit({ type: 'effect:finished', effectId: id, status: 'ok', result, durationMs: state.finishedAt - state.startedAt! })
    this.logAcp('info', 'effect_done', `↯ ${cap.name}.${method} ✓`)
    return result
  } catch (err) {
    if (isNonRecoverable(err)) throw err              // abort/limit/budget propagate
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
    state.finishedAt = Date.now()
    this.emit({ type: 'effect:finished', effectId: id, status: 'error', error: state.error, durationMs: state.finishedAt - state.startedAt! })
    this.logAcp('warn', 'effect_fail', `↯ ${cap.name}.${method} failed: ${state.error}`)
    return null                                       // recoverable => null (like runAgent)
  }
}
```

### 2.3 Sandbox injection point — `server/workflow/executor.ts` (modify)

The `SandboxHost` gains a `capabilities` field (the already-bound, frozen namespaces). `buildSandboxGlobals` injects each namespace as a realm global **after** the primitive/value loop. **No `bindPrimitive`/`bindValue` switch is touched** (they would `throw` on unknown names), so existing runs are untouched.

```ts
// server/workflow/executor.ts
import type { Json } from '../../shared/capability.ts'

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
}

// inside buildSandboxGlobals, immediately AFTER the primitive/value loop (after line 105):
for (const [ns, obj] of Object.entries(host.capabilities)) {
  if (ns in scope) throw new Error(`capability namespace "${ns}" collides with a DSL global`)
  scope[ns] = obj            // live host reference; vm.createContext contextifies in place
}
```

### 2.4 Resolution result + resolver (project>user, shadow note, qualifier parse) — `shared/capability-resolve.ts` (create)

```ts
// shared/capability-resolve.ts  (isomorphic — NO node:* imports)
import type { CapabilityCatalogEntry } from './protocol.ts'

export type CapabilityTier = 'project' | 'user'

/** Parsed qualifier from a meta.capabilities entry. */
export interface ParsedCapabilityRef {
  /** 'user' forced by `user:` or `@me/`; 'project' forced by `project:`; null = bare. */
  scope: CapabilityTier | null
  /** Namespace name with the qualifier stripped. */
  bareName: string
}

/** Parse `user:jira`, `@me/jira`, `project:jira`, or bare `jira`. */
export function parseCapabilityRef(raw: string): ParsedCapabilityRef {
  if (raw.startsWith('user:'))    return { scope: 'user',    bareName: raw.slice(5).trim() }
  if (raw.startsWith('@me/'))     return { scope: 'user',    bareName: raw.slice(4).trim() }
  if (raw.startsWith('project:')) return { scope: 'project', bareName: raw.slice(8).trim() }
  return { scope: null, bareName: raw.trim() }
}

export interface CapabilityResolution {
  /** The original meta.capabilities entry (with qualifier). */
  ref: string
  bareName: string
  /** Which tier actually resolved, or null if unresolved. */
  resolved: CapabilityTier | null
  /** True when BOTH tiers define bareName and project won (drives the INFO note). */
  shadowsUser: boolean
}

/** A flat, isomorphic view of what each tier offers — built server-side from
 *  scanned dirs, fetched browser-side from /api/capabilities. */
export interface CapabilityCatalog {
  project: Record<string, CapabilityCatalogEntry>  // bareName -> entry
  user: Record<string, CapabilityCatalogEntry>
}

/** Resolve a single meta.capabilities entry. Project wins on shadow. */
export function resolveCapability(catalog: CapabilityCatalog, raw: string): CapabilityResolution {
  const { scope, bareName } = parseCapabilityRef(raw)
  const inProject = bareName in catalog.project
  const inUser = bareName in catalog.user
  let resolved: CapabilityTier | null = null
  if (scope === 'project') resolved = inProject ? 'project' : null
  else if (scope === 'user') resolved = inUser ? 'user' : null
  else resolved = inProject ? 'project' : inUser ? 'user' : null   // bare: project-first
  return { ref: raw, bareName, resolved, shadowsUser: resolved === 'project' && inUser && scope === null }
}
```

### 2.5 Catalog entry (name, tier, secrets, dts) — `shared/protocol.ts` (modify)

```ts
// shared/protocol.ts  (isomorphic DTO — alongside WorkflowFileInfo / AgentsResponse)

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
  /** Ambient `declare const <name>: { ... }` body, derived server-side from the
   *  effect signatures (server/workflow/derive-capability-dts.ts); '' for loose. */
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
```

REST endpoint shape — `GET /api/capabilities` → `200 application/json`:

```jsonc
// CapabilitiesResponse
{
  "capabilities": [
    {
      "name": "jira", "tier": "project", "path": "/abs/tools/jira.ts", "modifiedAt": 1719000000000,
      "secrets": ["JIRA_TOKEN", "JIRA_BASE_URL"],
      "secretStatus": { "JIRA_TOKEN": { "present": true }, "JIRA_BASE_URL": { "present": false } },
      "methods": ["getTicket"],
      "dts": "getTicket(args: { key: string }): Promise<{ key: string; acceptanceCriteria: string[] } | null>;"
    }
  ]
}
```

### 2.6 New `RunEvent` variant + effect run-state — `shared/events.ts` (modify)

```ts
// shared/events.ts
export type EffectCallStatus = 'running' | 'ok' | 'error'

export interface EffectCallState {
  id: string
  callIndex: number
  capability: string
  method: string
  phase: string
  /** 1-based source line of the <ns>.<method>() call, when known. */
  line?: number
  /** JSON-serializable args as passed (snapshotted; redacted of nothing — secrets never flow here). */
  args: unknown
  /** JSON-serializable result (present when status==='ok'). */
  result?: unknown
  error?: string
  status: EffectCallStatus
  startedAt?: number
  finishedAt?: number
}

// PhaseState gains a sibling id list:
export interface PhaseState {
  title: string
  detail?: string
  agentIds: string[]
  effectIds: string[]          // NEW — effects grouped under the phase, like agentIds
}

// RunSnapshot gains:
//   effects: EffectCallState[]   // NEW, initialized [] in WorkflowRun constructor

// RunEvent union gains two variants:
export type RunEvent =
  // …existing…
  | { type: 'effect:started'; effect: EffectCallState }
  | { type: 'effect:finished'; effectId: string; status: 'ok' | 'error'; result?: unknown; error?: string; durationMs: number }
```

### 2.7 `validateWorkflow()` signature change — `shared/validate.ts` (modify)

Fourth optional positional arg (keeps the 11 existing call sites compiling). `DiagnosticSeverity` widened to add `'info'`.

```ts
// shared/validate.ts
import type { CapabilityCatalog } from './capability-resolve.ts'

export type DiagnosticSeverity = 'error' | 'warning' | 'info'   // widened

export function validateWorkflow(
  rawSource: string,
  selectedAgentId?: AcpAgentId,
  connectedAgentIds?: AcpAgentId[],
  capabilityCatalog?: CapabilityCatalog,        // NEW — undefined => skip resolution (graceful)
): ValidateResult
```

`ok = diagnostics.every(d => d.severity !== 'error')` is unchanged: `'info'` shadow notes never flip `ok`; an unresolved capability is pushed as `'error'`.

## 3. File-by-file plan

> One agent per file; no two items edit the same file.

1. **`shared/capability.ts`** — create — owns the `Capability`/`CapabilityContext`/`EffectFn`/`Json` types + `defineCapability()` helper — dependsOn [] — add the §2.1 block verbatim; export everything; no node imports.

2. **`shared/capability-resolve.ts`** — create — owns qualifier parsing + project>user resolver + `CapabilityCatalog` type — dependsOn [`shared/protocol.ts`] — add §2.4 verbatim.

3. **`shared/protocol.ts`** — modify — owns the REST DTOs `CapabilityCatalogEntry` + `CapabilitiesResponse` — dependsOn [] — append the §2.5 interfaces next to `WorkflowFileInfo`/`AgentsResponse`; no other edits.

4. **`shared/events.ts`** — modify — owns `EffectCallState`, `effectIds` on `PhaseState`, `effects` on `RunSnapshot`, the two `effect:*` `RunEvent` variants — dependsOn [] — add §2.6 blocks; do not touch agent shapes.

5. **`shared/dsl.ts`** — modify — owns the `capabilities?: string[]` field on `WorkflowMeta` — dependsOn [] — add the field after `config?` with a JSDoc noting `user:`/`@me/`/`project:` qualifiers.

6. **`shared/validate.ts`** — modify — owns the meta shape-check for `capabilities`, the AST-based per-element resolution + diagnostics, the `DiagnosticSeverity` widening, the signature change — dependsOn [`shared/capability-resolve.ts`, `shared/dsl.ts`] — (a) widen `DiagnosticSeverity` to add `'info'`; (b) in `validateMeta`, add the `capabilities must be string[]` / non-empty-string shape block alongside the `phases` check; (c) add the 4th param; (d) in `validateWorkflow`, after `evaluateLiteral` succeeds, walk `init.properties` for the `capabilities` property's `ArrayExpression`, and for each string-literal element call `resolveCapability(catalog, value)` — push `diagAt(elementNode, 'capability "<name>" does not resolve', 'error')` when `resolved===null` (skip entirely if `capabilityCatalog` is undefined), and `diagAt(elementNode, 'jira -> ./tools, shadowing Shared tools', 'info')` when `shadowsUser`. **Do resolution here, not in `validateMeta`** (needs AST loc + catalog).

7. **`shared/dsl-registry.ts`** — modify — owns nothing new structurally (NO capability descriptor is added to `DSL_METHODS`; capability namespaces are NOT registry globals) — dependsOn [] — **export a new `CAPABILITY_RESERVED_NAMES = new Set(Object.keys(DSL_METHOD_MAP))`** helper so the validator + dts builder can reject a capability name colliding with a DSL global. This is the only change.

8. **`server/config.ts`** — modify — owns the tier dir config `PROJECT_TOOLS_DIR`, `USER_TOOLS_DIR`, ordered `CAPABILITY_DIRS` — dependsOn [] — add `PROJECT_TOOLS_DIR = path.join(process.cwd(),'tools')`, `USER_TOOLS_DIR = path.join(HOME,'.agentprism','tools')`, `export const CAPABILITY_DIRS: { dir: string; tier: 'project'|'user' }[]` (project first), overridable via `AGENTPRISM_TOOLS_DIR`.

9. **`server/store/capabilities.ts`** — create — owns the **cheap, safe** filesystem scan (no import) — dependsOn [`server/config.ts`] — `scanCapabilityFiles(): Promise<{ name, path, tier, modifiedAt }[]>` mirroring `listWorkflows`: mkdir -p each tier dir, readdir for `*.ts`/`*.js`/`*.mjs`, `safeName`-style guard + `realpath` containment check, dedupe by bareName (project wins). Export this; **no `import()` here**.

10. **`server/workflow/capability-loader.ts`** — create — owns host-side module loading + catalog build — dependsOn [`server/store/capabilities.ts`, `shared/capability.ts`, `shared/protocol.ts`] — `loadCapabilities(env: NodeJS.ProcessEnv): Promise<{ catalog: CapabilityCatalog; entries: CapabilityCatalogEntry[]; modules: Map<string, Capability> }>`: for each scanned file `await import(pathToFileURL(file).href + '?v=' + mtime)` (cache-bust under `tsx watch`), read `default` (validated against `Capability` shape with a Zod schema), compute `secretStatus` from `env`, capture per-module `loadError` without crashing the scan. Provide `getCapabilityModules(names: string[]): Map<string, Capability>` resolving via `resolveCapability` so the run loads only declared+resolved namespaces.

11. **`server/workflow/executor.ts`** — modify — owns the `SandboxHost.capabilities` field + the namespace injection loop — dependsOn [`shared/capability.ts`] — add the §2.3 field and the post-primitive injection loop with the collision guard. **Do not touch `bindPrimitive`/`bindValue`.**

12. **`server/workflow/inline.ts`** — create — owns the **pure-helper inlining transform** (the esbuild replacement) — dependsOn [`server/config.ts`] — `inlineHelpers(normalizedSource, opts): { source: string; headerBindings: string }`. It: (1) parses with acorn (`sourceType:'module'`, `allowAwaitOutsideFunction`, `allowReturnOutsideFunction`); (2) for each top-level `ImportDeclaration` whose specifier resolves under `PROJECT_TOOLS_DIR`/`USER_TOOLS_DIR` **to a pure helper** (not a `defineCapability` default export, not a node builtin → else throw a load error), transpiles the helper to an import-free string and emits a header binding `const { x, y } = (() => { <helper> ; return { x, y }; })();` (single logical line); (3) **blanks each import line in place with spaces of equal length, preserving newlines** so body line offsets are unchanged; (4) returns the blanked body + the concatenated single-line header bindings. **Reject** a specifier resolving to a capability module (`defineCapability` default export) or a node builtin with a clear error. Verified working in §1/§7.

13. **`server/workflow/instrument.ts`** — modify — owns composing the header so `headerLines` is **computed from the actual emitted prefix** — dependsOn [`server/workflow/inline.ts`] — change `instrumentWorkflow(normalizedSource, headerBindings = '')`: keep the existing `export` blanking; build `header = DETERMINISM_PRELUDE + '\n' + (headerBindings ? headerBindings + '\n' : '') + WRAP_OPEN`; set `headerLines = (header.match(/\n/g) ?? []).length` (already dynamic — just now includes the binding lines). The `codeLine − headerLines` mapping in `sourceLineFromStack` is untouched and stays correct (verified: `agent()` lands on the right body line with helpers present).

14. **`server/workflow/run.ts`** — modify — owns `bindCapability`/`runEffect`, the `effects`/`effectMap`/`effectCounter` run state, threading `host.capabilities` through `hostHooks()`, building `CapabilityContext` from resolved modules + secrets, calling `inlineHelpers` before `instrumentWorkflow`, passing the catalog to `validateWorkflow` — dependsOn [`server/workflow/capability-loader.ts`, `server/workflow/inline.ts`, `server/workflow/instrument.ts`, `server/workflow/executor.ts`, `shared/capability.ts`, `shared/events.ts`] — (a) add §2.2 methods + state; init `snapshot.effects=[]`; (b) in the constructor, load resolved capability modules for `meta.capabilities` and build `secrets` from `process.env` layered most-specific-wins; (c) in `hostHooks()`, set `capabilities: Object.fromEntries(modules.map(([ns,cap]) => [ns, this.bindCapability(cap, ctxFor(cap))]))`; (d) where the body is instrumented today, call `const { source, headerBindings } = inlineHelpers(normalized, …)` then `instrumentWorkflow(source, headerBindings)`; (e) thread the catalog into both `validateWorkflow(script, this.request.agent, undefined, catalog)` calls (lines 593, 661); (f) in `finishRun`, count effects into `RunStats` if extended. Secrets MUST NOT enter `snapshot`/`log`/events.

15. **`server/index.ts`** — modify — owns `GET /api/capabilities` — dependsOn [`server/workflow/capability-loader.ts`, `shared/protocol.ts`] — add the route returning `CapabilitiesResponse` (metadata only — strip effect fns); keep the static fallback regex excluding `/api`; pass the catalog into the existing `POST /api/validate` (`validateWorkflow(source, undefined, undefined, catalog)`).

16. **`src/lib/api.ts`** — modify — owns `fetchCapabilities()` — dependsOn [`shared/protocol.ts`] — add `export const fetchCapabilities = (): Promise<CapabilitiesResponse> => get('/api/capabilities')` mirroring `fetchAgents`.

17. **`src/lib/workflow-dts.ts`** — modify — owns capability `declare const <ns>` dts generation scoped by `meta.capabilities` — dependsOn [`shared/protocol.ts`, `shared/capability-resolve.ts`] — add a `capabilities?: CapabilityCatalogEntry[]` param to `buildWorkflowDts`; for each entry build `declare const <name>: {\n<dts || '[method: string]: (args: any) => Promise<any>'>\n};` and append to the join array **after** `DSL_METHODS.map(m=>m.dts)`; guard against names in `CAPABILITY_RESERVED_NAMES`. Add `capabilities?: string[]` to the editor-facing `WorkflowMeta` in `PREAMBLE`.

18. **`src/store/useStore.ts`** — modify — owns capability/secret/tool-file store state + threading the catalog into all `validateWorkflow` calls + rebuilding dts on `meta.capabilities` change — dependsOn [`src/lib/api.ts`, `src/lib/workflow-dts.ts`, `shared/capability-resolve.ts`, `shared/events.ts`] — (a) add `capabilities: CapabilityCatalogEntry[]`, derived `capabilityCatalog: CapabilityCatalog`, `refreshCapabilities()`; (b) call `fetchCapabilities()` in `init()` beside `fetchAgents()`; (c) pass `capabilityCatalog` as the 4th arg at all 8 `validateWorkflow` sites; (d) rebuild dts via `buildWorkflowDts(connectedAgents, defaultAgent, scopedCapabilityEntries)` and `updateWorkflowDts` whenever `validation.meta?.capabilities` changes; (e) seed `effects: []` in `newSnapshot`; (f) reduce `effect:started`/`effect:finished` by upserting into `snapshot.effects` keyed by `effectId` (mirror `agent:*`).

19. **`src/features/run/RunConfig.tsx`** — modify — owns the read-only Secrets-status panel + Capabilities panel — dependsOn [`src/store/useStore.ts`] — render a `SecretsPanel` between Manual approvals and `<MethodConfig/>`: for each declared secret of each used capability, a row with name + required/present Badge (green check / amber warning). **Read-only — never an Input.** Add a collapsible Capabilities panel (name, resolved tier, shadow note) reusing the `MethodConfig` collapsible pattern.

20. **`src/features/files/FileSidebar.tsx`** — modify — owns the two new tool sections (project "Tools" + user "Shared tools") — dependsOn [`src/store/useStore.ts`] — add two sibling sections after the Workflows ScrollArea, partitioned by `tier`, each opening a tool file (read-only-aware). Add a small non-portable hint when the active workflow uses a `user`-tier capability.

21. **`src/features/run/RunTree.tsx`** (or the existing run-tree component) — modify — owns rendering effect nodes under phases — dependsOn [`src/store/useStore.ts`, `shared/events.ts`] — render `snapshot.effects` grouped by `phase.effectIds` as sibling nodes to agents (capability.method, args/result preview, duration). If grouping is centralized elsewhere, that file is the owner instead — assign exactly one.

## 4. Contract gate (barrier — implement FIRST)

These compile-against-able shared types/helpers must land and typecheck before any consumer fans out:

1. `shared/capability.ts` (§2.1)
2. `shared/protocol.ts` additions (§2.5)
3. `shared/capability-resolve.ts` (§2.4) — depends on #2
4. `shared/events.ts` additions (§2.6)
5. `shared/dsl.ts` `meta.capabilities` field
6. `shared/dsl-registry.ts` `CAPABILITY_RESERVED_NAMES`

After these six typecheck (`npx tsc -p tsconfig.json --noEmit`), the remaining 15 files in §3 fan out one-agent-per-file with no cross-file edit conflicts. `server/workflow/inline.ts` + `server/workflow/instrument.ts` are the runtime barrier for the executor path and should land before `server/workflow/run.ts` is wired (run.ts imports both).

## 5. Seed files

**`tools/jira.ts`** (project-tier capability):

```ts
// tools/jira.ts
import { defineCapability } from '../shared/capability.ts'

export default defineCapability({
  name: 'jira',
  secrets: ['JIRA_TOKEN', 'JIRA_BASE_URL'],
  effects: {
    async getTicket(ctx, args: { key: string }) {
      const base = ctx.secrets.JIRA_BASE_URL
      if (!base) { ctx.log('JIRA_BASE_URL missing'); return null }
      const res = await fetch(`${base}/rest/api/3/issue/${args.key}`, {
        headers: { Authorization: `Bearer ${ctx.secrets.JIRA_TOKEN}` },
      })
      if (!res.ok) { ctx.log(`jira ${res.status}`); return null }
      const j = await res.json() as { fields: { description?: string; customfield_ac?: string[] } }
      return { key: args.key, acceptanceCriteria: j.fields.customfield_ac ?? [] }
    },
  },
})
```

The injected-namespace `.d.ts` (`jira.getTicket(args: { key: string }): Promise<{ key: string; acceptanceCriteria: string[] } | null>`) is **derived from this effect's signature** at load time — no hand-written `dts` (see §6 In).

**`tools/gitlab.ts`** (project-tier capability — abbreviated): `name: 'gitlab'`, `secrets: ['GITLAB_TOKEN','GITLAB_BASE_URL']`, effects `getMrComments(ctx,{ project, mr })` and `getMrDiff(ctx,{ project, mr })`, each returning JSON-serializable shapes.

**`tools/git.ts`** (project-tier capability): `name: 'git'`, `secrets: []`, effect `checkoutWorktree(ctx, { repo, ref })` returning `{ worktree: string }` (host-side `git worktree add` into a temp dir).

**`tools/mr-prompt.ts`** (PURE helper — inlined, not a capability):

```ts
// tools/mr-prompt.ts  — pure, no defineCapability, no world access
export function buildReviewPrompt(input: {
  acceptanceCriteria: string[]; comments: string[]; diff: string
}): string {
  return [
    'Review this merge request against its acceptance criteria.',
    'ACCEPTANCE CRITERIA:', ...input.acceptanceCriteria.map(c => `- ${c}`),
    'REVIEWER COMMENTS:', ...input.comments.map(c => `- ${c}`),
    'DIFF:', input.diff,
    'Return JSON: { approved: boolean, blocking: string[], notes: string[] }.',
  ].join('\n')
}
```

**`workflows/mr-review.js`** (seed workflow):

```js
export const meta = {
  name: 'mr-review',
  description: 'Review a GitLab MR against Jira acceptance criteria with one agent pass.',
  capabilities: ['jira', 'gitlab', 'git'],
}
import { buildReviewPrompt } from '../tools/mr-prompt.ts'

phase('Gather context')
const ticket = await jira.getTicket({ key: args.jiraKey })
const comments = await gitlab.getMrComments({ project: args.project, mr: args.mr })
const diff = await gitlab.getMrDiff({ project: args.project, mr: args.mr })
const { worktree } = await git.checkoutWorktree({ repo: args.repo, ref: args.ref })

phase('Review')
const prompt = buildReviewPrompt({
  acceptanceCriteria: ticket?.acceptanceCriteria ?? [],
  comments: comments ?? [],
  diff: diff ?? '',
})
const review = await agent(prompt, {
  cwd: worktree,
  schema: { type: 'object', properties: {
    approved: { type: 'boolean' },
    blocking: { type: 'array', items: { type: 'string' } },
    notes:    { type: 'array', items: { type: 'string' } },
  }, required: ['approved', 'blocking', 'notes'] },
})

phase('Write result')
return review
```

This seed exercises all four hard-blocker fixes simultaneously: top-level `await`, top-level `return`, `import` of a pure helper, and `export const meta` — all verified runnable in §1/§7 (the `agent()` call's reported source line is correct **with the import present**).

## 6. Scope

**In:**
- `defineCapability` modules under `tools/` (project) + `~/.agentprism/tools/` (user "Shared tools" mount).
- Host-side trusted loading via `import()` (tsx loader), `ctx`={secrets,log} injection, frozen namespace injection into the vm scope.
- Per-effect recorded run-tree nodes (args/result/duration), `effect:*` events, snapshot, acp log lines; recoverable→`null`.
- `meta.capabilities` declaration; project>user resolution; shadow INFO note; unresolved ERROR.
- Secrets from `process.env` (project override > user default), names declared per capability; UI required/present status only.
- Capability `declare const <ns>` dts scoped by `meta.capabilities`, dynamically re-injected.
- Pure-helper inlining transform replacing esbuild; determinism prelude + IIFE + return-capture + source-line mapping preserved.
- `GET /api/capabilities`, `fetchCapabilities()`, two IDE tool-file sections, Secrets/Capabilities run panels.
- **Auto-derived namespace types** — each capability's `declare const <ns>: { … }` is derived from the effect function signatures via the TS compiler API (`server/workflow/derive-capability-dts.ts`): a synthetic module applies an `InjectedNamespace` mapped type that drops `ctx` and wraps every return in `Promise<Awaited<R>>`; the checker prints the structural type. Cached by path+mtime. No hand-written `dts`.
- **Tool-file editing in the IDE** — capability `.ts` modules open/edit/save in the Monaco editor (`GET`/`PUT /api/tools/:tier/:name`), with the relative `../shared/capability.ts` import resolved to real types in-editor.

**Out (deferred — seams left, not built):**
- Durable replay journal (effects are recorded/journaled, not replayed; `callIndex` keys the future read-side).
- MCP-as-capability unification.
- npm-pack/published-signed third tier (the "Shared tools" mount is the seed catalog).
- Keychain/encrypted secret storage + any UI secret entry (presence booleans only, ever).
- Capability side-effect sandboxing / network allowlists beyond `MAX_EFFECTS_PER_RUN` + `this.aborted`.

## 7. Open issues / risks

1. **Inlining transform (esbuild dropped) — RESOLVED & verified.** The prior draft's "bundle then instrument" deadlocked: esbuild rejects top-level `await` (cjs), top-level `return` (esm+cjs), and emits a trailing `export {}`. The locked approach (`server/workflow/inline.ts`) never feeds the body to a module bundler: it **blanks `import` lines in place** (preserving newlines) and injects each pure helper as a **single-line header binding** (`const { x } = (()=>{…;return {x}})()`) into the determinism-prelude header, *before* the existing IIFE wrap. I empirically ran the real determinism prelude + `meta` export-blanking + import-blanking + helper header-injection + IIFE against the seed (await + return + import together): RESULT correct, prelude active, and the `agent()` call's source line mapped to **exactly the right body line**. `headerLines` is computed from the emitted header, not hardcoded.

2. **Source-line invariant — RESOLVED.** Because imports are blanked in place and helpers occupy only header lines, `codeLine − headerLines` is unchanged for the body. **Action item:** add a regression test asserting an `agent()` call's reported `sourceLine` is identical with vs without a pure import present (§3 item 13/14 owner).

3. **`meta` export + ESM syntax in the vm — RESOLVED.** No bundler runs, so `ast.body[0]` is still `export const meta`; the existing blanking applies unchanged, and no trailing `export {}` is ever emitted. `vm.Script` sees plain script.

4. **Secret leakage.** `snapshot`/`log`/`RunEvent` are broadcast to all WS clients. `EffectCallState.args`/`result` are JSON-snapshotted — capability authors must not echo secrets into results, and `ctx.secrets` must never be passed into `args`. Mitigation: secrets live only in the host-closure `ctx`; `secretStatus` carries booleans only; reviewer guidance in the `tools/` author doc. **Residual risk:** a malicious user-tier capability runs with full Node privileges (network/fs) — this is the documented trust gradient, not closed in MVP.

5. **tsx ESM cache.** `import()` of an edited capability won't reload under `tsx watch` without cache-busting; loader appends `?v=mtime`. A future plain-`node` start (no tsx) cannot import `.ts` capabilities — documented constraint.

6. **Validator/dts drift.** Browser catalog (from `/api/capabilities`) can be staler than the server's run-time scan; the run-side `validateWorkflow` (run.ts:593/661) is authoritative. Capability names colliding with DSL globals are rejected by `CAPABILITY_RESERVED_NAMES` in both the dts builder and the executor injection guard.

7. **Effect ordering & replay seam.** `parallel()` makes invocation order nondeterministic; effects are keyed by `callIndex` + source line (not invocation order) so a future replay read-side can match recorded outputs to call sites. No replay engine is built (`checkpointFn` still auto-resolves; effects are journaled, not replayed).

Key file paths: `/home/vikash/prism-editor-web/shared/capability.ts`, `/home/vikash/prism-editor-web/shared/capability-resolve.ts`, `/home/vikash/prism-editor-web/server/workflow/inline.ts`, `/home/vikash/prism-editor-web/server/workflow/capability-loader.ts`, `/home/vikash/prism-editor-web/server/workflow/run.ts`, `/home/vikash/prism-editor-web/server/workflow/instrument.ts`, `/home/vikash/prism-editor-web/server/workflow/executor.ts`.

---

## 8. Corrections folded in — MANDATORY (from adversarial feasibility round 3)

These four fixes OVERRIDE the corresponding text above. The implementing agent for each owning file MUST apply them.

### C1 — `CAPABILITY_RESERVED_NAMES` (item 7, item 17)
The §3 item 7 definition `new Set(Object.keys(DSL_METHOD_MAP))` is WRONG: `DSL_METHOD_MAP` is a JS `Map`, and `Object.keys(map)` returns `[]`, leaving the collision guard EMPTY. A capability named `agent`/`args`/`cwd`/`budget`/`phase` etc. would then emit a second top-level ambient `declare` and SILENTLY void all DSL intellisense (semantic validation is off in monaco-setup.ts).
- Use `export const CAPABILITY_RESERVED_NAMES = new Set(DSL_METHODS.map(m => m.name))` (covers every injected global, incl. value-kind `args`/`cwd`/`budget`). Also defensively include core JS globals: add `["Math","JSON","Date","Promise","Object","Array","globalThis","process","console"]`.
- ENFORCE it in `buildWorkflowDts` (item 17): when emitting each `declare const <ns>`, SKIP (or throw) any capability whose name is in `CAPABILITY_RESERVED_NAMES` — do not rely only on the runtime executor guard.
- Add a unit test: feeding a capability named `args` through `buildWorkflowDts` must NOT produce a duplicate `declare const args`.

### C2 — malformed loop in `bindCapability` (item 14 / §2.2)
The §2.2 code block contains a dead, non-parsing first loop: `for (const [method of Object.keys(cap.effects)] as unknown as [string]) { /* … */ }`. DELETE it entirely. Keep only:
```ts
const ns: Record<string, (args: Json) => Promise<Json | null>> = {}
for (const method of Object.keys(cap.effects)) ns[method] = (args) => this.runEffect(cap, ctx, method, args)
return Object.freeze(ns)
```

### C3 — `effectIds` must be OPTIONAL (§2.6, items 14/18/21)
Making `effectIds: string[]` REQUIRED on `PhaseState` breaks unpatched construction sites (run.ts:343 `ensurePhase`, run.ts:688 meta.phases map, client `newSnapshot`, store reducer) → TS errors + `undefined.push` crash.
- Declare `effectIds?: string[]` OPTIONAL in `shared/events.ts`.
- At EVERY push site use `(phase.effectIds ??= []).push(id)`.
- Apply the same optional-with-`??=` discipline to any other new array field, so no construction site beyond the enumerated owners must change.

### C4 — `inline.ts` discrimination must be IMPORT-FREE and TRANSITIVE (item 12)
How `inline.ts` decides "this `tools/` import is a capability → REJECT" vs "pure helper → inline" must NOT import/execute the target (that would run privileged module top-level). Instead:
- Statically `acorn`-parse each resolved `tools/` target (do NOT `import()` it).
- REJECT if it has a default export that is a `defineCapability(...)` CallExpression.
- REJECT any `node:` or bare-package specifier.
- RECURSE the same static check over each pure helper's own imports — a helper may import ONLY other pure-helper `tools/` files; no node builtins, no capabilities — so a transitively-privileged import cannot sneak in.
- Add a regression fixture: a workflow importing `tools/jira.ts` (a capability) is REJECTED with a clear error, alongside the source-line fixture.

### General note
This is the riskiest file set: `server/workflow/inline.ts` + `server/workflow/instrument.ts` must be tested together against the `workflows/mr-review.js` seed (top-level `await` + top-level `return` + pure `import` + `export const meta` together), asserting an `agent()` call's reported source line is identical with vs without the import present. Ensure `validateWorkflow` still passes for a workflow whose `export const meta` is followed by top-level `import` of a pure helper.
