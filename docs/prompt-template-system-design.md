# Prompt-template system — implementation design

## 1. Summary

AgentPrism's **prompt-template system** is the *declarative sibling* of the just-shipped **capability system**. Where a capability is the declarative counterpart of a host-bound, secret-aware, recorded *effect* (`tools/jira.ts` → `jira.getTicket(args)`), a **prompt template** is the declarative counterpart of a pure-helper prompt builder like `tools/mr-prompt.ts`'s `buildReviewPrompt()`. A template is a Handlebars `.hbs` file with an our-convention frontmatter block declaring its typed parameters; it is **compiled host-side**, injected into the vm sandbox as a **pure namespace global** `prompts.<name>(data) => string`, and rendered identically in a browser **live-preview** pane.

The system **mirrors the capability scaffolding file-for-file** — two-tier storage (`prompts/` + `~/.agentprism/prompts/`), project-shadows-user resolution with `user:`/`@me/`/`project:` qualifiers, a catalog DTO, a REST endpoint, `meta.prompts: string[]` declaration + AST validation, dts emission, and a sidebar section — and **diverges only where prompts are fundamentally simpler**: pure render, **no secrets, no effect-recording, no run-tree node, no abort/ceiling plumbing, no `ctxFor`/`runEffect`**. A prompt cannot fail the way an effect can; its bind is `(data) => render(template, data)`.

**Resolution of the amendment-round-2 blockers (LOCKED — Option A).** All six hard blockers share one root cause: the proposed `mr-review.hbs` filename is not a valid JS identifier, forcing a `toMethodName` camelCase transform that the contract blocks never actually threaded, producing a name that disagrees across inject/dts/resolve and breaks `{{> partial}}` composition. We **eliminate the transform entirely**:

- **`isSafePromptFileName` requires the bareName to match the same identifier regex capabilities use** — `/^[A-Za-z_$][\w$]*$/` — so `mr-review.hbs` is **rejected** and the reference seed becomes **`prompts/mrReview.hbs`**. Exactly as with capabilities, `bareName === injected key === dts member === catalog key === partial name === the JS-visible name`, with **no transform anywhere**. The seed workflow's `prompts.mrReview(...)` call and `meta.prompts: ['mrReview']` declaration now match the filename directly.
- **`toMethodName` is DELETED from the design.** It appears in no contract, no gate, no file. (This honors the amendment fix-2a / fix "DELETE the §5 toMethodName decision entirely".)
- **Partials register and resolve under identifier names** (`{{> mrReview}}`, `{{> partialCriteria}}`) — no hyphen, so Handlebars' unquoted partial-path parsing works unchanged; no bracket syntax needed. The seed `_partial`-style file becomes **`prompts/criteriaList.hbs`**, invoked `{{> criteriaList}}`.
- **Render parity is byte-identical, not degraded.** `PromptCatalogEntry` carries the **full `body`** (prompt bodies are non-sensitive by design); the preview registers **full bodies** as partials, so `{{> partial}}` renders the same string the server produces. The `preview` field is a hover-tooltip snippet only and is **never** a render input — this removes the mid-block-truncation parse-failure risk and honors the locked "preview renders IDENTICALLY to production" decision.

The result is additive and parallel: the capability system is untouched end-to-end, the vm determinism prelude is untouched (Handlebars render is pure by construction), and the only shared edits are append-only (one reserved name, one `meta` field, one validate branch, one dts append, one Monaco import).

---

## 2. Locked contracts

Every block below is real, compilable TypeScript with its target file named. `Json` is reused from `shared/capability.ts` (no second JSON type).

### 2.1 Frontmatter schema + parser — `shared/prompt-frontmatter.ts` (NEW, isomorphic)

Our-convention frontmatter: a leading `---\n…\n---` YAML-or-JSON fence declaring the template's parameters. Parsed and stripped **before** `Handlebars.compile(body)`. To stay dependency-free and byte-identical on server and client, we parse the block as **JSON** (a tiny hand-rolled split + `JSON.parse`), validated with the project's existing `zod@4`. Param types are a **closed, flat scalar/array enum** so dts generation is total (the only genuinely new transform, kept trivially total per the inject-lens risk).

```ts
// shared/prompt-frontmatter.ts  (isomorphic — NO node:* imports)
import { z } from 'zod'
import type { Json } from './capability.ts'

/** Closed set of declarable param types. Flat by design so paramsToTsType is total
 *  and dts emission can never produce an open/un-typed member. */
export const PROMPT_PARAM_TYPES = [
  'string', 'number', 'boolean',
  'string[]', 'number[]', 'boolean[]',
] as const
export type PromptParamType = (typeof PROMPT_PARAM_TYPES)[number]

/** One declared parameter (name + type, optional default/example/description). */
export interface PromptParam {
  name: string
  type: PromptParamType
  description?: string
  /** Seeds live-preview sample data + workflow-facing default. Must match `type`. */
  default?: Json
  /** Optional explicit preview sample, overriding the type-derived default. */
  example?: Json
}

/** Parsed result of one .hbs file: typed params + the Handlebars body (frontmatter stripped). */
export interface ParsedPrompt {
  params: PromptParam[]
  /** The Handlebars template source with the frontmatter fence removed. */
  body: string
}

const paramSchema = z.object({
  name: z.string().regex(/^[A-Za-z_$][\w$]*$/, 'param name must be an identifier'),
  type: z.enum(PROMPT_PARAM_TYPES),
  description: z.string().optional(),
  default: z.unknown().optional(),
  example: z.unknown().optional(),
}) satisfies z.ZodType<PromptParam>

const frontmatterSchema = z.object({
  params: z.array(paramSchema).default([]),
})

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/**
 * Split a .hbs source into { params, body }. The frontmatter is a leading
 * `---\n<json>\n---` fence whose JSON body has shape { params: PromptParam[] }.
 * Never throws: a missing/blank fence yields zero params; a malformed fence is
 * reported via `error` so the live preview degrades gracefully (warn-don't-reject).
 */
export function parsePrompt(source: string): ParsedPrompt & { error?: string } {
  const m = FENCE.exec(source)
  if (!m) return { params: [], body: source }
  const body = source.slice(m[0].length)
  try {
    const raw = JSON.parse(m[1]) as unknown
    const parsed = frontmatterSchema.parse(raw)
    return { params: parsed.params, body }
  } catch (err) {
    return { params: [], body, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Seed sample data for the live preview from the declared params:
 *  example ?? default ?? a type-derived placeholder. Deterministic. */
export function seedSampleData(params: PromptParam[]): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const p of params) {
    if (p.example !== undefined) { out[p.name] = p.example; continue }
    if (p.default !== undefined) { out[p.name] = p.default; continue }
    out[p.name] = placeholderFor(p.type, p.name)
  }
  return out
}

function placeholderFor(type: PromptParamType, name: string): Json {
  switch (type) {
    case 'string': return `<${name}>`
    case 'number': return 0
    case 'boolean': return false
    case 'string[]': return [`<${name}[0]>`]
    case 'number[]': return [0]
    case 'boolean[]': return [false]
  }
}

/** Map the declared params to a TS object-type literal string for the dts member.
 *  Total over PROMPT_PARAM_TYPES; empty params => `{}` (still valid). */
export function paramsToTsType(params: PromptParam[]): string {
  if (params.length === 0) return '{}'
  const lines = params.map((p) => {
    const doc = p.description ? `    /** ${p.description.replace(/\*\//g, '* /')} */\n` : ''
    return `${doc}    ${p.name}: ${TS_TYPE[p.type]};`
  })
  return `{\n${lines.join('\n')}\n  }`
}

const TS_TYPE: Record<PromptParamType, string> = {
  string: 'string', number: 'number', boolean: 'boolean',
  'string[]': 'string[]', 'number[]': 'number[]', 'boolean[]': 'boolean[]',
}
```

> **Note — NO `toMethodName`.** Per Option A, identifier-only filenames make `bareName` the JS-visible name directly. This file deliberately exports **no** name transform; the §4 gate freezes exactly the seven symbols above.

### 2.2 Shared isomorphic Handlebars environment — `shared/prompt-env.ts` (NEW, isomorphic)

One `Handlebars.create()` instance, configured identically, imported by **both** the server loader and the browser preview, so server-render === client-preview byte-for-byte. Safe helpers only (all pure — no `Date`/random/IO/console); built-in `log` is omitted. `noEscape: true` (prompts are LLM text, not HTML). Partials are resolved from the catalog (two-tier) by the **identifier** name.

```ts
// shared/prompt-env.ts  (isomorphic — NO node:* imports; full Handlebars build for live compile)
import Handlebars from 'handlebars'
import type { Json } from './capability.ts'

export type PromptEnv = ReturnType<typeof Handlebars.create>

/** Compile options shared by server-render and client-preview (must be identical). */
export const PROMPT_COMPILE_OPTIONS: CompileOptions = {
  noEscape: true,   // prompts are plain text; never HTML-entity-encode & < > "
  strict: false,    // lenient: missing fields render empty (don't throw at author time)
}

/** Curated SAFE helper set. Every helper is PURE: no Date, no random, no IO, no console.
 *  This purity is what makes render deterministic across realms (inject-lens determinism). */
function registerSafeHelpers(env: PromptEnv): void {
  env.registerHelper('eq', (a: unknown, b: unknown) => a === b)
  env.registerHelper('ne', (a: unknown, b: unknown) => a !== b)
  env.registerHelper('not', (a: unknown) => !a)
  env.registerHelper('join', (arr: unknown, sep: unknown) =>
    Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ', ') : '')
  env.registerHelper('json', (v: unknown) => JSON.stringify(v, null, 2))
  env.registerHelper('lowercase', (s: unknown) => String(s ?? '').toLowerCase())
  env.registerHelper('uppercase', (s: unknown) => String(s ?? '').toUpperCase())
  env.registerHelper('trim', (s: unknown) => String(s ?? '').trim())
  env.registerHelper('default', (v: unknown, fallback: unknown) =>
    v === undefined || v === null || v === '' ? fallback : v)
}

/** Build a fresh configured environment. Helpers are registered; partials are
 *  added by the caller via registerPartial (full bodies — see render-parity below). */
export function createPromptEnv(): PromptEnv {
  const env = Handlebars.create()
  registerSafeHelpers(env)
  return env
}

/** Register one partial under its IDENTIFIER name so `{{> name}}` resolves unquoted.
 *  Body is the FULL template body (frontmatter-stripped) — never a truncated preview,
 *  so partial composition renders identically on server and client. */
export function registerPartial(env: PromptEnv, name: string, body: string): void {
  env.registerPartial(name, body)
}

/** Compile a body in `env` and render it against `data`. Pure + synchronous. */
export function renderPrompt(env: PromptEnv, body: string, data: Json): string {
  const tpl = env.compile(body, PROMPT_COMPILE_OPTIONS)
  return tpl(data as Record<string, unknown>)
}
```

Vite note: add `optimizeDeps.include: ['handlebars']` (and, if a `require is not defined` warning surfaces, `resolve.alias` to `handlebars/dist/cjs/handlebars.js`) in `vite.config.ts` — the **full** build is required because the preview compiles live user input.

### 2.3 PromptTemplate type + identity helper — `shared/prompt-template.ts` (NEW, isomorphic)

Mirrors `shared/capability.ts` (same identifier regex) but **drops `secrets`, `effects`/`EffectFn`, `CapabilityContext`** — a template is a pure render.

```ts
// shared/prompt-template.ts  (isomorphic — NO node:* imports)
import type { Json } from './capability.ts'
import type { PromptParam } from './prompt-frontmatter.ts'

/** A loaded, compiled prompt template (the host-side counterpart of a Capability). */
export interface PromptTemplate {
  /** Namespace member name injected as prompts.<name>. == bareName == filename.
   *  Identifier-only (Option A): no transform, mirrors Capability.name exactly. */
  name: string
  /** Declared params (from frontmatter) — types the call + seeds preview. */
  params: PromptParam[]
  /** Pure synchronous render: prompts.<name>(data) => string. NO ctx, NO secrets. */
  render: (data: Json) => string
}

/** Identity helper; validates the name is an identifier (same regex as defineCapability). */
export function definePromptTemplate<T extends PromptTemplate>(tpl: T): T {
  if (!tpl.name || !/^[A-Za-z_$][\w$]*$/.test(tpl.name)) {
    throw new Error(`definePromptTemplate: invalid prompt name "${tpl.name}"`)
  }
  return tpl
}
```

### 2.4 Filesystem scan — `server/store/prompts.ts` (NEW; copies `store/capabilities.ts`)

Clones the mkdir/realpath/safeName/dedupe/project-first scan. **DIFFERS:** ext is `['.hbs']`; **`isSafePromptFileName` tightens the bareName to the identifier regex** (Option A — rejects `mr-review.hbs`); and because templates are plain text, the scan **reads the body** here (capabilities deliberately do not — they `import()` later).

```ts
// server/store/prompts.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { PROMPT_DIRS } from '../config.ts'

export interface PromptFileInfo {
  name: string                 // bareName (filename minus .hbs); GUARANTEED a JS identifier
  path: string
  tier: 'project' | 'user'
  modifiedAt: number
  body: string                 // full .hbs source (frontmatter NOT yet stripped)
}

const PROMPT_EXTS = ['.hbs']

/** Traversal guard PLUS identifier guard. Unlike isSafeFileName in store/capabilities.ts
 *  (which allows '-', ' ', '.'), the prompt bareName MUST be a valid JS identifier so
 *  name == injected key == dts member == partial name with NO transform (Option A). */
function isSafePromptFileName(name: string): boolean {
  if (path.basename(name) !== name) return false
  const ext = path.extname(name)
  if (!PROMPT_EXTS.includes(ext)) return false
  const bare = name.slice(0, -ext.length)
  return /^[A-Za-z_$][\w$]*$/.test(bare)
}

function bareNameOf(fileName: string): string {
  const ext = path.extname(fileName)
  return PROMPT_EXTS.includes(ext) ? fileName.slice(0, -ext.length) : fileName
}

/** Two-tier scan over PROMPT_DIRS, project shadows user. Reads bodies (cheap text). */
export async function scanPromptFiles(): Promise<PromptFileInfo[]> {
  const byBareName = new Map<string, PromptFileInfo>()
  for (const { dir, tier } of PROMPT_DIRS) {
    await fs.mkdir(dir, { recursive: true })
    let dirReal: string
    try { dirReal = await fs.realpath(dir) } catch { continue }
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const fileName = entry.name
      if (!isSafePromptFileName(fileName)) continue
      const full = path.join(dir, fileName)
      let real: string, st
      try { real = await fs.realpath(full); st = await fs.stat(real) } catch { continue }
      if (!st.isFile()) continue
      const rel = path.relative(dirReal, real)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      const name = bareNameOf(fileName)
      if (byBareName.has(name)) continue            // project scanned first → wins
      const body = await fs.readFile(real, 'utf8')
      byBareName.set(name, { name, path: full, tier, modifiedAt: st.mtimeMs, body })
    }
  }
  return [...byBareName.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** Single-file read for the editor "open prompt" flow (safeName + .hbs guard). */
export async function readPrompt(tierDir: string, name: string): Promise<{ path: string; content: string }> {
  const fileName = name.endsWith('.hbs') ? name : `${name}.hbs`
  if (!isSafePromptFileName(fileName)) throw new Error('Invalid prompt name (identifier + .hbs only).')
  const full = path.join(tierDir, fileName)
  const real = await fs.realpath(full)
  const rel = path.relative(await fs.realpath(tierDir), real)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes prompts dir.')
  return { path: full, content: await fs.readFile(real, 'utf8') }
}

export async function writePrompt(tierDir: string, name: string, content: string): Promise<PromptFileInfo> {
  const fileName = name.endsWith('.hbs') ? name : `${name}.hbs`
  if (!isSafePromptFileName(fileName)) throw new Error('Invalid prompt name (identifier + .hbs only).')
  await fs.mkdir(tierDir, { recursive: true })
  const full = path.join(tierDir, fileName)
  await fs.writeFile(full, content, 'utf8')
  const st = await fs.stat(full)
  return { name: bareNameOf(fileName), path: full, tier: 'project', modifiedAt: st.mtimeMs, body: content }
}
```

### 2.5 Host loader + catalog build — `server/workflow/prompt-loader.ts` (NEW; copies `capability-loader.ts`)

**DIFFERS:** no `computeSecretStatus`/`secretStatus`; no `import()`/zod-default-export/mixed-module discrimination (plain text → `parsePrompt` + `createPromptEnv` compile). Per-file `loadError` isolation is preserved. Partials: every scanned body is registered (full body) on a shared env so cross-template `{{> name}}` works at render time. A frontmatter parse/compile failure becomes `entry.loadError`. **Identifier names guaranteed by the scan → no name transform, no uniqueness collision possible** (two distinct files cannot share a bareName).

```ts
// server/workflow/prompt-loader.ts
// Host-side compile of .hbs templates + catalog build. Plain text => NO import(),
// NO zod default-export check, NO secretStatus. One bad file ≠ broken catalog.
import { scanPromptFiles } from '../store/prompts.ts'
import { parsePrompt, paramsToTsType } from '../../shared/prompt-frontmatter.ts'
import { createPromptEnv, registerPartial, renderPrompt } from '../../shared/prompt-env.ts'
import type { PromptTemplate } from '../../shared/prompt-template.ts'
import type { PromptCatalogEntry } from '../../shared/protocol.ts'
import type { PromptCatalog } from '../../shared/prompt-resolve.ts'
import { resolvePrompt } from '../../shared/prompt-resolve.ts'

const PREVIEW_LEN = 400

export interface LoadedPrompts {
  catalog: PromptCatalog                 // project>user, keyed by bareName per tier
  entries: PromptCatalogEntry[]          // flat, tier-tagged safe DTO (ships to browser)
  templates: Map<string, PromptTemplate> // keyed by bareName (== name == identifier)
}

export async function loadPrompts(): Promise<LoadedPrompts> {
  const scanned = await scanPromptFiles()

  // One shared env across all templates so partials cross-resolve. Register FULL
  // bodies for every scanned file FIRST, then compile each as a renderable template.
  const env = createPromptEnv()
  const parsed = scanned.map((f) => ({ file: f, ...parsePrompt(f.body) }))
  for (const p of parsed) registerPartial(env, p.file.name, p.body) // full body, by identifier

  const entries: PromptCatalogEntry[] = []
  const templates = new Map<string, PromptTemplate>()
  const catalog: PromptCatalog = { project: {}, user: {} }

  for (const p of parsed) {
    const entry: PromptCatalogEntry = {
      name: p.file.name,
      tier: p.file.tier,
      params: p.params,
      paramsDts: paramsToTsType(p.params),
      preview: p.body.slice(0, PREVIEW_LEN),  // HOVER snippet only — NEVER a render input
      body: p.body,                            // FULL body — render-parity in the preview
      path: p.file.path,
      modifiedAt: p.file.modifiedAt,
    }
    try {
      if (p.error) throw new Error(`frontmatter: ${p.error}`)
      env.compile(p.body)                      // surface compile errors at load time
      const tpl: PromptTemplate = {
        name: p.file.name,
        params: p.params,
        render: (data) => renderPrompt(env, p.body, data),
      }
      templates.set(p.file.name, tpl)
    } catch (err) {
      entry.loadError = err instanceof Error ? err.message : String(err)
    }
    entries.push(entry)
    catalog[p.file.tier][p.file.name] = entry
  }
  return { catalog, entries, templates }
}

/** Resolve declared meta.prompts (project>user, qualifiers) to loaded templates,
 *  keyed by the namespace member name (== bareName == identifier). Mirror of
 *  getCapabilityModules; unresolved names skipped (validator flags them). */
export function getPromptTemplates(loaded: LoadedPrompts, names: string[]): Map<string, PromptTemplate> {
  const out = new Map<string, PromptTemplate>()
  for (const raw of names) {
    const res = resolvePrompt(loaded.catalog, raw)
    if (!res.resolved) continue
    const tpl = loaded.templates.get(res.bareName)
    if (tpl) out.set(tpl.name, tpl)   // key == res.bareName == tpl.name; no mixing
  }
  return out
}
```

### 2.6 Pure prompts-namespace bind + executor injection

**`server/workflow/run.ts` (MODIFY).** Add `private promptModules` + `private promptCatalog`, a `bindPrompts` that returns **one frozen object** of sync render fns (NO `ctxFor`, NO `runEffect`, NO recording), and thread `prompts` into `hostHooks()`.

```ts
// server/workflow/run.ts — new fields (beside capabilityModules / capabilityCatalog)
/** Resolved + loaded prompt templates for this run (declared in meta.prompts). */
private promptModules = new Map<string, PromptTemplate>()
/** Run-time prompt catalog (project>user), threaded into validateWorkflow. */
private promptCatalog?: PromptCatalog
```

```ts
// server/workflow/run.ts — host: prompts (PURE; sibling of bindCapability, but no recording)
/** Build the single `prompts` namespace object: { name: (data)=>string }.
 *  Pure + synchronous: NO ctxFor (no secrets/log), NO runEffect (no counter, no
 *  EffectCallState, no effect:* events, no null-on-failure, no abort plumbing).
 *  Frozen to block sandbox monkey-patching, mirroring bindCapability's freeze. */
private bindPrompts(): Readonly<Record<string, (data: Json) => string>> {
  const ns: Record<string, (data: Json) => string> = {}
  for (const [name, tpl] of this.promptModules) {
    ns[name] = (data: Json) => tpl.render(data)   // key == name == identifier
  }
  return Object.freeze(ns)
}
```

```ts
// server/workflow/run.ts — hostHooks(): add the prompts field
private hostHooks(argsOverride?: unknown): SandboxHost {
  return {
    // …existing agent/phase/log/checkpoint/runNested/budget/args/cwd/capabilities…
    capabilities: Object.fromEntries(
      [...this.capabilityModules].map(([ns, cap]) => [ns, this.bindCapability(cap, this.ctxFor(cap))]),
    ),
    prompts: this.bindPrompts(),
  }
}
```

```ts
// server/workflow/run.ts — start(): load + thread + resolve (beside loadCapabilities)
let loadedPrompts: LoadedPrompts | undefined
try {
  loadedPrompts = await loadPrompts()            // NO process.env arg — prompts have no secrets
  this.promptCatalog = loadedPrompts.catalog
} catch (err) {
  this.logAcp('warn', 'prompts', `Failed to load prompts: ${err instanceof Error ? err.message : String(err)}`)
}

// validateWorkflow now carries the prompt catalog as a 5th positional arg:
const validation = validateWorkflow(
  this.request.source, this.request.agent, undefined,
  this.capabilityCatalog, this.promptCatalog,
)
// …after `const meta = validation.meta`:
if (loadedPrompts && meta.prompts?.length) {
  this.promptModules = getPromptTemplates(loadedPrompts, meta.prompts)
}
```

The nested-workflow call sites (`runNested` at run.ts:696, and the validate call in `start()`) **also** pass `this.promptCatalog` as the new 5th arg; because `hostHooks()` now always includes `prompts`, nested workflows inherit the namespace automatically.

**`server/workflow/executor.ts` (MODIFY).** Add the field + a **second injection loop** with the same collision guard, plus the **new cross-system guard** (a prompt name must not collide with an already-injected capability namespace).

```ts
// server/workflow/executor.ts — SandboxHost: add the pure prompts field
export interface SandboxHost {
  // …existing fields + capabilities…
  /** The single `prompts` namespace: { name: (data)=>string }. PURE + SYNC.
   *  Already frozen by WorkflowRun.bindPrompts. NOT recorded, NOT async. */
  prompts: Readonly<Record<string, (data: Json) => string>>
}
```

```ts
// server/workflow/executor.ts — buildSandboxGlobals(): step 1c, AFTER the capability loop (1b)
// 1c. The single pure `prompts` namespace. Collision-guarded against DSL globals
//     AND against capability namespaces already injected in step 1b (cross-system
//     guard — capabilities never needed this since they were the sole injector).
if ('prompts' in scope) {
  throw new Error(`prompts namespace collides with a DSL global or capability`)
}
const promptsNs: Record<string, (data: Json) => string> = {}
for (const [name, fn] of Object.entries(host.prompts)) {
  if (name in scope) {
    // a prompt member name equal to a DSL global is impossible (it lives under
    // `prompts.`), but guard the namespace object itself above; members are safe.
  }
  promptsNs[name] = fn
}
scope.prompts = Object.freeze(promptsNs)
```

> The injected global is a **single** `prompts` object holding all declared render fns — `prompts.mrReview(data)`. This is the one structural difference from capabilities (which inject N top-level namespaces). `'prompts'` is reserved (§2.10) so no capability can be named `prompts`; the `if ('prompts' in scope) throw` covers the cross-system case regardless of loop order.

### 2.7 Resolver / catalog reuse — `shared/prompt-resolve.ts` (NEW; near-verbatim copy of `capability-resolve.ts`)

**REUSED (shared) capability files:** `shared/capability.ts` (only its `Json` type is imported, not copied). **COPIED:** `capability-resolve.ts` → `prompt-resolve.ts` — identical tier enum, identical `user:`/`@me/`/`project:`/bare grammar, identical project>user precedence and `shadowsUser` INFO semantics. **DIFFERS:** the entry import type only.

```ts
// shared/prompt-resolve.ts  (isomorphic — NO node:* imports)
import type { PromptCatalogEntry } from './protocol.ts'

export type PromptTier = 'project' | 'user'

export interface ParsedPromptRef { scope: PromptTier | null; bareName: string }

export function parsePromptRef(raw: string): ParsedPromptRef {
  if (raw.startsWith('user:'))    return { scope: 'user',    bareName: raw.slice(5).trim() }
  if (raw.startsWith('@me/'))     return { scope: 'user',    bareName: raw.slice(4).trim() }
  if (raw.startsWith('project:')) return { scope: 'project', bareName: raw.slice(8).trim() }
  return { scope: null, bareName: raw.trim() }
}

export interface PromptResolution {
  ref: string; bareName: string
  resolved: PromptTier | null
  shadowsUser: boolean
}

export interface PromptCatalog {
  project: Record<string, PromptCatalogEntry>   // bareName -> entry
  user: Record<string, PromptCatalogEntry>
}

export function resolvePrompt(catalog: PromptCatalog, raw: string): PromptResolution {
  const { scope, bareName } = parsePromptRef(raw)
  const inProject = bareName in catalog.project
  const inUser = bareName in catalog.user
  let resolved: PromptTier | null = null
  if (scope === 'project') resolved = inProject ? 'project' : null
  else if (scope === 'user') resolved = inUser ? 'user' : null
  else resolved = inProject ? 'project' : inUser ? 'user' : null
  return { ref: raw, bareName, resolved, shadowsUser: resolved === 'project' && inUser && scope === null }
}
```

### 2.8 Catalog DTO + `/api/prompts` endpoint

**`shared/protocol.ts` (MODIFY — append).** Mirror `CapabilityCatalogEntry`; **drop `secrets`/`secretStatus`**; `methods` → `params` (declared render surface); add `paramsDts`, `body` (full, for preview render-parity), `preview` (hover snippet only).

```ts
// shared/protocol.ts — append (safe to ship to browser; prompt bodies are non-sensitive)
import type { PromptParam } from './prompt-frontmatter.ts'

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
```

**`server/index.ts` (MODIFY).** Add `GET /api/prompts` (no env), `/api/validate` threads the prompt catalog, and `GET|PUT /api/prompts/:tier/:name` for the editor open/save (a real, safeName-guarded route — **not** the broken `/api/file` pattern).

```ts
// server/index.ts
import { loadPrompts } from './workflow/prompt-loader.ts'
import { readPrompt, writePrompt } from './store/prompts.ts'
import { PROJECT_PROMPTS_DIR, USER_PROMPTS_DIR } from './config.ts'
import type { PromptsResponse } from '../shared/protocol.ts'

app.get('/api/prompts', async (_req, res, next) => {
  try {
    const { entries } = await loadPrompts()
    const body: PromptsResponse = { prompts: entries }
    res.json(body)
  } catch (err) { next(err) }
})

function promptDirFor(tier: string): string {
  if (tier === 'project') return PROJECT_PROMPTS_DIR
  if (tier === 'user') return USER_PROMPTS_DIR
  throw new Error('Unknown prompt tier')
}

app.get('/api/prompts/:tier/:name', async (req, res) => {
  try {
    const { content } = await readPrompt(promptDirFor(req.params.tier), req.params.name)
    res.json({ name: req.params.name, content })
  } catch { res.status(404).json({ error: 'Prompt not found' }) }
})

const savePromptSchema = z.object({ content: z.string() })
app.put('/api/prompts/:tier/:name', async (req, res, next) => {
  try {
    const { content } = savePromptSchema.parse(req.body)
    res.json(await writePrompt(promptDirFor(req.params.tier), req.params.name, content))
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'content is required' })
    next(err)
  }
})

// /api/validate — load BOTH catalogs and thread both:
app.post('/api/validate', async (req, res, next) => {
  // …parse source…
  try {
    const { catalog } = await loadCapabilities(process.env)
    const { catalog: promptCatalog } = await loadPrompts()
    res.json(validateWorkflow(source, undefined, undefined, catalog, promptCatalog))
  } catch (err) { next(err) }
})
```

### 2.9 `meta.prompts` field + `validateWorkflow` change

**`shared/dsl.ts` (MODIFY — append to `WorkflowMeta`).**

```ts
// shared/dsl.ts — WorkflowMeta, sibling of `capabilities`
/**
 * Declared prompt-template (Handlebars) namespaces this workflow renders via
 * `prompts.<name>(data)`. Each entry is a bare identifier resolved project-local
 * `prompts/` first, then user-level `~/.agentprism/prompts/`. May be tier-qualified
 * with `project:`, `user:`, or `@me/`. Unresolved names are a hard validation error.
 */
prompts?: string[]
```

**`shared/validate.ts` (MODIFY).** (a) shape check beside `meta.capabilities`; (b) a sibling AST-resolution branch keyed on `'prompts'`; (c) `promptCatalog` as the new **5th** positional param.

```ts
// shared/validate.ts — validateMeta(): shape check (copy of the capabilities block)
if (m.prompts !== undefined) {
  if (!Array.isArray(m.prompts)) {
    errors.push('meta.prompts must be an array of strings')
  } else {
    for (const p of m.prompts) {
      if (typeof p !== 'string' || p.trim() === '') {
        errors.push('each meta.prompts entry must be a non-empty string'); break
      }
    }
  }
}
```

```ts
// shared/validate.ts — signature (promptCatalog is the new 5th positional arg)
export function validateWorkflow(
  rawSource: string,
  selectedAgentId?: AcpAgentId,
  connectedAgentIds?: AcpAgentId[],
  capabilityCatalog?: CapabilityCatalog,
  promptCatalog?: PromptCatalog,
): ValidateResult { /* … */ }
```

```ts
// shared/validate.ts — inside the meta ObjectExpression walk, a sibling of the
// `keyName === 'capabilities'` block. Same algorithm; resolvePrompt + prompt wording.
if (promptCatalog && p.type === 'Property' && p.key) {
  const keyName = /* identifier or string-literal key, same extraction as capabilities */ ''
  if (keyName === 'prompts' && p.value?.type === 'ArrayExpression' && Array.isArray(p.value.elements)) {
    for (const el of p.value.elements) {
      if (!el) continue
      const elNode = el as unknown as { type: string; value?: unknown }
      if (elNode.type !== 'Literal' || typeof elNode.value !== 'string') continue
      const res = resolvePrompt(promptCatalog, elNode.value)
      if (res.resolved === null) {
        diagnostics.push(diagAt(el, `prompt "${res.bareName}" does not resolve`, 'error'))
      } else if (res.shadowsUser) {
        diagnostics.push(diagAt(el, `${res.bareName} -> ./prompts, shadowing Shared prompts`, 'info'))
      }
    }
  }
}
```

> All other `validateWorkflow` call sites add `promptCatalog` (or `undefined`) as the 5th arg — enumerated in §3 to avoid the "silently disable resolution" risk.

### 2.10 Reserved name + cross-system guard — `shared/dsl-registry.ts` (MODIFY)

Add `'prompts'` to `CAPABILITY_RESERVED_NAMES` so no capability can be named `prompts` and collide with the namespace global. (The dts builder already skips reserved capability names; the executor's `if ('prompts' in scope) throw` covers the cross-system runtime case.)

```ts
// shared/dsl-registry.ts — CAPABILITY_RESERVED_NAMES: add 'prompts'
export const CAPABILITY_RESERVED_NAMES: ReadonlySet<string> = new Set<string>([
  ...DSL_METHODS.map((m) => m.name),
  'Math', 'JSON', 'Date', 'Promise', 'Object', 'Array', 'globalThis', 'process', 'console',
  'prompts',   // the prompt-namespace global — capabilities must not shadow it
])
```

### 2.11 `declare const prompts: {...}` dts generation — `src/lib/workflow-dts.ts` (MODIFY)

One `declare const prompts: { … }` block whose body is generated **per scoped entry** from `paramsDts`. The member name is `entry.name` directly (identifier-guaranteed → valid TS, no transform). Return type is `string` (sync) — distinguishing it from capability methods' `Promise<any>`. The `prompts` global itself is reserved (so the whole block is emitted only when at least one prompt is scoped).

```ts
// src/lib/workflow-dts.ts
import type { PromptCatalogEntry } from '@shared/protocol'

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

export function buildWorkflowDts(
  agents: AcpAgentSpec[],
  defaultAgentId: AcpAgentId,
  capabilities?: CapabilityCatalogEntry[],
  prompts?: PromptCatalogEntry[],         // NEW 4th param
): string {
  const configInterfaces = agents.map((spec) => buildAgentConfigInterface(spec))
  const agentOptions = buildAgentOptionsDts(agents, defaultAgentId)
  const capabilityDts = (capabilities ?? [])
    .map(buildCapabilityDts).filter((b): b is string => b !== null)
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
```

### 2.12 Monaco Handlebars registration + live-preview component

**`src/lib/monaco-setup.ts` (MODIFY).** Add the side-effect import so the bundled grammar registers; the `handlebars` language id + `.hbs` ext come for free. Optional token rules for mustache delimiters.

```ts
// src/lib/monaco-setup.ts — top of file (registers id 'handlebars', ext '.hbs';
// transitively pulls the html grammar it embeds). Without this import, .hbs falls
// back to plaintext — the single most likely "no highlighting" bug.
import 'monaco-editor/esm/vs/basic-languages/handlebars/handlebars.contribution'
```

**`src/features/editor/WorkflowEditor.tsx` (MODIFY).** Language becomes dynamic; workflow-only machinery (acorn markers, breakpoints, pause decorations, workflowDts injection) is **gated off** when a `.hbs` is active.

```ts
// src/features/editor/WorkflowEditor.tsx
const kind = useStore((s) => s.openKind)               // 'workflow' | 'prompt'
// …
<Editor language={kind === 'prompt' ? 'handlebars' : 'javascript'} /* … */ />
// updateMarkers / updateBreakpoints / updatePause / updateWorkflowDts effects:
//   early-return when kind === 'prompt' (Handlebars text is not a workflow).
```

**`src/features/editor/HandlebarsPreview.tsx` (NEW).** Renders the open `.hbs` against editable sample JSON, compiled with the **same** `shared/prompt-env.ts` factory + **full** partial bodies from the catalog (render-parity), reusing RunConfig's editable-JSON-textarea pattern.

```tsx
// src/features/editor/HandlebarsPreview.tsx
import { useMemo, useState, useEffect } from 'react'
import { useStore } from '@/store/useStore'
import { parsePrompt, seedSampleData } from '@shared/prompt-frontmatter'
import { createPromptEnv, registerPartial, renderPrompt } from '@shared/prompt-env'

/** Live preview: template body + editable sample JSON -> rendered string.
 *  Uses the SAME createPromptEnv() as the server and registers FULL partial
 *  bodies from the catalog, so the preview is byte-identical to production. */
export function HandlebarsPreview() {
  const source = useStore((s) => s.source)              // the open .hbs text
  const prompts = useStore((s) => s.prompts)            // PromptCatalogEntry[]
  const { params, body, error: fmError } = useMemo(() => parsePrompt(source), [source])

  const [sampleText, setSampleText] = useState('')
  useEffect(() => { setSampleText(JSON.stringify(seedSampleData(params), null, 2)) },
    [JSON.stringify(params)])

  const { output, error } = useMemo(() => {
    try {
      const data = JSON.parse(sampleText || '{}')
      const env = createPromptEnv()
      for (const e of prompts) if (e.body) registerPartial(env, e.name, e.body) // FULL bodies
      return { output: renderPrompt(env, body, data), error: null as string | null }
    } catch (err) {
      return { output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }, [body, sampleText, prompts])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* editable sample JSON (mirror RunConfig args textarea) + rendered <pre>{output}</pre>;
          show (fmError ?? error) inline. Debounced via the useMemo deps. */}
    </div>
  )
}
```

**`src/App.tsx` (MODIFY).** Nest a vertical `PanelGroup` in the center Panel: editor on top, `<HandlebarsPreview/>` on bottom, shown only when `openKind === 'prompt'`.

**`src/store/useStore.ts` (MODIFY).** Add `prompts: PromptCatalogEntry[]`, `promptCatalog: PromptCatalog`, `openKind: 'workflow' | 'prompt'`; `refreshPrompts()` (mirror `refreshCapabilities`); `openPrompt(tier, name)` (fetch via `/api/prompts/:tier/:name`, set `source`+`openKind:'prompt'`, **skip** validation/workflowDts/breakpoints). Thread `scopedPromptEntries(promptCatalog, meta.prompts)` into every `buildWorkflowDts` call, and extend the `setSource` re-inject diff to fire on `meta.prompts` change too.

```ts
// src/store/useStore.ts — scoping helper (mirror scopedCapabilityEntries)
function scopedPromptEntries(catalog: PromptCatalog, metaPrompts: string[] | undefined): PromptCatalogEntry[] {
  if (!metaPrompts) return []
  const out: PromptCatalogEntry[] = []
  for (const raw of metaPrompts) {
    const res = resolvePrompt(catalog, raw)
    if (res.resolved) out.push(catalog[res.resolved][res.bareName])
  }
  return out
}
```

```ts
// src/store/useStore.ts — setSource: extend the re-inject diff
const prevPrompts = s.validation.meta?.prompts
const nextPrompts = validation.meta?.prompts
const capsChanged = JSON.stringify(prevCaps) !== JSON.stringify(nextCaps)
const promptsChanged = JSON.stringify(prevPrompts) !== JSON.stringify(nextPrompts)
// rebuild workflowDts when (capsChanged || promptsChanged), passing BOTH scoped lists:
//   workflowDtsFor(s.agents, s.selectedAgent,
//     scopedCapabilityEntries(s.capabilityCatalog, nextCaps),
//     scopedPromptEntries(s.promptCatalog, nextPrompts))
```

`workflowDtsFor` gains a 4th param (`prompts?: PromptCatalogEntry[]`) forwarded to `buildWorkflowDts`.

**`src/features/files/FileSidebar.tsx` (MODIFY).** Add "Prompts" / "Shared prompts" sections mirroring Tools/Shared tools — split `prompts` by tier, render two sections (reuse a `PromptSection` styled like `ToolSection`, distinct icon e.g. `MessageSquare`), and wire `onOpen` → `openPrompt(tier, name)` (a **real** route, never the broken `/api/file`).

**`src/lib/api.ts` (MODIFY).** Add `fetchPrompts()`, `fetchPromptFile(tier,name)`, `savePromptFile(tier,name,content)` mirroring the capability/workflow fetchers.

---

## 3. File-by-file plan

One agent per file; changes are append-only on shared files to avoid cross-file conflicts. **NEW files generalize a capability file; MODIFY files extend an existing surface.**

| path | action | owns | dependsOn | concrete changes |
|---|---|---|---|---|
| `shared/prompt-frontmatter.ts` | **create** | frontmatter parse, sample seed, params→TS type | `shared/capability.ts` (`Json`), `zod` | Implement `parsePrompt`, `seedSampleData`, `paramsToTsType`, `PROMPT_PARAM_TYPES`, types. **No `toMethodName`.** |
| `shared/prompt-env.ts` | **create** | shared isomorphic Handlebars env | `handlebars` (new dep), `shared/capability.ts` | `createPromptEnv`, `registerSafeHelpers` (pure set), `registerPartial`, `renderPrompt`, `PROMPT_COMPILE_OPTIONS` (`noEscape:true`). |
| `shared/prompt-template.ts` | **create** | `PromptTemplate` + `definePromptTemplate` | `shared/capability.ts`, `shared/prompt-frontmatter.ts` | Mirror `capability.ts`; drop secrets/effects/ctx; identifier regex. |
| `shared/prompt-resolve.ts` | **create** | two-tier resolve | `shared/protocol.ts` | Near-verbatim copy of `capability-resolve.ts`; `PromptCatalog`, `resolvePrompt`, `parsePromptRef`. |
| `server/store/prompts.ts` | **create** (copies `store/capabilities.ts`) | FS scan + read/write | `server/config.ts` (`PROMPT_DIRS`) | `scanPromptFiles` (`.hbs`, **identifier-only `isSafePromptFileName`**, reads body), `readPrompt`, `writePrompt`. |
| `server/workflow/prompt-loader.ts` | **create** (copies `capability-loader.ts`) | host compile + catalog + `getPromptTemplates` | `store/prompts.ts`, `shared/prompt-env.ts`, `shared/prompt-frontmatter.ts`, `shared/prompt-resolve.ts`, `shared/protocol.ts` | `loadPrompts` (no secretStatus, no import(), full-body partials, per-file `loadError`), `getPromptTemplates`. |
| `server/config.ts` | **modify** | tier dirs | — | Add `PROJECT_PROMPTS_DIR` (env `AGENTPRISM_PROMPTS_DIR` or `./prompts`), `USER_PROMPTS_DIR` (`~/.agentprism/prompts`), `PROMPT_DIRS` (project-first). |
| `shared/dsl-registry.ts` | **modify** | reserved names | — | Add `'prompts'` to `CAPABILITY_RESERVED_NAMES`. |
| `shared/dsl.ts` | **modify** | `WorkflowMeta` | — | Add `prompts?: string[]` field + doc. |
| `shared/protocol.ts` | **modify** | DTOs | `shared/prompt-frontmatter.ts` (`PromptParam`) | Add `PromptCatalogEntry` (`params`, `paramsDts`, `preview`, **`body`**, no secrets) + `PromptsResponse`. |
| `shared/validate.ts` | **modify** | meta validation + resolution | `shared/prompt-resolve.ts` | Add `meta.prompts` shape check; `promptCatalog` 5th param; `'prompts'` AST-resolution branch. |
| `server/workflow/executor.ts` | **modify** | sandbox injection | `shared/capability.ts` (`Json`) | Add `SandboxHost.prompts`; step **1c** injection loop with `if ('prompts' in scope) throw` (cross-system guard). |
| `server/workflow/run.ts` | **modify** | run host | `prompt-loader.ts`, `shared/prompt-resolve.ts`, `shared/prompt-template.ts` | Add `promptModules`/`promptCatalog`, `bindPrompts` (pure, frozen), `hostHooks().prompts`, `loadPrompts()` in `start()`, resolve `meta.prompts`, 5th arg on both `validateWorkflow` calls. |
| `server/index.ts` | **modify** | REST | `prompt-loader.ts`, `store/prompts.ts`, `config.ts`, `shared/protocol.ts` | Add `GET /api/prompts`, `GET|PUT /api/prompts/:tier/:name`; thread prompt catalog into `/api/validate`. |
| `src/lib/workflow-dts.ts` | **modify** | dts | `shared/protocol.ts` | Add `buildPromptsDts`; `prompts?` 4th param on `buildWorkflowDts`; append block. |
| `src/lib/api.ts` | **modify** | client fetch | `shared/protocol.ts` | Add `fetchPrompts`, `fetchPromptFile`, `savePromptFile`. |
| `src/store/useStore.ts` | **modify** | client state | `api.ts`, `shared/prompt-resolve.ts`, `workflow-dts.ts` | Add `prompts`/`promptCatalog`/`openKind` state, `refreshPrompts`, `openPrompt`, `scopedPromptEntries`; thread into all **8** `validateWorkflow` sites + every `buildWorkflowDts`/`workflowDtsFor`; extend `setSource` diff with `promptsChanged`. |
| `src/lib/monaco-setup.ts` | **modify** | Monaco lang | `monaco-editor` | Side-effect import of handlebars contribution; optional mustache token rules. |
| `src/features/editor/WorkflowEditor.tsx` | **modify** | editor | `useStore` | Dynamic `language`; gate acorn markers / breakpoints / pause / dts on `openKind==='workflow'`. |
| `src/features/editor/HandlebarsPreview.tsx` | **create** | live preview | `shared/prompt-env.ts`, `shared/prompt-frontmatter.ts`, `useStore` | Editable sample JSON → render via shared env + **full-body** partials; inline errors. |
| `src/App.tsx` | **modify** | layout | `HandlebarsPreview` | Nest vertical PanelGroup in center; show preview when `openKind==='prompt'`. |
| `src/features/files/FileSidebar.tsx` | **modify** | sidebar | `useStore` | Add Prompts / Shared prompts sections; `onOpen`→`openPrompt`. |
| `src/lib/defaults.ts` | **modify** | seeds | — | Add `DEFAULT_PROMPT` (`.hbs`) seed for "new prompt". |
| `prompts/mrReview.hbs`, `prompts/criteriaList.hbs`, `workflows/mr-review-demo.js` | **create** | seed files | — | §5. |
| `vite.config.ts` | **modify** | bundling | — | `optimizeDeps.include: ['handlebars']` (+ alias if CJS warning). |
| `package.json` | **modify** | deps | — | Add `handlebars` (`^4.7.x`). |

---

## 4. Contract gate (barrier — implement FIRST)

Before any wave-B/C agent starts, these exact signatures are frozen. A single barrier agent lands them (stubs allowed for bodies, but **exports + arity are final**), CI typechecks, then fan-out proceeds.

1. **`shared/prompt-frontmatter.ts`** exports EXACTLY: `parsePrompt(source: string): ParsedPrompt & { error?: string }`, `seedSampleData(params: PromptParam[]): Record<string, Json>`, `paramsToTsType(params: PromptParam[]): string`, `PROMPT_PARAM_TYPES`, and types `PromptParamType`, `PromptParam`, `ParsedPrompt`. **No `toMethodName`** (Option A — deleted; identifier filenames make it unnecessary).
2. **`shared/prompt-env.ts`** exports `createPromptEnv(): PromptEnv`, `registerPartial(env, name, body): void`, `renderPrompt(env, body, data): string`, `PROMPT_COMPILE_OPTIONS`, type `PromptEnv`.
3. **`shared/prompt-template.ts`** exports `PromptTemplate { name; params; render(data: Json): string }`, `definePromptTemplate`.
4. **`shared/prompt-resolve.ts`** exports `PromptCatalog`, `PromptResolution`, `resolvePrompt`, `parsePromptRef`, `PromptTier`.
5. **`shared/protocol.ts`** adds `PromptCatalogEntry` (with `params`, `paramsDts`, `preview`, **`body`**, `path`, `modifiedAt`, `loadError?`, `name`, `tier`) and `PromptsResponse`.
6. **`validateWorkflow`** signature: `(rawSource, selectedAgentId?, connectedAgentIds?, capabilityCatalog?, promptCatalog?)` — `promptCatalog` is the **5th** positional arg.
7. **`buildWorkflowDts`** signature: `(agents, defaultAgentId, capabilities?, prompts?)` — `prompts` is the **4th** positional arg.
8. **`SandboxHost.prompts`** type: `Readonly<Record<string, (data: Json) => string>>` (sync, not Promise).
9. **`CAPABILITY_RESERVED_NAMES`** includes `'prompts'`.
10. **`server/store/prompts.ts`** `isSafePromptFileName` enforces `/^[A-Za-z_$][\w$]*$/` on the bareName (identifier-only — the load-bearing Option-A guard that makes every other contract consistent).

**Barrier invariant (the amendment's core fix):** `name === bareName === injected key === dts member === catalog key === partial name === the workflow-call name`, with **no transform anywhere**. This is enforced structurally by gate item 10; if a non-identifier `.hbs` is ever introduced it is rejected at scan time with a clear error, never silently camelCased.

---

## 5. Seed files

`prompts/mrReview.hbs` — identifier filename (so `prompts.mrReview`, no transform), composes a partial by identifier name `{{> criteriaList}}`:

```hbs
---
{ "params": [
  { "name": "acceptanceCriteria", "type": "string[]", "description": "Checklist the MR must satisfy",
    "example": ["Has tests", "Updates docs", "No console.log left"] },
  { "name": "comments", "type": "string[]", "description": "Existing review comments to consider",
    "example": ["Nit: rename foo", "Consider edge case for empty input"] },
  { "name": "diff", "type": "string", "description": "The unified diff under review",
    "example": "diff --git a/x.ts b/x.ts\n+ const y = 1" }
] }
---
You are reviewing a merge request. Evaluate the diff against the acceptance criteria.

## Acceptance criteria
{{> criteriaList criteria=acceptanceCriteria}}

{{#if comments}}
## Existing review comments
{{#each comments}}
- {{this}}
{{/each}}
{{/if}}

## Diff
```
{{diff}}
```

Return: a verdict (approve / request-changes), then one bullet per unmet criterion.
```

`prompts/criteriaList.hbs` — a partial (identifier name, `{{> criteriaList}}`):

```hbs
---
{ "params": [ { "name": "criteria", "type": "string[]", "description": "Criteria to render as a checklist" } ] }
---
{{#each criteria}}
- [ ] {{this}}
{{/each}}
```

`workflows/mr-review-demo.js` — the declarative twin of `tools/mr-prompt.ts`:

```js
export const meta = {
  name: 'mr_review_demo',
  description: 'Review a merge request using the mrReview prompt template.',
  phases: [{ title: 'Review' }],
  prompts: ['mrReview'],   // resolves project prompts/ first, then Shared prompts
}

phase('Review')

const p = prompts.mrReview({
  acceptanceCriteria: ['Has tests', 'Updates docs', 'No leftover console.log'],
  comments: ['Consider the empty-input edge case'],
  diff: args.diff ?? 'diff --git a/x.ts b/x.ts\n+ const y = 1',
})

return await agent(p, { cwd, label: 'mr review', schema: {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'request-changes'] } },
} })
```

`prompts.mrReview` is injected (bind), declared (`declare const prompts: { mrReview(data: { acceptanceCriteria: string[]; comments: string[]; diff: string }): string }`), and resolved — all under the single name `mrReview`. The preview renders `mrReview.hbs` with `{{> criteriaList}}` registered at **full body**, byte-identical to the server render.

---

## 6. Scope (in / out)

**In:** `.hbs` templates with JSON-frontmatter param schema; two-tier `prompts/` + `~/.agentprism/prompts/`; project-shadows-user resolution with qualifiers; host-side compile + pure `prompts.<name>(data)=>string` injection (no secrets, no recording, no run-tree node); `meta.prompts` declaration + AST validation (ERROR unresolved / INFO shadow); curated safe pure helper set; partial composition (`{{> name}}`, two-tier, **full-body parity**); `declare const prompts` intellisense; `/api/prompts` + read/write routes; Prompts/Shared-prompts sidebar; Monaco `.hbs` highlighting; live preview with editable sample JSON via the **shared** env; `handlebars` dep + Vite config.

**Out (deferred seams, not built):** arbitrary custom JS helpers; prompt versioning + eval hooks (DSPy on-ramp); composition beyond partials; auto-inferring params from `{{refs}}` (we use the declared schema); YAML frontmatter (JSON only for now); precompiled/runtime-only browser bundle (full compiler required for live preview); per-template recording/observability.

---

## 7. Open issues / risks

- **Identifier-only filenames are a hard constraint, surfaced clearly.** `mr-review.hbs` is rejected by `isSafePromptFileName`. Mitigation: the scan should not silently drop such files — surface them (e.g. a sidebar `loadError`-style note "rename to an identifier, e.g. `mrReview.hbs`") so authors aren't confused by a missing template. (This is the deliberate trade that eliminates the entire `toMethodName`/partial-hyphen/dts-member blocker class.)
- **Render parity depends on shipping full bodies.** `PromptCatalogEntry.body` ships full template text to the browser. This is acceptable (bodies are non-sensitive by design) but means **secrets must never be embedded in templates** — document this; the safe-helper set has no env/IO access, and templates are pure text, so there is no injection path, only the social rule.
- **Determinism holds only while helpers stay pure.** The locked safe set is pure (no `Date`/random/IO/console; `log` omitted). Any future helper must be audited; render runs host-side in the trusted realm, so the vm determinism prelude cannot neuter an impure helper — purity is enforced by curation, not by the sandbox.
- **No load caching.** `loadPrompts()` runs per `/api/prompts`, per `/api/validate`, and per run `start()` (mirroring the uncached `loadCapabilities`). Since the scan now also **reads bodies**, this is more work than the capability scan. MVP-acceptable (small `prompts/` dirs); a shared mtime-keyed cache is a fast follow if it shows up in profiling.
- **5th positional arg must reach every call site.** `validateWorkflow` now takes `promptCatalog` 5th; the 8 store sites + `run.ts:start()` + `runNested` + `/api/validate` must all thread it, or prompt resolution silently no-ops (graceful degradation hides the miss). Gate item 6 + §3 enumerate all sites; CI typecheck catches arity but **not** a forgotten `undefined`-passed site — review each.
- **dts re-injection on `meta.prompts` change.** `setSource` only rebuilds dts on a meta diff; the new `promptsChanged` diff must be wired or `prompts.*` intellisense goes stale when only `meta.prompts` changes. Covered in §2.12; flagged because it's the capability system's exact stale-dts trap.
- **Pre-existing unrelated bug (flagged, not fixed here):** `FileSidebar.handleOpenTool` calls `/api/file?path=`, a route that does **not** exist server-side, so opening a Tool always toasts an error today. The prompt-open flow deliberately uses the new real `/api/prompts/:tier/:name` route instead of copying this; the Tools bug remains and should be addressed separately.
- **Vite/handlebars CJS interop.** The full `handlebars` build may emit a `require is not defined` warning under Vite; mitigated by `optimizeDeps.include` and, if needed, a `resolve.alias` to the dist build. Confirm the preview compiles live before shipping.

**Relevant absolute paths:** new — `/home/vikash/prism-editor-web/shared/prompt-frontmatter.ts`, `/shared/prompt-env.ts`, `/shared/prompt-template.ts`, `/shared/prompt-resolve.ts`, `/server/store/prompts.ts`, `/server/workflow/prompt-loader.ts`, `/src/features/editor/HandlebarsPreview.tsx`, `/prompts/mrReview.hbs`, `/prompts/criteriaList.hbs`, `/workflows/mr-review-demo.js`; modified — `/shared/dsl.ts`, `/shared/dsl-registry.ts`, `/shared/protocol.ts`, `/shared/validate.ts`, `/server/config.ts`, `/server/index.ts`, `/server/workflow/executor.ts`, `/server/workflow/run.ts`, `/src/lib/workflow-dts.ts`, `/src/lib/api.ts`, `/src/lib/monaco-setup.ts`, `/src/lib/defaults.ts`, `/src/store/useStore.ts`, `/src/features/editor/WorkflowEditor.tsx`, `/src/features/files/FileSidebar.tsx`, `/src/App.tsx`, `/vite.config.ts`, `/package.json`.

---

## 8. Refinements folded in — MANDATORY (adversarial-feasibility soft findings)

The design above is validated (0 hard blockers). These refinements resolve the consequential soft findings and OVERRIDE the body where they conflict. The owning agent for each file MUST apply its tagged refinement.

### R1 — compile each template ONCE at load (perf + option-consistency) — `shared/prompt-env.ts`, `server/workflow/prompt-loader.ts`
The §2.2/§2.5 draft calls `env.compile(body, PROMPT_COMPILE_OPTIONS)` on EVERY `prompts.<name>(data)` call, and separately compiles once WITHOUT options for error-detection — a per-call re-parse plus an options mismatch.
- In `shared/prompt-env.ts`, add `compilePrompt(env, body): (data: Json) => string` that compiles ONCE with `PROMPT_COMPILE_OPTIONS` and returns the bound render delegate. (Keep `renderPrompt` for any one-shot use.)
- In `server/workflow/prompt-loader.ts`, compile each body ONCE inside the try: `const tpl = compilePrompt(env, p.body)` — this IS the load-time error surface (same options as render, no second compile) — then `render: (data) => tpl(data)`. Capabilities bind their fn once; prompts must too.

### R2 — delete the dead executor inner loop (don't copy broken code) — `server/workflow/executor.ts`
§2.6 step 1c shows a dead inner `for (const [name, fn] of Object.entries(host.prompts)) { if (name in scope) {/* empty */} promptsNs[name] = fn }` plus a redundant rebuild + re-`Object.freeze`. `host.prompts` is ALREADY frozen by `bindPrompts`. Implement step 1c as EXACTLY:
```ts
if ('prompts' in scope) {
  throw new Error('prompts namespace collides with a DSL global or capability')
}
scope.prompts = host.prompts   // already frozen by WorkflowRun.bindPrompts
```
Do NOT include the dead inner loop / rebuild — it is the same "copied-verbatim broken block" trap the capability system's C2 hit.

### R3 — actively CLEAR stale markers/decorations on the .hbs flip (real UX bug) — `src/features/editor/WorkflowEditor.tsx`
`@monaco-editor/react` reuses ONE model across the `language` flip. Merely early-returning the marker/breakpoint/pause effects when `openKind==='prompt'` LEAVES the prior workflow's red squiggles, breakpoint glyphs, and pause decoration painted over the Handlebars text. On entering prompt mode you MUST clear them first: `monaco.editor.setModelMarkers(model, 'agentprism', [])` and clear the breakpoint + pause decoration collections (set to `[]`). Only after clearing may the effects early-return while in prompt mode.

### R4 — memoize the preview env; don't rebuild per keystroke — `src/features/editor/HandlebarsPreview.tsx`
The draft rebuilds `createPromptEnv()` + re-registers all catalog partials + recompiles on every render (every `sampleText` keystroke). Instead: `useMemo` the env (build + register full-body partials) keyed on the catalog `prompts`; `useMemo` the compiled template keyed on `body`; render runs on `sampleText` against the precompiled template. Keystrokes re-render only — never recompile/re-register.

### R5 — handlebars is ALREADY installed — `package.json`, `vite.config.ts`
`handlebars@^4.7.9` is already in `package.json` and installed (package-lock updated). The agent owning `package.json` must NOT re-add or change it — leave the dep as-is. `vite.config.ts` still needs `optimizeDeps.include: ['handlebars']` (add a `resolve.alias` to `handlebars/dist/cjs/handlebars.js` ONLY if the build emits a `require is not defined` error — the verify step will surface it).

### Notes (pin; do not change behavior)
- **5th-positional-arg discipline (§2.9):** every `validateWorkflow` call MUST pass `promptCatalog` (or `undefined`) as the 5th arg — the 8 store sites + `run.ts` start()/runNested + `/api/validate`. tsc catches arity but NOT a forgotten `undefined`; thread the real catalog wherever one exists.
- **Option consistency is load-bearing:** a raw-string partial inherits the PARENT compile options at render time, so `PROMPT_COMPILE_OPTIONS` (`noEscape:true`) must be used for EVERY compile (R1 guarantees this) — never compile a partial body standalone without it.
- **Out of scope (noted):** the pre-existing `FileSidebar.handleOpenTool` → `/api/file?path=` route does not exist server-side (Tool-open toasts an error today). The prompt-open flow uses the REAL `/api/prompts/:tier/:name` route — do NOT copy the broken `/api/file` pattern. The Tools bug is a separate follow-up.
