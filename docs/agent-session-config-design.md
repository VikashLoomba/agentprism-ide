# Design: replace `agent()` `tier` with a per-call ACP session-config object

> Status: **IMPLEMENTED & SHIPPED** (feasibility-verified against
> `@agentclientprotocol/sdk@1.0.0`). Produced by the `design_agent_session_config`
> ultracode workflow (4 research agents → synthesis → adversarial feasibility),
> with the feasibility pass's 6 corrections folded in. This document is retained as
> the design record; the file/line references describe the code as it was wired in.

## Goal

Remove the unused `opts.tier: 'small'|'medium'|'big'` knob from the DSL `agent()`
call and replace it with a **per-call `opts.config` object** whose properties are
the ACP **Session Config Options** each agent advertises — model selection, mode,
reasoning effort, and provider-specific options — wired from Monaco intellisense +
diagnostics all the way down to the real ACP session initialization at execution.

---

## 1. Verified SDK facts (the mechanism)

All confirmed by reading `node_modules/@agentclientprotocol/sdk/dist/...` and both agent libs:

- **`SessionConfigOption`** is a discriminated union (`types.gen.d.ts:2584`):
  - `type:'select'` → `currentValue: SessionConfigValueId` + `options: [{ value, name, description? }]` (and optional groups)
  - `type:'boolean'` → `currentValue: boolean` (marked UNSTABLE)
  - common fields: `id` (`SessionConfigId`), `name`, `description?`, `category?` (`'mode'|'model'|'model_config'|'thought_level'|` custom string)
- **Advertised** on `NewSessionResponse.configOptions` (also load/fork/resume). There is **no list call** and **no agent-side capability gate** for receiving them.
- **Set** via `ctx.request(methods.agent.session.setConfigOption, { sessionId, configId, value })` — the wire method is `session/set_config_option`. The response returns the **full, reconciled** `configOptions` array.
- There is **no `setConfig` wrapper** on `ClientContext` or `ActiveSession`. `ActiveSession` exposes `.sessionId`, `.modes`, `.meta`, `.newSessionResponse` (→ `.configOptions`), `.prompt()`, `.nextUpdate()`, `.dispose()` — **no `.configOptions` getter** (read it off `.newSessionResponse`).
- **When:** `NewSessionRequest` has **no config-seed field**, so config is applied **after** `buildSession().start()`, **before** the first `prompt()`. Each `agent()` call already opens its own session → **per-call config == per-session config**, naturally.
- **Modes are not a separate axis** — a mode is just the config option with `category:'mode'` / `id:'mode'`; config options supersede the legacy `session/set_mode`.
- There is a `config_option_update` `SessionUpdate` variant — agents can push option changes mid-session (useful for the live-UI enhancement, §6).

**Per-agent option sets (verified in the libs):**

| Agent | `id`s advertised | Notes |
|---|---|---|
| **Claude** (`claude-agent-acp@0.51.0`) | `mode`, `model`, `effort` (`category: thought_level`), `agent` | all `select`. `effort` values come from the **selected model's** `supportedEffortLevels` and the option is **omitted** when the model doesn't support effort. `agent` exists **only if** custom agents are configured. Setting `model` **rebuilds** the effort option. Model aliases (`'opus'`,`'sonnet'`) are fuzzy-resolved. |
| **Codex** (`codex-acp`) | `mode`, `model`, `reasoning_effort` (`thought_level`), `fast-mode` | all `select`. `mode` = `read-only`/`agent`/`agent-full-access`. `reasoning_effort` values are runtime-discovered (`supportedReasoningEfforts`). `fast-mode` = `on`/`off`. Codex **throws `invalidParams`** on a non-string value or unknown `configId`. |

> Key correction from feasibility: **neither agent currently emits any `boolean`
> option, and effort/reasoning_effort vocabularies are runtime-discovered, not
> static.** The design treats model/effort/reasoning_effort/agent as **open**
> (suggest-only), and never sends a boolean unless a live option's `type` is `'boolean'`.

---

## 2. The new `agent()` options shape

### Runtime type — `shared/dsl.ts`
```ts
// REMOVE: export type ModelTier = 'small' | 'medium' | 'big'

/**
 * Per-call ACP session configuration. Keys are SessionConfigOption ids
 * advertised by the *selected* agent (chosen in the run config). Values are
 * SessionConfigValueId strings (booleans only for the experimental boolean
 * option type, which no current agent emits). Applied via
 * `session/set_config_option` after the session opens, before the first prompt.
 * Unknown ids / invalid values are warned-and-ignored at runtime, never fatal.
 *
 *   Claude: model | mode | effort | agent
 *   Codex:  model | mode | reasoning_effort | fast-mode
 */
export type AgentSessionConfig = Record<string, string | boolean>

export interface AgentOptions {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  config?: AgentSessionConfig   // NEW — replaces both `tier` and `model`
  // model?: string             // REMOVED → use config.model
  // tier?: ModelTier           // REMOVED
  isolation?: IsolationMode
  agentType?: string
  timeoutMs?: number | null
  retries?: number
}
```
- `opts.model` is **folded into** `config.model` (the ACP `model` option is the authoritative selector for both agents; a second channel would diverge).
- The runtime type stays a loose `Record` because the runtime can't know which agent is selected. The **`.d.ts` is where it narrows** (§3).

### Example calls
```js
// Claude: model + reasoning effort + plan mode for one call.
const plan = await agent('Draft a migration plan',
  { label: 'Migration plan', config: { model: 'opus', effort: 'high', mode: 'plan' } })

// Codex: cheap fast pass.
const triage = await agent('Triage these lint errors',
  { config: { model: 'gpt-5-codex', reasoning_effort: 'low', 'fast-mode': 'on' } })

// Provider-agnostic categories both agents share.
const review = await agent('Review the diff', { schema, config: { model: 'sonnet' } })
```

---

## 3. Monaco diagnostics (the crux): static catalog + per-agent validator

### 3.1 Catalog lives in `shared/agents.ts` (mirrors the `defaultModes` precedent)
```ts
export interface ConfigOptionValue { value: string; name: string; description?: string }
export interface ConfigOptionCatalogEntry {
  id: string
  name: string
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | string
  type: 'select' | 'boolean'
  values?: ConfigOptionValue[]   // statically-known values (completion hints)
  open?: boolean                 // more values exist at runtime → never hard-reject unknowns
  conditional?: boolean          // option may be absent depending on model/settings → never warn-if-missing
}
export interface AcpAgentSpec {
  /* ...existing... */
  defaultModes: SessionModeState
  configCatalog: ConfigOptionCatalogEntry[]   // NEW
}
```

**Populated (corrections applied — `model`/`effort`/`reasoning_effort`/`agent` are `open`):**
- **claude:** `mode` (select, fixed vocab — reuse `defaultModes`), `model` (select, `open`), `effort` (select, `open` + `conditional`, hints `low|medium|high|xhigh|max`), `agent` (select, `open` + `conditional`).
- **codex:** `mode` (select, fixed `read-only|agent|agent-full-access`), `model` (select, `open`), `reasoning_effort` (select, `open` + `conditional`, hints `low|medium|high`), `fast-mode` (select, fixed `on|off`).

This single catalog feeds **both** the `.d.ts` generator and the validator.

### 3.2 Generated `.d.ts` — `src/lib/workflow-dts.ts`
Remove `type ModelTier`; replace `tier?` with `config?: WorkflowAgentConfig`, generated from `ACP_AGENTS[*].configCatalog`:
```ts
interface WorkflowAgentConfig {
  /** AI model (selected agent's vocabulary; account-specific ids also accepted). */
  model?: "default" | "opus" | "sonnet" | "haiku" | "gpt-5-codex" | (string & {});
  /** Session mode / permission level. */
  mode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions"
       | "read-only" | "agent" | "agent-full-access" | (string & {});
  /** Reasoning effort (Claude; values depend on the selected model). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | (string & {});
  /** Reasoning effort (Codex; values depend on the selected model). */
  reasoning_effort?: "low" | "medium" | "high" | (string & {});
  /** Fast mode (Codex). */
  "fast-mode"?: "on" | "off";
  /** Custom agent persona (Claude; only when custom agents are configured). */
  agent?: string;
  /** Forward-compat: any other configId the selected agent advertises. */
  [configId: string]: string | boolean | undefined;
}
```
- `(string & {})` keeps literal completions **and** accepts runtime model ids (no false red-underline). The open index signature keeps unknown-but-valid agent-specific ids from being type errors.
- `monaco-setup.ts` needs **no mechanical change** (it injects whatever `WORKFLOW_DSL_DTS` produces; semantic validation stays off). Red squiggles come from `shared/validate.ts`, not the TS checker.

### 3.3 Diagnostics keyed by the selected agent — `shared/validate.ts`
- `validateWorkflow(source, selectedAgentId?)` — new optional param (default keeps current behavior / a union-of-all-agents mode for the pre-agent-list init call).
- In the AST walk, when `name === 'agent'`, find the 2nd-arg `ObjectExpression` → its `config` property → statically evaluate keys/values with the existing `evaluateLiteral`. Validate against `ACP_AGENTS[selectedAgentId].configCatalog`:
  - unknown `configId` for that agent → **warning** (catalog is static, may lag).
  - known **non-`open`, non-`conditional`** option with out-of-vocab value (e.g. `mode`, `fast-mode`) → **warning**.
  - `open` options (`model`/`effort`/`reasoning_effort`/`agent`) → **never** flag values (runtime-discovered).
  - literal `tier` key present → **deprecation warning** ("`tier` is removed; use `config: { model, effort }`").
  - only static-literal config is checked; interpolated/dynamic config is skipped (no false errors). **All warnings, never errors** — dynamic configs must not block runs.
- **Re-validate on agent switch:** extend `setSelectedAgent` in `src/store/useStore.ts` to recompute `validation: validateWorkflow(get().source, id)` (today it only sets `selectedAgent`/`selectedMode`, so without this the markers wouldn't refresh).

---

## 4. Execution wiring

Path: **vm `agent()` → `run.ts runAgent(opts)` → `connection.runPrompt({config})` → `buildSession().start()` → read `newSessionResponse.configOptions` → ordered `setConfigOption` loop → `prompt()`**.

### 4.1 `server/acp/connection.ts`
```ts
// client capabilities (start()): advertise boolean support for forward-compat.
clientCapabilities: { fs: { /* existing */ }, session: { configOptions: { boolean: {} } } }

export interface PromptTurnOptions {
  cwd: string
  modeId?: string
  prompt: PromptInput
  config?: Record<string, string | boolean>          // NEW
  onConfigOptions?: (opts: SessionConfigOption[]) => void  // NEW (live catalog → UI)
  /* ...existing... */
}
export interface PromptTurnResult { configOptions?: SessionConfigOption[]; /* ...existing... */ }
```
Apply block (after `start()`, **before** `prompt()`):
```ts
const session = await ctx.buildSession(opts.cwd).start()
let liveConfig = session.newSessionResponse.configOptions ?? []   // no .configOptions getter
opts.onConfigOptions?.(liveConfig)

// Merge run-wide mode (legacy modeId) with per-call config; config.mode wins.
const merged: Record<string, string | boolean> = {
  ...(opts.modeId ? { mode: opts.modeId } : {}),
  ...(opts.config ?? {}),
}
// CORRECTION: apply `model` FIRST — setting model rebuilds effort options.
const ordered = Object.entries(merged).sort(([a], [b]) => (a === 'model' ? -1 : b === 'model' ? 1 : 0))

for (const [configId, value] of ordered) {
  const opt = liveConfig.find((o) => o.id === configId)
  if (!opt) { log('warn', 'set_config', `unknown config id "${configId}" — ignored`); continue }
  if (opt.currentValue === value) continue                       // no-op
  // CORRECTION: only send boolean shape when the LIVE option is boolean.
  const params = opt.type === 'boolean'
    ? { sessionId: session.sessionId, configId, type: 'boolean' as const, value: !!value }
    : { sessionId: session.sessionId, configId, value: String(value) }
  try {
    const res = await ctx.request(methods.agent.session.setConfigOption, params)
    if (res?.configOptions) liveConfig = res.configOptions       // re-read reconciled set
  } catch (e) {
    log('warn', 'set_config', `failed to set ${configId}=${String(value)}: ${String(e)}`) // continue, never abort
  }
}
const promptResult = await session.prompt(/* ... */)
```
- Each set is **individually** try/caught and `continue`s on error → one bad value warns + the prompt still runs with the agent's default (both libs *throw* on invalid value, so this matters).
- Call via `ctx.request(methods.agent.session.setConfigOption, …)` — there is no `ActiveSession.setConfig`.

### 4.2 `server/workflow/run.ts`
- Drop `tier` from the `AgentCallState` write and the dead `Requested model=…/tier=…` routing log; emit a config summary instead (`model=opus effort=high mode=plan`).
- Pass `config: opts.config` (and optional `onConfigOptions`) into `runPrompt`. Keep `modeId: this.modeId` (run-wide default still honored; per-call `config.mode` overrides it).
- **Do not** route agent `config` through the combinator `resolveConfigs`/`methodConfigs` system — that's a separate axis (verify/judgePanel tunables).

---

## 5. Validation layering (summary)
- **Author-time (Monaco):** `validateWorkflow(source, selectedAgentId)` catalog check → warnings.
- **Server pre-run:** same catalog check keyed by the **actually selected** agent, warnings into the run log (mirrors the existing `meta.config` pre-run check).
- **Runtime authority:** the live `newSessionResponse.configOptions` in `connection.ts` — unknown id / invalid value → warn + skip, never throw.

---

## 6. Migration
- Remove `tier`/`ModelTier`/`model?` from: `shared/dsl.ts`, `shared/events.ts` (`AgentCallState.tier` → `config?: Record<string,string|boolean>`), `src/lib/workflow-dts.ts`, `server/workflow/run.ts` (log), `src/features/run/RunTree.tsx` (badge → render `config`/model), `README.md`, examples.
- **Existing `tier` scripts:** warn + ignore (never hard-error) — they stay runnable; the validator deprecation warning is the migration signal.
- **Example remaps:** `small → { model:'haiku' }` (Claude) / `{ model:'gpt-5-codex', reasoning_effort:'low' }` (Codex); `medium → { model:'sonnet' }`; `big → { model:'opus', effort:'high' }`.

---

## 7. Phased implementation plan (one agent per file)

**Phase A — foundation (gate; merge first):**
| File | Change |
|---|---|
| `shared/agents.ts` | Add `ConfigOptionValue`/`ConfigOptionCatalogEntry` + `configCatalog` to `AcpAgentSpec`; populate claude + codex catalogs (§3.1, with open/conditional flags). |
| `shared/dsl.ts` | Remove `ModelTier`; remove `AgentOptions.tier` + `model`; add `AgentSessionConfig` + `config?`. |
| `shared/events.ts` | Drop `ModelTier`; `AgentCallState.tier` → `config?: Record<string,string|boolean>`. |

**Phase B — author-time (after A):**
| File | Change |
|---|---|
| `src/lib/workflow-dts.ts` | Remove `ModelTier`; `tier?` → `config?: WorkflowAgentConfig`; generate `WorkflowAgentConfig` from catalogs (open + `(string & {})` + index sig). |
| `shared/validate.ts` | `validateWorkflow(source, selectedAgentId?)`; validate `agent()` `config` literal vs selected agent's catalog (warnings; respect open/conditional); deprecation warning on `tier`. |
| `src/store/useStore.ts` | Thread `selectedAgent` into the 4 `validateWorkflow` calls; **make `setSelectedAgent` re-validate**. |

**Phase C — execution (after A):**
| File | Change |
|---|---|
| `server/acp/connection.ts` | Client `session.configOptions` capability; `config`/`onConfigOptions` on `PromptTurnOptions`, `configOptions` on result; ordered (model-first) `setConfigOption` loop w/ per-entry try/catch + re-read (§4.1). |
| `server/workflow/run.ts` | Remove `tier` state/log → config summary; pass `config` into `runPrompt`. |

**Phase D — UI (after A/C):**
| File | Change |
|---|---|
| `src/features/run/RunTree.tsx` | Replace `tier` badge with config/model badge from `AgentCallState.config`. |
| `src/store/useStore.ts` + `shared/protocol.ts` + `shared/events.ts` (optional) | Live-catalog channel: `onConfigOptions` → `RunEvent` → reducer → snapshot; feed real model ids into completions. Pure enhancement; skip for MVP. |

**Phase E — docs/examples (after A; mechanical):** `workflows/auth_audit.js`, `workflows/codebase_review.js`, `src/lib/defaults.ts`, `README.md` — remap `tier:` → `config:`, show both a Claude and a Codex example.

Fan-out: A is the prerequisite gate (one agent, merged first); B/C/D/E files are mutually independent and each become a one-file agent.

---

## 8. Feasibility corrections folded in (for the record)
1. **boolean capability is inert today** — keep the advertisement (future-proof) but never send a boolean unless the *live* option's `type==='boolean'`; derive send-shape from `opt.type`, not `typeof value`.
2. **`effort`/`reasoning_effort` are runtime-discovered** — marked `open`+`conditional`; never warn on their values; literals are autocomplete hints only.
3. **claude `agent` is conditional** (only with custom agents) — `conditional`, never warn-if-absent.
4. **`selectedAgentId` threading** requires updating `setSelectedAgent` to re-validate + a default param for the pre-agent-list init call.
5. **apply `model` first** (explicit sort, not just prose) and re-read `configOptions` after each set.
6. **per-entry try/catch**, continue on error, never abort the prompt; add a test that an invalid value warns + still runs with the default.

---
---

# Part II — Per-`agent()`-call backend selection with discriminated config typing

> Status: **IMPLEMENTED & SHIPPED**, building directly on Part I.
> Part I made `opts.config` a per-call ACP session-config object keyed to the
> **run-wide** selected agent. Part II makes the **backend itself** a per-call
> choice (`opts.agent`) and **discriminates `opts.config` on it**, so one run can
> drive Claude **and** Codex subprocesses concurrently with each call's config
> narrowed to the right catalog.

## 9. Goal & locked decision

Make the ACP backend a **per-`agent()`-call** choice rather than a run-wide one. Add `opts.agent` — an enum of the **currently-connected** agents (installed ones from `/api/agents`; today `'claude' | 'codex'`). The `opts.config` object is **discriminated on `opts.agent`**: `{ agent:'codex', config }` narrows config completions/validation to Codex's catalog (`reasoning_effort`/`fast-mode` appear, `effort`/`agent` disappear) and vice-versa.

**LOCKED:** when `opts.agent` is **omitted**, it falls back to the run-config **default agent** (`RunRequest.agent` — `shared/protocol.ts:8`), and config types & validates against that default. Existing scripts with no `agent` keep working unchanged. The run-config single-agent selector (`selectedAgent` in `src/store/useStore.ts:128`) is repurposed as the **default-agent** selector; the run-wide Mode picker now governs **only** the default backend (§13.3).

This is purely additive over Part I: `AgentSessionConfig` stays `Record<string, string | boolean>` at runtime (`shared/dsl.ts:21`), the catalog lives in `shared/agents.ts` (`AcpAgentSpec.configCatalog`), and the apply path in `connection.ts.runPrompt` (`server/acp/connection.ts:204`) is untouched. What changes is *which backend* each call routes to and *which catalog* its config narrows against.

---

## 10. The `agent()` options shape

### 10.1 Runtime type — `shared/dsl.ts` (already in place)

The runtime stays loose (the VM can't know the connected set), but carries `agent?: AcpAgentId` alongside `config?: AgentSessionConfig` (`shared/dsl.ts:50-73`):

```ts
import type { AcpAgentId } from './agents.ts'   // dsl→agents edge; agents.ts has no dsl import → no cycle

export type AgentSessionConfig = Record<string, string | boolean>   // unchanged

export interface AgentOptions {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  /** Which connected ACP backend runs THIS call. Omitted → run default (RunRequest.agent). */
  agent?: AcpAgentId
  /** Per-call ACP session config for the selected (or default) agent. */
  config?: AgentSessionConfig
  isolation?: IsolationMode
  agentType?: string
  timeoutMs?: number | null
  retries?: number
}
```

The narrowing lives entirely in the generated `.d.ts` (§11). The `agent()` declaration in `shared/dsl-registry.ts:95-96` is **unchanged** — it already references `AgentOptions`, so the generic schema overload (`agent<const S extends JsonSchema>(prompt, opts: AgentOptions & { schema: S })`) keeps working once `AgentOptions` becomes the discriminated union:

```ts
declare function agent<const S extends JsonSchema>(prompt: string, opts: AgentOptions & { schema: S }): Promise<FromSchema<S> | null>;
declare function agent(prompt: string, opts?: AgentOptions): Promise<string | null>;
```

### 10.2 Example calls

```js
// Omitted agent → the run's DEFAULT backend; config narrows to the default's catalog.
const plan = await agent('Draft a migration plan',
  { label: 'Migration plan', config: { model: 'opus', effort: 'high', mode: 'plan' } })

// Explicit Codex backend for one call; config narrows to Codex's catalog.
const triage = await agent('Triage these lint errors',
  { agent: 'codex', config: { model: 'gpt-5-codex', reasoning_effort: 'low', 'fast-mode': 'on' } })

// Explicit Claude backend, even if Codex is the run default.
const review = await agent('Review the diff',
  { agent: 'claude', schema, config: { model: 'sonnet', effort: 'high' } })
```

---

## 11. The Monaco `.d.ts` becomes DYNAMIC — discriminated union (the crux)

### 11.1 Why it must become dynamic

Today (post-Part I) `src/lib/workflow-dts.ts` computes a single `WorkflowAgentConfig` **once at module load** (`buildAgentConfigDts()` → `AGENT_CONFIG_DTS` → `WORKFLOW_DSL_DTS`, lines 97-131) by *unioning every agent's* ids, and `monaco-setup.ts` injects it **once** (guarded by `let configured`, lines 4 + 8-9). That cannot narrow config on `opts.agent`, and the discriminated union depends on two runtime facts unknown at module load:

1. **Which agents are connected** (installed; from `/api/agents`) — determines the union *members*.
2. **Which agent is the default** (`selectedAgent` in the store) — determines which config the `agent?: undefined` branch points at.

So the generator becomes a **pure function** regenerated from those two inputs, and Monaco gets **re-injected** whenever they change.

### 11.2 New generator signature — `src/lib/workflow-dts.ts`

Replace the eager `buildAgentConfigDts()` / module-level `AGENT_CONFIG_DTS` / `WORKFLOW_DSL_DTS` constant with:

```ts
import type { AcpAgentId, AcpAgentSpec } from '@shared/agents'
import { ACP_AGENT_LIST } from '@shared/agents'

export function buildWorkflowDts(agents: AcpAgentSpec[], defaultAgentId: AcpAgentId): string
export const INITIAL_WORKFLOW_DSL_DTS: string   // = buildWorkflowDts(ACP_AGENT_LIST, 'claude')
```

`buildWorkflowDts`:
- builds **one config interface per agent in `agents`** (e.g. `ClaudeAgentConfig`, `CodexAgentConfig`) from each spec's `configCatalog`,
- emits the three-member `AgentOptions` union: a `{ agent?: undefined; config?: <Default>Config }` branch (Default = `defaultAgentId`) + one `{ agent: '<id>'; config?: <Id>Config }` branch per connected agent,
- concatenates `PREAMBLE` (with the old inline `AgentOptions` block removed — it now varies and moves into the generator) + per-agent config interfaces + the `AgentOptions` union + `DSL_METHODS.map(m => m.dts)`.

The exported `INITIAL_WORKFLOW_DSL_DTS = buildWorkflowDts(ACP_AGENT_LIST, 'claude')` is the **bootstrap** string used at module load / before `/api/agents` resolves, so the editor has completions immediately and falls back to the full static-registry union.

**Per-agent config interface generation (the critical `.d.ts` change driven by the probe):** for the discriminated union to actually *narrow config completions*, the per-agent config interfaces must **drop the `[configId: string]: …` index signature and the `(string & {})` open-value escape hatches** that Part I's `buildAgentConfigDts` emitted (lines 117 + 122) — both defeat TypeScript's excess-property checking, which is what powers per-key completion filtering and red squiggles in the TS service. So the rule per `configCatalog` entry becomes:

- fixed-vocab `select`/`boolean` (`open !== true`) → **closed literal union** of its `values` (e.g. `mode?: "read-only" | "agent" | "agent-full-access"`),
- `open === true` (model/effort/reasoning_effort/agent) → bare **`string`** (no `(string & {})`) — accepts any runtime-discovered value while still constraining the *property name* per-agent,
- **no index signature, no `(string & {})`**.

Open-ended forward-compat (runtime-discovered model ids, account-specific personas) is delegated entirely to `shared/validate.ts`, which only ever emits **warnings** — exactly the existing split: completions/hover come from the injected `.d.ts`, red squiggles come from `validate.ts` (semantic validation is OFF in `monaco-setup.ts:60-64`).

Resulting shape:

```ts
interface ClaudeAgentConfig {
  /** mode */ mode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
  /** model */ model?: string;                 // open
  /** effort */ effort?: string;               // open + conditional
  /** agent */ agent?: string;                 // open + conditional (Claude custom persona)
}
interface CodexAgentConfig {
  /** mode */ mode?: "read-only" | "agent" | "agent-full-access";
  /** model */ model?: string;                 // open
  /** reasoning_effort */ reasoning_effort?: string;   // open + conditional
  /** fast-mode */ "fast-mode"?: "on" | "off";
}

interface AgentOptionsBase {
  label?: string; phase?: string; schema?: JsonSchema;
  isolation?: "worktree"; agentType?: string; timeoutMs?: number | null; retries?: number;
}

type AgentOptions =
  // omitted agent → DEFAULT backend's config (default = claude here)
  | (AgentOptionsBase & { agent?: undefined; config?: ClaudeAgentConfig })
  | (AgentOptionsBase & { agent: "claude"; config?: ClaudeAgentConfig })
  | (AgentOptionsBase & { agent: "codex";  config?: CodexAgentConfig });
```

The `agent?: undefined` branch's config **must equal the current default agent's** config interface — so the union is regenerated whenever the default changes (§12).

**Connected-only filter:** the union members are the **installed** agents (`a.installed`; see `connectedAgentIds` in `shared/agents.ts:202-204`). If only Claude is installed, the union has just the default + `claude` branches, so `agent:'codex'` is a type error in the editor (and a `validate.ts` warning — §13.2).

### 11.3 Empirical probe result (tsc 6.0.3, `--strict`)

Decisive results from probes under `/tmp/dtsprobe` (FromSchema-style, mirroring `shared/dsl-registry.ts`):

**Probe 2 (no index sig, two-member union):** `agent:'codex'` + claude-only key `effort` → **TS2353 "Object literal may only specify known properties, and 'effort' does not exist in type 'CodexConfig'"**. ✅ Confirms `agent:'codex'` narrows config and removes `effort`/`agent` from completions.

**Probe 1 (WITH index sig):** every cross-agent key was *silently accepted* — **the index signature defeats narrowing**. ✅ Confirms we must drop it.

**Probe 4 (SHIP CANDIDATE — three-member union, default branch `agent?: undefined`):**
- `{ config: { effort: "high" } }` (omitted agent) → **OK** (narrows to default/claude). ✅
- `{ config: { reasoning_effort: "high" } }` (omitted agent, codex-only key) → **ERROR**. ✅ Omission types against the default.
- `{ agent: "claude", config: { reasoning_effort: "x" } }` → **TS2353**. ✅
- `{ agent: "codex", config: { effort: "x" } }` → **TS2353**. ✅
- `{ agent: "codex", config: { reasoning_effort:"low", "fast-mode":"on" } }` → **OK**. ✅
- `{ agent: "codex" }` (no config) → **OK**. ✅

**Probe 5 (schema overload composed with the discriminated union):**
- `agent("x", { agent:"codex", config:{reasoning_effort:"low"}, schema:{type:"number"} as const })` infers `Promise<number | null>` → **OK**. ✅ `FromSchema<S>` still flows through `AgentOptions & { schema: S }`.
- `agent("x", { config:{ reasoning_effort:"low" }, schema:{...} })` (codex key under claude default + schema) → **TS2769 No overload matches** → **ERROR**. ✅ Discrimination holds even on the schema overload.

**Conclusion:** the three-member union (`agent?: undefined` default branch + one explicit branch per connected agent), with **no index signature and no `(string & {})`** on the per-agent config interfaces, gives correct narrowing completions for both the explicit and the omitted-agent cases, and the existing generic `FromSchema`/`jsonSchema` overload keeps working unchanged.

### 11.4 Re-injection — `src/lib/monaco-setup.ts`

Split today's single `configureMonaco` into two exports:

```ts
import type { Monaco } from '@monaco-editor/react'
export const MONACO_THEME: string
export function configureMonaco(monaco: Monaco): void              // initial inject (INITIAL_WORKFLOW_DSL_DTS)
export function updateWorkflowDts(monaco: Monaco, dts: string): void   // NEW: re-inject via setExtraLibs (same filePath)
```

- `configureMonaco(monaco)` — theme + compiler options + diagnostics-off + the **initial** `setExtraLibs([...])` with the bootstrap dts (`INITIAL_WORKFLOW_DSL_DTS`). Keep the `configured` guard for the *one-time* theme/compiler/diagnostics setup.
- `updateWorkflowDts(monaco, dts)` — calls `js.setExtraLibs([{ content: dts, filePath: 'ts:agentprism-workflow-globals.d.ts' }])` **and** `ts.setExtraLibs([...])` with the **same `filePath`** (the same path already used at `monaco-setup.ts:47`), which **replaces** the prior lib and makes the TS worker re-resolve. Keep a module-level `lastDts` so re-injection is skipped when unchanged.

Because completions are pull-based (the suggest widget re-queries the worker), no explicit re-validate is needed for completions. **Red squiggles come from `validate.ts`, not the TS service** (semantic validation OFF), so there are no TS-service markers to refresh — the store already re-runs `validateWorkflow` on agent/source change (§13). The `setExtraLibs` call alone refreshes hover/completions.

---

## 12. Store + editor wiring for the dynamic `.d.ts` — `src/store/useStore.ts` / `WorkflowEditor.tsx`

### 12.1 Store state

Add a derived `workflowDts` to `State`, recomputed from `(installed agents, default agent)`:

```ts
workflowDts: string   // = buildWorkflowDts(agents.filter(a => a.installed), selectedAgent)
```

- Initialize it to `INITIAL_WORKFLOW_DSL_DTS` (`= buildWorkflowDts(ACP_AGENT_LIST, 'claude')`), alongside the existing `validation: validateWorkflow(DEFAULT_WORKFLOW, 'claude')` at `useStore.ts:124`.
- Recompute and `set({ workflowDts })` in three places:
  - **`init`** after `fetchAgents` resolves (`useStore.ts:152-160`) — agents now known.
  - **the `hello` server message** (`useStore.ts:305-307`, `set({ agents: msg.agents })`) — installed set may change.
  - **`setSelectedAgent`** (`useStore.ts:183-190`) — the default changed, so the `agent?: undefined` branch must re-point.
  - Helper: `set({ workflowDts: buildWorkflowDts(agents.filter(a => a.installed), id) })`.

### 12.2 Thread `connectedAgentIds` into validation

The four (`useStore.ts`) `validateWorkflow(...)` call sites — `setSource` (168), `setSelectedAgent` (189), `openFile` (227), `newFile` (246) — pass the new optional third arg `connectedAgentIds = agents.filter(a => a.installed).map(a => a.id)` (the `connectedAgentIds` helper already exists in `shared/agents.ts:202-204`), so the validator can flag an `opts.agent` literal that names an installed-but-absent agent (§13.2).

### 12.3 Editor effect — `src/features/editor/WorkflowEditor.tsx`

Subscribe to `workflowDts` and re-inject on change (and once on mount after `configureMonaco`):

```ts
const workflowDts = useStore((s) => s.workflowDts)
useEffect(() => { if (monacoRef.current) updateWorkflowDts(monacoRef.current, workflowDts) }, [workflowDts])
```

`onMount` (`WorkflowEditor.tsx:70-83`) calls `updateWorkflowDts(mon, workflowDts)` after the existing setup so the editor reflects the connected set as soon as the monaco ref is available; `beforeMount` still calls `configureMonaco` for the one-time theme/compiler/bootstrap inject.

---

## 13. EXECUTION — `server/workflow/run.ts` multi-connection, lazy spawn, per-call routing

### 13.1 SDK feasibility (verified)

`client(options?)` (`node_modules/@agentclientprotocol/sdk/dist/acp.d.ts:619`) returns an independent `ClientApp`; `.connect(stream)` yields a `ClientConnection` whose `.agent` is a `ClientContext`. Each `AcpAgentConnection` (`server/acp/connection.ts:92`) already owns its own subprocess (`spawn`, line 123), its own ndJSON stream (line 149), its own `createClient(...).connect(...)` (line 151), and its own `ClientContext` (`this.ctx`, line 180). There is **no shared/singleton client state** in `connection.ts` — every instance is fully isolated. Therefore N `AcpAgentConnection`s → N subprocesses → N independent ACP peers, drivable concurrently. **Multi-connection is feasible with ZERO changes to `connection.ts`** (the CONTRACT confirms: `server/acp/connection.ts` — NO CHANGE).

### 13.2 `WorkflowRun` holds a `Map<AcpAgentId, AcpAgentConnection>`

Replace the single `private connection?: AcpAgentConnection` (`run.ts:133`) with:

```ts
private connections = new Map<AcpAgentId, AcpAgentConnection>()
private connecting = new Map<AcpAgentId, Promise<AcpAgentConnection>>()
```

A lazy getter spawns on first use and shares an in-flight promise so concurrent `agent()` calls to the same backend don't double-spawn:

```ts
private async getConnection(agentId: AcpAgentId): Promise<AcpAgentConnection> {
  const existing = this.connections.get(agentId)
  if (existing) return existing
  let p = this.connecting.get(agentId)
  if (!p) {
    p = (async () => {
      const spec = ACP_AGENTS[agentId]
      const conn = new AcpAgentConnection(spec, {
        log: (level, type, text, data) => this.logAcp(level as AcpEventLevel, type, text, data),
        decidePermission: (ask) => this.decidePermission(ask),
      })
      await conn.start()
      this.connections.set(agentId, conn)
      return conn
    })()
    this.connecting.set(agentId, p)
  }
  try { return await p } finally { this.connecting.delete(agentId) }
}
```

(The hooks are exactly those built inline today at `run.ts:658-661`.)

### 13.3 Per-call routing in `runAgent`

Resolve the backend per call near the top of `runAgent` (`run.ts:441`), record it on the call state, and route `runPrompt` to that backend's connection:

```ts
const agentId = opts.agent ?? this.request.agent
state.agent = agentId          // AgentCallState.agent (shared/events.ts:42) — drives the RunTree badge

const conn = await this.getConnection(agentId)
const turn = await conn.runPrompt({
  cwd: this.cwd,
  modeId: agentId === this.request.agent ? this.modeId : undefined,  // run-wide mode only applies to the DEFAULT backend
  prompt: this.buildPrompt(prompt, opts),
  config: opts.config,
  onSession: (sid) => this.sessionToAgent.set(sid, id),
  onModes: (modes) => { if (agentId === this.request.agent) this.handleModes(modes) },
  onConfigOptions: (o) => this.emitConfigOptions(id, o),
  onUpdate: (u) => this.handleAgentUpdate(id, u),
})
```

- **`state.agent = agentId`** — `AgentCallState` already carries `agent: AcpAgentId` (`shared/events.ts:42`); set it when constructing `state` (`run.ts:451-465`, where `config: opts.config` is already wired at line 458). Add `agentId` to the per-call config log line (`run.ts:471-479`) for traceability.
- **Run-wide mode (`this.modeId`) applies only to the default backend.** A non-default backend gets `modeId: undefined`, so its mode comes purely from `opts.config.mode` (or the agent default). This matches the locked decision that the run-wide Mode selector is the *default-agent* mode.
- **Live modes/configOptions surfacing:** `handleModes` (`run.ts:215-221`) writes a single `snapshot.modes` (the UI shows one mode picker). To avoid two backends fighting over it, **only the default backend's** `onModes` updates `snapshot.modes`; non-default `onConfigOptions` still flow through `emitConfigOptions(id, …)` (`run.ts:223-236`) keyed by the call's agent id (the event is already per-agent — `session:configOptions` carries `agentId`, `shared/events.ts:160`).

### 13.4 Cleanup of ALL connections at run end

`start()` (`run.ts:624-683`) today eagerly creates the single `this.request.agent` connection before `runVm` (lines 657-669) and closes it in `finally` (line 681). New behavior:

- **No eager connection.** Spawn nothing up front; the first `agent()` call lazily spawns its backend via `getConnection` (for scripts with no `opts.agent`, that's the default — the same subprocess as before, just deferred). A run can now `complete` having spawned only the backends actually used.
- **Optional pre-warm (recommended):** to preserve the current "modes appear immediately" UX, optionally `await this.getConnection(this.request.agent)` right after `setStatus('running')` (`run.ts:662`). Wrap in try/catch and **fail the run** if the *default* backend can't start (mirrors today's `run.ts:663-669`). A *non-default* backend that fails to start fails **only that `agent()` call** as a recoverable error (it surfaces through `getConnection` rejecting inside `runAgent`'s try/catch, `run.ts:483-539`).
- **`finally` closes all:** replace `this.connection.close()` (`run.ts:681`) with:

```ts
for (const conn of this.connections.values()) conn.close()
this.connections.clear()
```

### 13.5 Concurrency / limiter

The existing `Limiter` (`run.ts:50-68`, instantiated at line 165) is run-wide (caps total concurrent `agent()` calls) and backend-agnostic — **no change**. Concurrent calls to different backends share the same limiter budget, which correctly bounds total fan-out.

---

## 14. VALIDATION — `shared/validate.ts`

### 14.1 New signature

```ts
import type { AcpAgentId } from './agents.ts'
export function validateWorkflow(
  rawSource: string,
  selectedAgentId?: AcpAgentId,        // the DEFAULT agent (unchanged meaning from Part I)
  connectedAgentIds?: AcpAgentId[],    // NEW optional: installed agents, to flag a non-connected opts.agent
): ValidateResult
```

Both new params stay optional → backward-compatible. The server pre-run path already passes the default (`run.ts:582` and `run.ts:625` call `validateWorkflow(source, this.request.agent)`); it leaves `connectedAgentIds` undefined (it only knows the static registry). The store passes both (§12.2).

### 14.2 Per-call effective agent inside `inspectAgentOptions`

`inspectAgentOptions` (`shared/validate.ts:299-361`) today validates `config` against `ACP_AGENTS[selectedAgentId]` (line 327). Change it to compute the **effective agent per call** by reading the literal `agent` property from the same opts `ObjectExpression`, before reading `config`:

```ts
// inside inspectAgentOptions, before the `config` loop:
let effectiveAgent: AcpAgentId | undefined = selectedAgentId
const agentProp = o.properties.find((p) => keyOf(p as PropNode) === 'agent')
if (agentProp) {
  const av = (agentProp as PropNode).value
  if (av?.type === 'Literal' && typeof av.value === 'string') {
    if (av.value in ACP_AGENTS) {
      effectiveAgent = av.value as AcpAgentId
      // installed-but-absent nuance (only when the connected set was provided):
      if (connectedAgentIds && !connectedAgentIds.includes(effectiveAgent)) {
        diagnostics.push(diagAt(agentProp as Node, `agent: "${av.value}" is not currently connected`, 'warning'))
      }
    } else {
      diagnostics.push(diagAt(agentProp as Node, `agent: "${av.value}" is not a connected agent`, 'warning'))
    }
  }
}
const catalog = effectiveAgent ? ACP_AGENTS[effectiveAgent]?.configCatalog : undefined
```

Then the existing unknown-id / out-of-vocab-value checks (`validate.ts:337-358`) run against the **effective** catalog, with messages mentioning `effectiveAgent` instead of `selectedAgentId`. The `tier` deprecation warning (`validate.ts:320-324`) is unaffected.

- When `connectedAgentIds` is **undefined** (server pre-run path / bootstrap), fall back to the `in ACP_AGENTS` check only — a genuinely-unknown id still warns; the connected-but-not-installed nuance is skipped.
- All findings remain **warnings**; they never flip `ok` to false (consistent with Part I and the run-log surfacing at `run.ts:636-638`).

### 14.3 How the default reaches the validator (unchanged)

Already wired in Part I: the store calls `validateWorkflow(source, get().selectedAgent, ...)` in `setSource`/`setSelectedAgent`/`openFile`/`newFile`, and the bootstrap is `validateWorkflow(DEFAULT_WORKFLOW, 'claude')` (`useStore.ts:124`). The default is the `selectedAgentId` param; per-call `opts.agent` overrides it locally inside `inspectAgentOptions`. No new threading of the default is needed — only the optional `connectedAgentIds` is added on the store-side calls (§12.2).

---

## 15. UI

### 15.1 Run-config: 'Agent' → 'Default agent' — `src/features/run/RunConfig.tsx` (already in place)

The `<Label>` already reads **"Default agent"** with the hint "used when agent() omits agent" (`RunConfig.tsx:42-45`), still binding `selectedAgent` / `setSelectedAgent` (lines 46, 26-27). The Mode picker label already carries "default agent's mode" (`RunConfig.tsx:61-62`); it now governs **only the default backend** at runtime (§13.3). No structural change.

### 15.2 RunTree: per-call agent badge — `src/features/run/RunTree.tsx` (already in place)

`AgentCard` already renders the per-call backend name from `agent.agent` (the new `AgentCallState.agent`), mapping id→display name via the store's `agents` with an `AGENT_NAME_FALLBACK` lookup (`RunTree.tsx:29-33, 59-61`). Place this agent pill **before** the `configBadge` (`RunTree.tsx:78-80`) so each card reads e.g. "Codex · model=… reasoning_effort=…", styled distinctly from the config badge.

### 15.3 Store wiring (summary — see §12)

- `workflowDts: string` in state, init `INITIAL_WORKFLOW_DSL_DTS`, recomputed in `init` / `hello` / `setSelectedAgent`.
- `connectedAgentIds = agents.filter(a => a.installed).map(a => a.id)` threaded into the four `validateWorkflow` calls.
- `WorkflowEditor.tsx` subscribes `workflowDts` and re-injects via `updateWorkflowDts` (§12.3).

---

## 16. Backward compat & the `opts.agent` vs `config.agent` naming note

- **Existing scripts** with no `opts.agent` are unaffected: omission resolves to `request.agent` at runtime (§13.3), types against the default in the `.d.ts` `agent?: undefined` branch (§11.3 probe 4), and validates against the default catalog (§14.2). No script edits required.
- **`opts.agent` (backend selector) vs Claude's `config.agent` (custom-persona option) — different nesting, no collision.** This is a plausible-looking but real-world-harmless pun on the word "agent":
  - **`opts.agent`** is a **top-level** `AgentOptions` key whose value is an **`AcpAgentId`** (`'claude' | 'codex'`) — it selects **which backend** runs the call. It is the *discriminant* of the `.d.ts` union (`agent?: "claude" | "codex"`) and is read by `run.ts.runAgent` (§13.3) and by `validate.ts` to pick the catalog (§14.2).
  - **`config.agent`** is a key **inside `opts.config`** whose value is a **Claude `SessionConfigOption` id** — Claude's **custom-persona** selector (`shared/agents.ts:122-129`, `id:'agent'`, `open`+`conditional`). It is just one entry in `ClaudeAgentConfig` (typed `agent?: string`, §11.2) and is applied via `setConfigOption` like any other config id (`connection.ts:226-246`). Codex has no such option.

  The two never collide because they live at **different nesting levels** (`opts.agent` vs `opts.config.agent`) and the `.d.ts` keeps them distinct (a top-level discriminant literal union vs a `string` property inside the per-agent config interface). Their value spaces are disjoint by construction — `AcpAgentId` literals vs Claude persona names — and `validate.ts` checks them against different things: `opts.agent` against `ACP_AGENTS` / `connectedAgentIds`, `config.agent` against Claude's `configCatalog` (where it is `open`, so its values are never flagged).

---

## 17. Phasing

**Gate (shared contracts everything imports; do first):**
| File | Change |
|---|---|
| `shared/agents.ts` | already exports `AcpAgentId` + `connectedAgentIds` helper (`agents.ts:202-204`) — no change needed. |
| `shared/dsl.ts` | `AgentOptions.agent?: AcpAgentId` (`dsl.ts:50-73`) — in place. |
| `shared/events.ts` | `AgentCallState.agent: AcpAgentId` (`events.ts:42`) — in place. |

**Dependent (consume the gate; mutually independent one-file agents):**
| File | Change |
|---|---|
| `src/lib/workflow-dts.ts` | dynamic generator `buildWorkflowDts(agents, defaultAgentId)` + `INITIAL_WORKFLOW_DSL_DTS`; per-agent config interfaces (no index sig, no `(string & {})`) + three-member discriminated `AgentOptions` (§11.2). |
| `src/lib/monaco-setup.ts` | split into `configureMonaco` (initial) + `updateWorkflowDts` (re-inject via `setExtraLibs` same `filePath`, `lastDts` guard) (§11.4). |
| `shared/validate.ts` | add `connectedAgentIds?` param; per-call effective-agent in `inspectAgentOptions` + non-connected `opts.agent` warning (§14). |
| `server/workflow/run.ts` | `connections`/`connecting` Maps + `getConnection` lazy spawn; route by `opts.agent ?? request.agent`; `state.agent`; default-only `modeId`/`onModes`; close all in `finally` (§13). |
| `src/store/useStore.ts` | `workflowDts` state + recompute (init/hello/setSelectedAgent); thread `connectedAgentIds` into the 4 validate calls (§12). |
| `src/features/editor/WorkflowEditor.tsx` | subscribe `workflowDts` + `updateWorkflowDts` effect + onMount call (§12.3). |
| `src/features/run/RunConfig.tsx` | 'Default agent' relabel + mode hint — **already in place** (§15.1). |
| `src/features/run/RunTree.tsx` | per-call `agent.agent` badge — **already in place** (§15.2). |
| `server/acp/connection.ts` | **NO CHANGE** — already fully isolated per instance (§13.1). |

Fan-out: the gate is in place; the dependent files are each a one-file agent, with `workflow-dts.ts` ↔ `monaco-setup.ts` ↔ `useStore.ts` ↔ `WorkflowEditor.tsx` sharing the `buildWorkflowDts`/`updateWorkflowDts` contract, and `run.ts` ↔ `validate.ts` sharing the `opts.agent ?? default` routing/validation contract.
