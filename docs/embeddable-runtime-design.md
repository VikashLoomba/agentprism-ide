# AgentPrism — Embeddable Runtime + Typed Inputs (P1) — Locked Design

> **Historical design record (shipped).** Both P1 features described here shipped (commit `128c08c`), and the later Workspace refactor (`50970ca`) relocated the engine out of `server/` into `runtime/` (`server/workflow` → `runtime/engine`, etc.) and added first-class multi-workspace support. Paths below that read `server/...` are pre-relocation; the current architecture is in [`workspace-architecture-plan.md`](workspace-architecture-plan.md).

Status: **implementation contract**. Every implementer codes against the interfaces in this
document. If reality contradicts the doc, fix the doc (orchestrator) — do not silently diverge.

This delivers the full P1 feature in one branch (`feat/embeddable-runtime`):

1. **Typed workflow inputs** — a workflow may *optionally* declare typed `meta.inputs`, validated
   before a run starts, surfaced as a generated form in the IDE that gates Run, and enforced by the
   programmatic API.
2. **Single-core embeddable runtime** — one transport-agnostic engine. The IDE's WS/HTTP server is
   rewritten as a thin *adapter* over that same engine. The engine is published so a host app can
   `import` it and run workflows programmatically, receiving the **full event stream** and the
   **mid-run interaction round-trips** (permission + human-in-the-loop input).
3. **Packaging** — single npm package, multiple entry points: `npx agentprism-ide` boots the local
   IDE; `import { createRuntime } from 'agentprism'` runs workflows from the host's own program.

The governing principle: **the IDE server must be implementable as nothing but a consumer of the
published runtime API.** There is exactly one execution/event/interaction implementation. The WS
protocol is a *serialization* of the runtime API, not a parallel one.

---

## 1. Current architecture (verified)

- **Engine**: `WorkflowRun` (`server/workflow/run.ts`). Constructor `(request: RunRequest, callbacks: RunCallbacks)`.
  `RunCallbacks = { emit(event: RunEvent), notifyPermission(req: PermissionRequest) }` (`run.ts:52`).
  All events flow through the single `this.callbacks.emit(event)` (`run.ts:222`). Holds: per-backend
  ACP connection pool, `pendingPermissions: Map<requestId, resolver>` (`run.ts:183`), pause queue
  (`currentPause` / `waitingPauses`, `run.ts:181`). Public-ish: `start()`, `getSnapshot()`,
  `resume()`, `step()`, `resolvePermission()`, breakpoint setters.
- **WS coupling lives ONLY in** `RunManager` (`server/run-manager.ts`): owns `runs: Map<runId, {run, subscribers: Set<ws>}>`,
  `broadcast(runId, ServerMessage)`, and `handle(ClientMessage, ws)` (start/subscribe/resume/step/cancel/
  setBreakpoints/permission/ping). It constructs `WorkflowRun` with `emit → broadcast`,
  `notifyPermission → broadcast` (`run-manager.ts:47`). **It is already a pure consumer of `RunCallbacks`.**
- **HTTP/WS host**: `server/index.ts` — Express `/api/*` + `WebSocketServer({path:'/ws'})`; serves
  `dist/` via `express.static` when present. Runs TypeScript directly via tsx
  (`start: node --import tsx server/index.ts`). **Resolves `dist/` and agent bins via `process.cwd()`**
  (`server/index.ts:182`, `:31`) — a packaging bug to fix (see §6).
- **Mid-run input today**: (a) permission — ACP `requestPermission` → `decidePermission(ask)` returns a
  parked Promise (`run.ts:343`), surfaced via `notifyPermission`, resolved by `resolvePermission(requestId, response)`.
  (b) pause/breakpoint — `requestPause(info)` parked Promise, emitted `breakpoint:hit`, resolved by
  `resume()`/`step()`. (c) `checkpointFn` (`run.ts:707`) currently **auto-returns** (no real pause).
- **Inputs today**: `RunRequest.args?: unknown` (`shared/protocol.ts:17`) passed through untouched into
  the sandbox `args` global (`executor.ts:69`, `run.ts:754`). No validation. IDE enters it as a raw JSON
  textarea (`RunConfig.tsx:225`). Run gated by `validation.ok && wsStatus==='open' && !isActive`
  (`Header.tsx:24`). `args` typed as `any` in the workflow dts.
- **Meta validation**: AST-static. `validateWorkflow` → `evaluateLiteral` (rejects computed values) →
  `validateMeta` hand-rolled field checks (`shared/validate.ts:155`). `WorkflowMeta` type at `shared/dsl.ts:32`.
- **Prompt params (the model we mirror)**: `shared/prompt-frontmatter.ts` — `PromptParam {name,type,description?,default?,example?}`,
  closed union `PROMPT_PARAM_TYPES` (string/number/boolean + array variants), Zod `paramSchema`,
  `placeholderFor(type,name)`, `seedSampleData(params)`, `paramsToTsType(params)`, `TS_TYPE` map.

---

## 2. Target module layout (single package, multiple entry points)

```
runtime/                      NEW — transport-agnostic core (Node-only, no express/ws)
  index.ts                    public API: createRuntime, types (the "." export)
  run-controller.ts           registry + multi-listener fan-out + snapshot + interaction correlation
                              (the non-WS half of today's RunManager)
  resolve.ts                  resolve WorkflowRef {name|source} via existing workflow/catalog loaders
server/
  factory.ts                  NEW — createServer(runtime, opts): Express app + WS bridge (the "./server" export)
  index.ts                    becomes a thin bin-ish entry: build runtime + factory, listen()
  run-manager.ts              REWRITTEN — thin WS adapter over runtime (subscribe/broadcast/route)
  config.ts                   + packageRoot (asset/dist resolution) split from working dir
  workflow/run.ts             engine: input gate in start(); real checkpoint/input interaction
  acp/, store/, workflow/*    unchanged except where noted
shared/
  dsl.ts                      + WorkflowInputParam, meta.inputs
  param.ts                    NEW — neutral param primitives (type union + placeholderFor + paramsToTsType)
  prompt-frontmatter.ts       re-export from param.ts (keep PromptParam back-compat)
  validate.ts                 + meta.inputs shape validation
  validate-inputs.ts          NEW — validateInputs(inputs, values) (the reusable run gate)
  protocol.ts                 + input-interaction messages (additive; existing run protocol unchanged)
  events.ts                   + interaction request/result run events (additive)
src/ (frontend, WS protocol UNCHANGED except additive input dialog)
  features/run/RunConfig.tsx  generated typed-input form when meta.inputs present
  features/run/InputDialog.tsx NEW — mirrors PermissionDialog for human-in-the-loop input
  store/useStore.ts, store/runReducer.ts  inputValues + inputsValid + input interaction handling
  features/layout/Header.tsx  canRun += inputsValid
  lib/workflow-dts.ts, lib/dsl-registry.ts  typed `args` from meta.inputs
bin/
  agentprism-ide.mjs          NEW — `npx agentprism-ide` entry: boots server, serves bundled dist
package.json                  name, bin, exports, files, build:lib
```

**package.json shape** (name TBD — proposed `agentprism`; keep `private:true` until publish is decided):

```jsonc
{
  "name": "agentprism",
  "bin": { "agentprism-ide": "./bin/agentprism-ide.mjs" },
  "exports": {
    ".":        { "types": "./dist-lib/runtime/index.d.ts", "import": "./dist-lib/runtime/index.js" },
    "./server": { "types": "./dist-lib/server/factory.d.ts", "import": "./dist-lib/server/factory.js" }
  },
  "files": ["dist", "dist-lib", "bin", "shared", "tools", "prompts", "workflows"],
  "scripts": { "build:lib": "tsc -p tsconfig.lib.json", "build": "tsc -b && vite build && npm run build:lib" }
}
```

Publishable form requires a real JS build of runtime+server+shared (TS → `dist-lib` with `.d.ts`),
because import consumers won't run tsx. The `bin` runs built JS. (Phasing note for hardening: a v1
could ship tsx-based and defer the JS lib build — assess effort vs. value. Default target = real build.)

---

## 3. Core runtime API (the "." export — LOCKED)

```ts
// runtime/index.ts
export function createRuntime(options?: RuntimeOptions): Runtime

export interface RuntimeOptions {
  cwd?: string                       // default working dir for runs (NOT the package root)
  env?: NodeJS.ProcessEnv            // secret source; default process.env
  dirs?: Partial<CatalogDirs>        // override project/user tools|prompts|workflows dirs
}

export interface Runtime {
  run(workflow: WorkflowRef, input?: Record<string, unknown>, options?: RunOptions): RunHandle
  get(runId: string): RunHandle | undefined        // late-attach to an in-flight/finished run
  list(): RunHandle[]
  catalogs(): Promise<{ capabilities: CapabilityCatalog; prompts: PromptCatalog }> // reused by IDE server
}

export type WorkflowRef = { source: string } | { name: string }   // inline script | saved name

export interface RunOptions {
  agent?: AcpAgentId
  modeId?: string
  cwd?: string
  breakpoints?: number[]
  stepMode?: boolean
  maxConcurrency?: number
  tokenBudget?: number | null
  methodConfig?: Record<string, Record<string, unknown>>
  autoApprove?: boolean
  // Interaction ergonomic A — host supplies resolvers; engine awaits them directly.
  // If omitted, engine emits a request event and parks until RunHandle.respond().
  onPermission?: (req: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>
  onInput?: (req: InputRequest) => Json | Promise<Json>
}

export interface RunHandle {
  readonly runId: string
  snapshot(): RunSnapshot

  // Event stream — both ergonomics over the single emit seam.
  on(listener: (event: RunEvent) => void): () => void     // push; returns unsubscribe
  events(): AsyncIterable<RunEvent>                        // pull; buffered

  // Control (debug surface — IDE uses these; production hosts may ignore).
  resume(): void
  step(): void
  cancel(): void
  setBreakpoints(lines: number[]): void

  // Interaction ergonomic B — request arrives as an event carrying requestId; host answers later.
  respond(requestId: string, response: PermissionResponse | InputResponse): void

  readonly done: Promise<RunResult>
}

export interface RunResult { runId: string; status: 'completed' | 'failed' | 'cancelled'; result?: unknown; error?: string }

// Convenience for the common "fire and collect" case:
export function runWorkflow(workflow: WorkflowRef, input?: Record<string, unknown>, options?: RunOptions & RuntimeOptions): Promise<RunResult>
```

Notes:
- `run()` **validates `input` against the workflow's `meta.inputs` BEFORE starting** (via
  `validateInputs`). On failure it returns a `RunHandle` whose `done` rejects/resolves `failed` with the
  validation errors and emits a `run:finished` failed event — identical surface for IDE and host.
- `run-controller.ts` owns the registry + snapshot + multi-listener fan-out + interaction-id
  correlation that `RunManager` does inline today. `RunHandle` is a thin facade over a controller entry.
- The engine (`WorkflowRun`) is unchanged in spirit: it still takes a callbacks object. The controller
  supplies those callbacks (emit → fan-out to listeners; notifyPermission/notifyInput → interaction
  events + pending map). `RunHandle.respond/resume/step/cancel/setBreakpoints` delegate to the engine.

---

## 4. Interaction model (surfaces note #1: mid-run user input)

Unify every mid-run input as **typed request out (event, with `requestId`) + response in**, with two
host ergonomics over one mechanism (resolver callback OR `respond()`), generalizing today's
`autoApprove`/`decidePermission`.

- **Permission** (exists): keep `PermissionRequest`/`PermissionResponse`. Now also resolvable via
  `RunOptions.onPermission` and `RunHandle.respond`. Existing WS path preserved.
- **Input / human-in-the-loop** (new): make `checkpoint()` (and a new explicit `input()` DSL helper, TBD)
  a real interaction. `checkpointFn` stops auto-returning; instead emits an interaction request and parks
  a Promise in a `pendingInputs: Map<requestId, resolver>`, resolved by `onInput` or `respond()`.

```ts
// shared/protocol.ts (additive)
export interface InputRequest {
  requestId: string
  kind: 'confirm' | 'input' | 'select'
  prompt: string
  options?: { id: string; label: string }[]   // for 'select'
  default?: Json
  agentId?: string
}
export type InputResponse = { kind: 'value'; value: Json } | { kind: 'cancelled' }

// ServerMessage += { t: 'input'; runId; req: InputRequest }
// ClientMessage += { t: 'input'; runId; requestId; response: InputResponse }
// shared/events.ts RunEvent += { type: 'interaction:request', req } | { type: 'interaction:resolved', requestId }
```

Distinction baked in: **semantic interactions** (permission, input — production hosts care) vs **debug
controls** (breakpoints/step — IDE-only). Same core; a host implements only what it needs.

---

## 5. Typed inputs (step 1 detail)

```ts
// shared/param.ts (NEW, neutral)
export const PARAM_TYPES = ['string','number','boolean','string[]','number[]','boolean[]'] as const
export type ParamType = (typeof PARAM_TYPES)[number]
export function placeholderFor(type: ParamType, name: string): Json   // moved from prompt-frontmatter
export function paramsToTsType(params: { name: string; type: ParamType; description?: string; optional?: boolean }[]): string
// prompt-frontmatter.ts re-exports PROMPT_PARAM_TYPES = PARAM_TYPES etc. (back-compat, no behavior change)

// shared/dsl.ts
export interface WorkflowInputParam {
  name: string            // JS identifier → key on `args`
  type: ParamType
  description?: string
  default?: Json
  required?: boolean      // default false
}
export interface WorkflowMeta { /* …existing… */ inputs?: WorkflowInputParam[] }

// shared/validate-inputs.ts (NEW — the reusable run gate)
export interface InputValidationResult { ok: boolean; value: Record<string, Json>; errors: string[] }
export function validateInputs(inputs: WorkflowInputParam[] | undefined, values: unknown): InputValidationResult
// - inputs undefined/empty → { ok:true, value: (values as object) ?? {} }  (back-compat: free-form args still pass)
// - required & missing → error; type mismatch → error; coerce only obvious (numeric string→number? NO, strict)
// - unknown extra keys when inputs declared → warn-or-drop (decision: drop, keep value clean)
```

- **`validateMeta`** gains an `inputs` block check (hand-rolled to match its style, OR reuse a small Zod
  schema — `zod` is already a dep used in shared/prompt-frontmatter.ts). Validates: array; each entry name
  is identifier, type ∈ PARAM_TYPES, `default` matches type, `required` boolean.
- **Typed `args` dts**: when `meta.inputs` present, emit `declare const args: <paramsToTsType(inputs)>`
  (required→`name:`, optional→`name?:`); else keep `args: any` (back-compat). Lives in
  `src/lib/workflow-dts.ts` / `dsl-registry.ts`.
- **Engine gate**: `WorkflowRun.start()` runs `validateInputs(meta.inputs, request.args)` after
  `validateWorkflow`, before VM exec; failure → fail the run with the error list (no VM start).
- **IDE form** (`RunConfig.tsx`): when `meta.inputs` present, render a control per param (string→text,
  number→number, boolean→switch, arrays→one-value-per-line for v1); seed from `default`; required-empty
  disables Run via `inputsValid` fed into `canRun` (`Header.tsx`). No inputs → existing raw JSON textarea.
  `meta.inputs` is already extracted client-side by `validateWorkflow` (verify it surfaces the parsed
  meta; if not, add a light `extractInputs(source)`).

Defaults locked: name `meta.inputs`; `required?` default false; arrays = one-per-line v1; when inputs
declared the form *is* `args` (raw textarea hidden behind an "advanced" toggle); strict types, minimal coercion.

---

## 6. Packaging details

- **packageRoot vs workingDir**: add `PACKAGE_ROOT` (from `import.meta.dirname`) to `server/config.ts`.
  `dist/` static serving and bundled-agent-bin lookups use `PACKAGE_ROOT`; `DEFAULT_CWD` / run `cwd` and
  project `tools/|prompts/|workflows/` resolution stay relative to the user's working dir. This is what
  makes `npx agentprism-ide` work from an arbitrary project directory.
- **bin** `bin/agentprism-ide.mjs`: resolve package root, ensure `dist/` exists (built), start the server
  via `createServer(createRuntime())` and `listen()`. Pass through `--port`, `--cwd` flags (minimal).
- **Secrets invariant preserved**: secret *values* still come only from `env` (default `process.env`),
  never UI-entered, never sent to the browser, never persisted. `RuntimeOptions.env` is the single source.
- **build:lib**: `tsconfig.lib.json` emits `runtime/`, `server/`, `shared/` to `dist-lib/` as ESM JS +
  `.d.ts`. `exports` point there. (Frontend stays `dist/` via vite.)

---

## 7. Invariants (do not break)

1. **Frontend WS protocol stays working.** All existing `ClientMessage`/`ServerMessage`/`RunEvent`
   shapes keep their meaning; changes are *additive* (input interaction). The frontend must run unchanged
   except for the new input dialog + typed-input form.
2. **Back-compat for untyped workflows.** No `meta.inputs` ⇒ today's behavior byte-for-byte (free-form
   args, `args:any`, no gating).
3. **Determinism** of the sandbox unchanged (no Date.now/Math.random/new Date in workflow bodies).
4. **Secrets** never reach the browser/storage; env-only.
5. **One engine.** No second execution/event/interaction path. The IDE server only *adapts*.

---

## 8. Work units (DISJOINT file ownership for fan-out)

Wave 1 (foundational, parallel):
- **UNIT A — Inputs & params (shared + client dts)**: `shared/param.ts`(new), `shared/dsl.ts`,
  `shared/validate.ts`, `shared/validate-inputs.ts`(new), `shared/prompt-frontmatter.ts`(re-export only),
  `src/lib/workflow-dts.ts`, `src/lib/dsl-registry.ts`. Self-contained type+validation layer.
- **UNIT B — Engine + core runtime + interactions**: `server/workflow/run.ts`, `server/workflow/executor.ts`,
  `runtime/index.ts`(new), `runtime/run-controller.ts`(new), `runtime/resolve.ts`(new),
  `shared/protocol.ts`, `shared/events.ts`. The heart; strongest agent / highest effort.

Wave 2 (depend on A+B's real code; parallel):
- **UNIT C — IDE server adapter**: `server/factory.ts`(new), `server/index.ts`, `server/run-manager.ts`,
  `server/config.ts`.
- **UNIT D — Frontend form + input dialog + gating**: `src/features/run/RunConfig.tsx`,
  `src/features/run/InputDialog.tsx`(new), `src/store/useStore.ts`, `src/store/runReducer.ts`,
  `src/features/layout/Header.tsx`.
- **UNIT E — Packaging**: `package.json`, `bin/agentprism-ide.mjs`(new), `tsconfig.lib.json`(new).

Wave 3:
- **UNIT F — Docs/skill**: `README.md`, `.claude/skills/agentprism-authoring/workflows.md`,
  `examples/embed/`(new minimal host demo).
- **Verify**: `tsc -b` + `tsc -p tsconfig.server.json` + `oxlint` + `vite build`; adversarial diff review.

No two units write the same file. C/D/E read the real A/B output (Wave-1 barrier before Wave 2).

---

## 9. Open questions for design-hardening to confirm

1. Does `validateWorkflow` already return the parsed `meta` (so the client form + dts can read
   `meta.inputs`)? If not, the cheapest way to surface it.
2. Exact `RunSnapshot` shape (`shared/events.ts`) — what the controller must reconstruct for late-attach.
3. Is the JS lib build (`dist-lib`) worth it for v1, or ship tsx-based importable first? (Effort vs value.)
4. Does the `start`-message → `RunRequest` path need a new field for declared-input values, or do they
   just populate `args`? (Default: they populate `args`; the form builds the args object.)
5. Any consumers of `WorkflowRun`/`RunManager` beyond `server/index.ts` that the refactor must preserve?
6. `checkpoint()` real-interaction change: does any existing workflow/test rely on its current
   auto-return behavior? (Back-compat: default to auto-resolve when no `onInput`/no UI attached?)

---

## 10. Hardening addenda (VERIFIED — these OVERRIDE §1–§9 on any conflict)

Confirmed against the real code. Implementers follow §10 where it refines an earlier section.

### 10.0 v1 scope decisions (locked)
- **`RuntimeOptions.env`**: THREAD it into the engine (see 10.B.3). Preserves the secrets invariant and
  keeps env off the wire/browser.
- **`RuntimeOptions.dirs` / `CatalogDirs`**: **v1 NON-GOAL** — no such type exists and catalog paths are
  eager module consts. Catalogs resolve from `process.cwd()` and the **already-supported** env vars
  `AGENTPRISM_WORKFLOWS_DIR | AGENTPRISM_TOOLS_DIR | AGENTPRISM_PROMPTS_DIR | AGENTPRISM_DEFAULT_CWD`
  (`server/config.ts`). Drop `dirs` from `RuntimeOptions`; document the env vars instead. Per-run
  execution `cwd` already works via `RunRequest.cwd`/`RunOptions.cwd` — keep it.
- **`.ts` tool loading**: keep **`tsx` as a runtime dependency**; the bin runs `node --import tsx`, and the
  programmatic entry documents Node+tsx. Do not attempt to drop tsx in v1.
- **Lib build**: real JS build via **`tsconfig.lib.json` with `rewriteRelativeImportExtensions: true`**
  (not a bundler). See 10.E.

### 10.A — Inputs / params / dts (corrections)
- `validateWorkflow` **already returns parsed `meta`** (`ValidateResult.meta?: WorkflowMeta`,
  `shared/validate.ts:39-51,320,~521`). **Delete the `extractInputs` fallback** (§5/§9-Q1) — the client
  reads `useStore((s) => s.validation.meta?.inputs)` exactly like `meta.capabilities`. **Caveat:** `meta`
  is `undefined` whenever the meta literal has ANY validation error (`validate.ts:317-320`) — form +
  gating MUST treat `meta===undefined` as "no declared inputs" (fall back to raw args, `inputsValid=true`).
- `args: any` is a **static string** in `shared/dsl-registry.ts:248` (NOT `src/lib/dsl-registry.ts` —
  that path doesn't exist), concatenated by `buildWorkflowDts` (`src/lib/workflow-dts.ts:226`). The real edit:
  1. add `inputs?: WorkflowInputParam[]` param to `buildWorkflowDts` (`workflow-dts.ts:209-214`) **and** to
     `workflowDtsFor` (`src/store/useStore.ts:30-42`); thread `validation.meta?.inputs` through **all 8**
     `workflowDtsFor` call sites in `useStore.ts` (lines 309, 345, 382, 433, 461, 498, 587, 665);
  2. when inputs present, **filter out** the static `'args'` `DSL_METHODS` entry and **append** a generated
     `declare const args: <paramsToTsType(inputs)>` — REPLACE, never duplicate (a second top-level
     `declare const args` voids DSL intellisense; `workflow-dts.ts:171-174`, `'args'` ∈ `CAPABILITY_RESERVED_NAMES`);
  3. keep `args: any` for the no-inputs path, `INITIAL_WORKFLOW_DSL_DTS` (`workflow-dts.ts:238`), and the
     monaco bootstrap (`src/lib/monaco-setup.ts:30,78`).
- `WorkflowMeta` is **hand-duplicated** in the dts PREAMBLE string (`src/lib/workflow-dts.ts:52-67`) — add
  `inputs?` there too so it shows in `meta`-literal intellisense.
- `placeholderFor`, `TS_TYPE`, `paramSchema` are **private** in `prompt-frontmatter.ts` (only
  `PROMPT_PARAM_TYPES`, `PromptParamType`, `seedSampleData`, `paramsToTsType`, `parsePrompt`, `ParsedPrompt`,
  `PromptParam` are exported). Moving `placeholderFor`/types to `shared/param.ts` is net-new (no importer to
  update). The re-export shim in `prompt-frontmatter.ts` MUST keep exporting the 7 currently-public symbols.
  Importers to keep working: `seedSampleData` → `HandlebarsPreview.tsx:5,34`; `paramsToTsType` →
  `prompt-loader.ts:13,46`.
- Shared `paramsToTsType` must accept a param type **both** `PromptParam` and `WorkflowInputParam` satisfy.
  Map `WorkflowInputParam.required===true → \`name:\`` else `\`name?:\``.
- Keep `validateMeta` **hand-rolled** (zod is NOT imported in `validate.ts`; matching style beats a new dep
  path). `evaluateLiteral` needs **no change** (it already evaluates array-of-object-literals like `phases`;
  nested-array `default`s work). Note: `default: undefined` throws — omit the key instead.

### 10.B — Engine + runtime core (corrections)
- WorkflowRun public surface (verified): `constructor(request, callbacks)`, `start():Promise<void>`,
  `getSnapshot():RunSnapshot`, `isDone():boolean`, `setBreakpoints(lines)`, `resume()`, `step()`,
  `cancel()` (**no `abort()`** — `run.ts:319`), `resolvePermission(requestId, response)`.
- **Engine MUST grow for the input interaction**: `RunCallbacks += notifyInput(req: InputRequest)`;
  add `pendingInputs: Map<requestId, resolver>` + `resolveInput(requestId, InputResponse): void` mirroring
  `pendingPermissions`/`resolvePermission` (`run.ts:183,334`). `RunHandle.respond` routes
  PermissionResponse→`resolvePermission`, InputResponse→`resolveInput`.
- **`RuntimeOptions.env` threading**: add an options param to the WorkflowRun constructor (e.g.
  `constructor(request, callbacks, opts?: { env?: NodeJS.ProcessEnv })`, default `process.env`). Replace the
  two hardcoded sites: `ctxFor` secrets (`run.ts:609`) and `loadCapabilities(process.env)` (`run.ts:796`)
  with `this.env`. **Do NOT** put env on `RunRequest` (it must never serialize to the browser).
- **`done` must settle on `start()` rejection.** `start()` can throw before emitting `run:finished`
  (`validateWorkflow run.ts:813`, `resolveConfigs run.ts:848`, methodConfig loop — all outside the try at
  `run.ts:870`). The controller attaches to `start().catch()` and settles `done` as `failed` (synthesizing a
  failed `run:finished` for listeners), exactly as RunManager does today (`run-manager.ts:62-68`).
- **`RunResult`** is built from the terminal `run:finished` event `{status, result, error, stats}`
  (`run.ts:905`; result captured at `run.ts:876-878`, stored `snapshot.result`). status ∈
  `completed|failed|cancelled`.
- **`snapshot()` must `structuredClone`** the engine's snapshot — `getSnapshot()` returns the LIVE mutable
  ref (`run.ts:212-214`), safe today only because RunManager JSON-serializes it.
- **Controller owns a replayable interaction registry.** `RunSnapshot` has NO pending-interaction field and
  `pendingPermissions`/`pendingInputs` are engine-private. The controller tracks outstanding
  permission/input requests (it sees them via `notifyPermission`/`notifyInput`) and **replays them on
  `subscribe`/`get`** so a late attacher isn't stuck. Clear on resolve.
- **`checkpoint()` → real interaction.** `checkpointFn` (`run.ts:707-712`) currently auto-returns; ZERO
  workflows/tests depend on it. New behavior: emit `interaction:request` + park a Promise in `pendingInputs`
  + `notifyInput(req)`; resolve via `onInput`/`resolveInput`. **Headless back-compat:** when no resolver/UI is
  attached, honor the already-declared-but-unused `CheckpointOptions.headless` (`executor.ts:11`):
  `'abort'`→throw/cancel, else (default) return `opts.default` (preserving today's auto behavior). Keep the
  `this.aborted` guard at entry.
- **`WorkflowRef {name}` resolution**: `resolve.ts` must `readWorkflow(name)` (`store/workflows.ts:32`) to a
  source string before constructing `RunRequest` (the engine only reads `request.source`). Controller defaults
  `RunOptions.agent` (optional) to a real `AcpAgentId` (`'claude'`); `RunRequest` requires `runId, source,
  agent, cwd, breakpoints`.
- Only consumers of WorkflowRun/RunManager are `run-manager.ts` and `server/index.ts` — blast radius is
  contained; `run-controller.ts` becomes the sole consumer of WorkflowRun.

### 10.C / 10.E — Server adapter + packaging (corrections)
- **OWNERSHIP ADD → UNIT C**: `server/acp/connection.ts` (the agent-bin **spawn** resolver at
  `connection.ts:113` uses `process.cwd()`; fixing only `index.ts:31-33` makes agents show installed yet fail
  to spawn from an arbitrary cwd). Centralize bin resolution in `config.ts` and call it from both sites.
- **PACKAGE_ROOT vs user-cwd**: move to PACKAGE_ROOT → `dist/` static serving (`index.ts:182`), agent-bin
  presence check (`index.ts:31-33`), agent-bin spawn (`connection.ts:113`). Stay user-cwd → `WORKFLOWS_DIR`,
  `DEFAULT_CWD`, `PROJECT_TOOLS_DIR`, `PROJECT_PROMPTS_DIR`, `RunRequest.cwd`. Derive PACKAGE_ROOT robustly
  (walk up to nearest `package.json`) — the `import.meta.dirname`→`dist/` offset differs between tsx-run
  (`server/` → `../dist`) and compiled (`dist-lib/server/` → `../../dist`); a fixed offset breaks one mode.
- **`build:lib`** = `tsc -p tsconfig.lib.json` with `tsconfig.lib.json`: clone `tsconfig.server.json` shape;
  `include: ['runtime','server','shared']`; **exclude `src/`** (frontend/DOM); `noEmit:false`,
  `declaration:true`, `outDir:'dist-lib'`, `rootDir:'.'`, **`rewriteRelativeImportExtensions:true`**. Confirmed
  no server/shared file imports from `src/`, so excluding src is safe. `exports` point at
  `dist-lib/runtime/index.js` + `dist-lib/server/factory.js`.
- **Dependencies**: move `typescript` AND `tsx` from devDependencies → dependencies (both are runtime imports:
  `inline.ts:5`, `derive-capability-dts.ts:11`, and tsx is the `.ts` loader). `.gitignore` adds `dist-lib`;
  `dist` stays gitignored so a `build` (vite) must run before pack/publish (`files` includes `dist`).
- **RunManager behavior to preserve EXACTLY** in the controller+adapter (invariant §7.1): reject duplicate
  active runId with `{t:'error'}`; `emit → {t:'event'}`, on `run:finished` set finishedAt + prune to **25**
  most-recent finished; `notifyPermission → {t:'permission'}`; send `{t:'snapshot'}` **before** `start()`;
  `start().catch → {t:'error'}`; subscribe→add ws + send snapshot (late-attach); permission→`resolvePermission`
  + `{t:'permission:resolved'}`; ping→pong; `removeClient` deletes ws from every run's subscribers but **never
  cancels** the run (runs persist with zero subscribers). `{t:'hello'}` is sent by the connection handler, not
  the manager.

### 10.D — Frontend (corrections)
- meta.inputs reaches the client **synchronously** via in-process `validateWorkflow` (`useStore.ts:16,171`).
  **`/api/validate` has ZERO client consumers** — drop that framing. No new plumbing beyond reading
  `validation.meta?.inputs`.
- `startRun` (`useStore.ts:597-621`): when `meta.inputs` present, set `args: inputValues` (new store field)
  instead of `parseArgs(argsText)`. Seed `inputValues` from each param's `default` and **re-seed when
  `meta.inputs` changes** (no existing hook resets per-run input state — stale values otherwise leak across
  workflows). Clear `input:null` in startRun (like `permission:null`).
- **InputDialog mirrors PermissionDialog, which is TOP-LEVEL store state — NOT the snapshot, NOT runReducer.**
  Touch points: store `input: InputRequest|null` (+init); `onServerMessage` `case 'input'`/`case 'input:resolved'`;
  `respondInput(response)`; mount `<InputDialog/>` at **`src/App.tsx:81`** next to `<PermissionDialog/>`.
  **OWNERSHIP ADD → UNIT D**: `src/App.tsx`. **DROP `src/store/runReducer.ts` from UNIT D** (the interaction
  doesn't touch it).
- **Protocol fix**: add `ServerMessage { t:'input:resolved'; runId; requestId }` (mirror `permission:resolved`)
  — §4 omitted it; without it the dialog can't clear when answered out-of-band via `onInput`.
- `InputRequest.options` is `{id,label}[]` vs `PermissionOption {optionId,name,kind}` — option rendering is
  NOT byte-for-byte copyable.
- `Header.tsx:24`: `canRun = validation.ok && inputsValid && wsStatus==='open' && !isActive`. `inputsValid`
  (store-derived from `inputValues` + `meta.inputs` via `validateInputs`) **defaults true** when
  `meta.inputs` is absent/empty/`meta===undefined` (invariant §7.2). Extend the disabled title to say
  "Fill required inputs" when `!inputsValid`.
- **Two-transport resolution (UNIT C ⇄ UNIT D agree):** the **WS frontend uses the dedicated
  `{t:'input'}`/`{t:'input:resolved'}` ServerMessages** (exact permission mirror, handled in `onServerMessage`,
  runReducer untouched). The `RunEvent interaction:request/resolved` form is **only** for the programmatic
  runtime consumer (`on()`/`events()`), surfaced by the controller in addition to the callback. The WS adapter
  does NOT deliver interactions via the `{t:'event'}` channel.
- All UI primitives exist (`Input` incl. `type="number"`, `Switch`, `Select`, `Textarea`, `Dialog` set) —
  zero new primitives needed.
