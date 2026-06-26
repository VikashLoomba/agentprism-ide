# AgentPrism

**A local web IDE for writing and running dynamic agent workflows, powered by the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP).**

AgentPrism takes the [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) JavaScript DSL — the same `agent()` / `parallel()` / `pipeline()` / `phase()` orchestration API that powers Claude Code's dynamic workflows — and puts it in your hands: a Monaco editor with full intellisense and validation, a meta‑block form, and a one‑click **Run** backed by real ACP coding agents (**Claude** and **Codex**). You get a live phase/agent execution tree, a streaming ACP event console, and **breakpoints** that pause execution after an `agent()` call so you can inspect its output before continuing.

![AgentPrism](public/prism.svg)

## Why

Dynamic workflows are powerful, but normally the *agent* writes the orchestration JavaScript on the fly. AgentPrism flips that around: **you** author the workflow, with type‑checking and syntax highlighting, validate it before running, and drive execution with any ACP agent — stepping through it with breakpoints and watching every ACP event.

## Features

- **Monaco editor** with intellisense over the full DSL (`agent`, `parallel`, `pipeline`, `phase`, `log`, `verify`, `judgePanel`, `loopUntilDry`, `retry`, `gate`, `jsonSchema`, `budget`, `args`, …) via generated ambient type‑defs.
- **Live validation** — a faithful port of the pi‑dynamic‑workflows acorn parser: requires the `export const meta = {…}` literal first, rejects non‑deterministic primitives (`Date.now`/`Math.random`/`new Date()`), and surfaces errors as editor squiggles before you run.
- **Meta form** — edit `name`, `description`, and `phases` in a form that round‑trips with the code.
- **ACP execution** — each `agent()` call opens an isolated ACP session against your chosen agent (**Claude** / **Codex**), with the agent's native coding tools (file edits, shell, etc.). Session **modes** (`default` / `acceptEdits` / `plan` / … for Claude; `read-only` / `agent` / `agent-full-access` for Codex) are surfaced in the run config and updated live.
- **Per‑call agent selection** — each `agent()` call may name its backend with `agent: 'claude' | 'codex'` (the connected agents); its `config` then **narrows in‑editor to that backend's options**, so one workflow can drive Claude *and* Codex subprocesses concurrently. Omit `agent` and the call uses the run's **default agent**.
- **Typed structured results** — pass `schema` (a JSON Schema) to `agent()` and the result is a validated object whose **type flows into intellisense** (`r.findings` is typed, not `any`). Wrap a reused schema in `jsonSchema(...)` to preserve its literal type for inference.
- **Per‑method config** — quality combinators (`verify`, `judgePanel`, `loopUntilDry`, `retry`, `gate`, …) expose Zod‑backed config schemas; override them in `meta.config` or via the auto‑generated Run‑config form.
- **Breakpoints & stepping** — click the gutter to set a breakpoint on an `agent()` line; execution pauses *after* that call resolves so you can inspect its output, then **Resume** or **Step**. Works even for agents nested inside `parallel()` thunks (line mapping via V8 stack traces).
- **Phase / agent run tree** — every agent shows its status, per‑call `config` (model/mode/effort/…), streaming message, thinking, tool calls, structured result, tokens, and errors.
- **ACP event console** — a terminal‑style log of spawns, tool calls, plans, permission requests, mode changes, and agent stderr.
- **Capabilities** — give workflows *world‑touching* powers without leaving the sandbox: declare `meta.capabilities: ['jira', …]` and call host‑injected namespaces (`await jira.getTicket({ key })`). Each call is a **deterministic, recorded effect** run in a trusted host realm; the workflow only ever sees `(args) => Promise<result>`, and recoverable failures resolve to `null`. **Namespace types are auto‑derived** from the tool's effect signatures, so `jira.getTicket(...)` is fully typed in the editor — no hand‑written `.d.ts`. Capabilities live in project `tools/` and a user `~/.agentprism/tools/` library (project shadows user), declare their **secret names** only (presence shown in the run panel; values never stored), and are editable as `.ts` files right in the IDE.
- **Prompt templates** — assemble prompts deterministically: author Handlebars `.hbs` templates with a typed **frontmatter param schema**, opened in a "Prompts" sidebar with Monaco highlighting and a **live preview** rendered identically to production. Call them in a workflow as `prompts.<name>(data)` — a pure, typed `string`‑returning helper. Two tiers (`prompts/` + `~/.agentprism/prompts/`), with built‑in safe helpers (`eq`, `join`, `json`, …) and partials for composition.
- **Local files** — save/load workflows as `.js` files in `workflows/`.
- **Workspaces (multi-root)** — point AgentPrism at any directory on disk; each **workspace** resolves its own `workflows/`, `tools/`, `prompts/`, *and the npm dependencies your tools import* (from the workspace's own `node_modules`). **Open and switch between multiple workspaces** in one session — each with its own runs, catalogs, and editor intellisense (see [Workspaces](#workspaces)).

## Architecture

```
┌──────────────────────────────┐         ┌─────────────────────────────────────────┐
│  Browser (Vite + React 19)   │  WS/REST │  server/ — thin HTTP/WS adapter          │
│  • Monaco editor + validation│ <──────> │    workspace-scoped /api/workspaces/:id  │
│  • run tree / ACP log / BPs  │          │  ───────────────────────────────────────│
│  • zustand store (per‑ws)    │          │  runtime/ — the engine (Node)            │
└──────────────────────────────┘          │    • WorkspaceRegistry → Workspace       │
                                           │    • vm sandbox executor (DSL globals)   │
                                           │    • AcpAgentConnection (stdio JSON‑RPC) │
                                           └───────────────┬─────────────────────────┘
                                                           │ spawns
                                          ┌────────────────┴───────────────┐
                                          │ claude-agent-acp / codex-acp    │  (ACP agents)
                                          └─────────────────────────────────┘
```

The codebase is split into cleanly delineated layers:

- **`runtime/`** is the transport-agnostic engine and the **only layer that touches the filesystem**: it owns the `WorkspaceRegistry` + each `Workspace` (catalog resolution, capability loading, tool-type resolution), the Node `vm` sandbox executor (determinism prelude + async IIFE, mirroring pi‑dynamic‑workflows), and the `AcpAgentConnection`s. It's also the importable npm surface (`createRuntime`).
- **`server/`** is a **thin HTTP/WS adapter** that projects the runtime to the browser — every resource route is workspace-scoped (`/api/workspaces/:workspaceId/*`) and resolves to a `Workspace`; it holds no resolution logic of its own.
- The **browser** only authors & validates; it can't spawn processes. Its store keeps per-workspace state and Monaco editor URIs are namespaced per workspace.
- **`shared/`** defines the DSL, the run‑event model, and the WS/REST protocol (incl. `workspaceId`) used by both ends.
- A workspace's tools import their npm dependencies from **that workspace's** `node_modules`, and the editor resolves the *same* types — so editor intellisense matches what the runtime actually loads. AgentPrism's own install dir is used only to serve its bundled UI and agent binaries, never to resolve your content.

## Requirements

- **Node ≥ 22**
- An authenticated **Claude** and/or **Codex** agent. AgentPrism spawns the bundled
  [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) and
  [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp), which reuse your existing CLI login:
  - **Claude** — log in with Claude Code (`~/.claude`), or set `ANTHROPIC_API_KEY`.
  - **Codex** — log in with the Codex CLI (`~/.codex/auth.json`), or set `OPENAI_API_KEY`.

## Getting started

```bash
npm install
npm run dev          # starts Vite (http://localhost:5173) + backend (:8787)
```

Open http://localhost:5173, pick an agent and mode, set the working directory the agents operate in, then **Run**.

Other scripts:

```bash
npm run build        # typecheck + production build to dist/
npm run start        # run the backend only (serves dist/ if built)
npm run typecheck    # tsc for app + server
```

Environment variables (optional):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Backend port |
| `AGENTPRISM_WORKFLOWS_DIR` | `./workflows` | Where workflows are saved |
| `AGENTPRISM_TOOLS_DIR` | `./tools` | Where capability/helper modules are loaded from |
| `AGENTPRISM_PROMPTS_DIR` | `./prompts` | Where prompt templates are loaded from |
| `AGENTPRISM_DEFAULT_CWD` | `process.cwd()` | Default working directory for runs |

## The workflow DSL

A workflow is a plain ES module. The first statement **must** be a literal `meta` export; the rest is run in a sandbox with the DSL globals in scope:

```js
export const meta = {
  name: 'dual_backend_review',
  description: 'Scan on Codex, review on both backends in parallel, synthesize on Claude',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Synthesize' }],
}

// jsonSchema(...) preserves the literal type so `scan.areas` is typed string[].
const AREAS = jsonSchema({
  type: 'object',
  properties: { areas: { type: 'array', items: { type: 'string' } } },
  required: ['areas'],
})

phase('Scan')
// `agent` picks the backend per call; `config` then narrows to *that* backend's
// options — Codex takes `reasoning_effort`/`mode`, Claude takes `effort`/`model`.
const scan = await agent('List the source areas worth reviewing.', {
  agent: 'codex',
  config: { mode: 'read-only', reasoning_effort: 'low' },
  schema: AREAS,
})

phase('Review')
// Review every area with Claude AND Codex concurrently.
const reviews = await parallel(
  (scan?.areas ?? []).flatMap((area) => [
    () => agent(`Review ${area} for bugs.`, { agent: 'claude', config: { model: 'sonnet', effort: 'medium' } }),
    () => agent(`Review ${area} for bugs.`, { agent: 'codex', config: { model: 'gpt-5-codex', reasoning_effort: 'medium' } }),
  ]),
)

phase('Synthesize')
// Omit `agent` → uses the run's default backend.
return await agent('Merge these findings:\n' + reviews.filter(Boolean).join('\n\n'), {
  config: { model: 'opus', effort: 'high' },
})
```

Key globals (full types power editor intellisense — see `src/lib/workflow-dts.ts`):

- `agent(prompt, opts?)` → final text, or a **validated, typed** object when `opts.schema` (a JSON Schema) is given. `opts.agent` picks the backend (omit → run default); `opts.config` is that backend's session config. Recoverable failures resolve to `null`.
- `jsonSchema(schema)` — identity helper that preserves a schema's literal type so a schema stored in a `const` still types `agent({ schema })`'s result.
- `parallel(thunks)` — run `() => agent(...)` thunks concurrently (results in order).
- `pipeline(items, ...stages)` — fan each item through sequential stages; items run concurrently.
- `phase(title)`, `log(msg)`, `args`, `cwd`, `budget`.
- Quality helpers: `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`.
- **Capability namespaces** — anything in `meta.capabilities` is injected as a global (`await jira.getTicket({ key })`), typed from the tool's effect signatures. **Prompts** — `prompts.<name>(data)` renders a scoped `.hbs` template to a string (declare them in `meta.prompts`).

`opts.agent` selects which connected backend runs the call (`'claude' | 'codex'`); omitting it falls back to the run‑config **default agent**. `opts.config` is a per‑call ACP **session config** object — its keys are the [Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options) that backend advertises, applied to its ACP session via `session/set_config_option` before the prompt. The options are **agent‑specific**, narrowed in‑editor on `opts.agent` and validated against it:

- **Claude** — `model` | `mode` | `effort` | `agent`, e.g. `{ agent: 'claude', config: { model: 'opus', effort: 'high', mode: 'plan' } }`.
- **Codex** — `model` | `mode` | `reasoning_effort` | `fast-mode`, e.g. `{ agent: 'codex', config: { model: 'gpt-5-codex', reasoning_effort: 'low' } }`.

Example workflows live in `workflows/` (`auth_audit.js`, `codebase_review.js`, `dual_backend_review.js`).

### Typed workflow inputs

A workflow may *optionally* declare typed inputs in its `meta` block. When present, AgentPrism renders a generated form (one control per param) in the Run panel that **gates Run** until every required field is filled, and the values are validated before the run starts:

```js
export const meta = {
  name: 'mr_review',
  description: 'Review a GitLab MR against Jira acceptance criteria.',
  capabilities: ['jira', 'gitlab'],
  inputs: [
    { name: 'jiraKey', type: 'string', required: true, description: 'Ticket key, e.g. ACME-42' },
    { name: 'project', type: 'string', required: true },
    { name: 'mr', type: 'number', required: true },
    { name: 'reviewers', type: 'string[]', default: ['alice', 'bob'] }, // optional, with a default
  ],
}

const ticket = await jira.getTicket({ key: args.jiraKey }) // `args` is typed from meta.inputs
```

- Each entry is `{ name, type, description?, default?, required? }`. `name` must be a JS identifier (it becomes a key on `args`); `type` is one of `string | number | boolean | string[] | number[] | boolean[]`; `required` defaults to `false`.
- When `meta.inputs` is declared, the form **is** `args` — each param becomes a typed key, and `args` gains a precise type in the editor (`args.jiraKey` is `string`, not `any`). The raw JSON args textarea moves behind an "advanced" toggle.
- Validation is **strict** (no loose coercion): a required value that is missing, or a value whose type doesn't match, blocks the run with an error. The same `validateInputs` gate runs in the IDE *and* in the programmatic API (see below), so a host gets identical errors.
- **Back-compat:** a workflow with no `meta.inputs` behaves exactly as before — free-form `args`, `args: any`, no gating.

## Workspaces

A **workspace** is a directory on disk that holds your `workflows/`, `tools/`, and `prompts/` — and whose own `node_modules` provides the npm dependencies your capability tools import. AgentPrism is **workspace-centric** and **multi-root**: the runtime hosts a registry of workspaces, and you can open and switch between several in one session.

- **Single root, conventional subdirs.** Pointing AgentPrism at `/path/to/project` resolves `/path/to/project/{workflows,tools,prompts}` plus that project's `node_modules`. A global `~/.agentprism/{tools,prompts}` library is merged as a second tier (project shadows user).
- **Everything is scoped per workspace** — runs, catalogs, the open editor buffer/file list, and editor intellisense. Same-named tools in different workspaces don't collide, and a tool's npm types resolve from *its* workspace (e.g. two workspaces pinned to different `zod` versions each see their own).
- **Switch in the UI** via the workspace picker; each workspace shows an attention badge when a background run needs input. Open another folder at runtime, or pre-open several from the CLI.
- **The bin** picks a default workspace from `--cwd` (or the current directory) and accepts repeatable `--workspace <dir>` flags to pre-open more. Per-workspace dir overrides via the `AGENTPRISM_*_DIR` env vars apply to the **default** workspace.

## Embedding / packaging

AgentPrism ships as a single npm package with two entry points: a CLI that boots the IDE, and an importable runtime that runs workflows programmatically.

### Boot the IDE locally

```bash
npx agentprism-ide                         # default workspace = current directory
npx agentprism-ide --port 9090 --cwd /path/to/project
npx agentprism-ide --workspace /repo/a --workspace /repo/b   # pre-open multiple workspaces
```

This serves the editor and backend from the installed package, while resolving each **workspace's** `workflows/`, `tools/`, and `prompts/` (and that workspace's `node_modules`) from the directory you point it at — so it works from any project, and several at once. Agent logins and secrets are read from your environment exactly as in dev.

### Run workflows programmatically

Import the runtime to drive workflows from your own program. You get the **full event stream**, the **mid-run interaction round-trips** (permission approvals and human-in-the-loop input), and a `done` promise with the terminal result:

```js
import { createRuntime } from 'agentprism'

const runtime = createRuntime() // { cwd?, env?, workspaces? } — default workspace = cwd

const handle = runtime.run(
  { name: 'mr_review' },                       // a saved workflow… or { source: '<inline script>' }
  { jiraKey: 'ACME-42', project: 'web', mr: 17 }, // input — validated against meta.inputs first
  {
    agent: 'claude',
    // Resolver ergonomics — answer interactions inline as they arise:
    onPermission: (req) => ({ kind: 'selected', optionId: req.options[0].optionId }),
    onInput: (req) => (req.kind === 'confirm' ? true : req.default ?? ''),
  },
)

// Push event stream (or use `for await (const ev of handle.events())`):
const off = handle.on((event) => console.log(event.type, event))

const result = await handle.done // { runId, status: 'completed' | 'failed' | 'cancelled', result?, error? }
off()
console.log(result.status, result.result)
```

- `createRuntime(options?)` → `{ workspaces, run, get, list, catalogs, listAgents }`. `run(workflow, input?, options?)` runs in the **default workspace** and returns a `RunHandle` synchronously, so you can subscribe before the engine starts. Pass `options.workspaces: [root, …]` (a string root or `{ root, env }`) to host **multiple** workspaces, and run in a specific one with `runtime.workspaces.getOrThrow(id).runtime.run(...)`.
- **Interactions, two ergonomics over one mechanism:** supply `onPermission` / `onInput` resolvers (the engine awaits them directly), **or** omit them and answer out-of-band via `handle.respond(requestId, response)` after the request arrives as an event. A production host typically implements only the semantic interactions (permission, input); the debug controls (`handle.resume()` / `step()` / `setBreakpoints()`) are the IDE's surface.
- **Input validation up front:** `run()` validates `input` against the workflow's `meta.inputs` **before** starting. On failure the handle settles `failed` with the error list and emits a failed `run:finished` — same surface as any other failure.
- A `runWorkflow(workflow, input?, options?)` convenience runs to completion and resolves the terminal `RunResult` in one call.
- **Secrets come from env only.** Capability secrets are read from `RuntimeOptions.env` (default `process.env`); they are never entered in the UI, never sent to the browser, and never persisted. Set them in your environment before running.

A minimal, runnable host demo lives in [`examples/embed/`](examples/embed/).

## Authoring with an AI agent

Point your coding agent at the **[`agentprism-authoring`](.claude/skills/agentprism-authoring/SKILL.md)** skill (`.claude/skills/agentprism-authoring/`). It teaches an agent *where* and *how* to write **workflows**, **prompt templates**, and **tools**, routing to a focused guide per task. In Claude Code it loads automatically; with any other agent, point it at the `SKILL.md` and the linked files.

## Project layout

```
shared/      DSL types, run-event model, WS/REST protocol (incl. workspaceId), capability + prompt env, the validator (browser + server)
runtime/     The engine + importable npm surface: WorkspaceRegistry + Workspace, vm executor (engine/), ACP connection (acp/),
             capability/prompt loaders + tool-intellisense, file stores (store/). The ONLY layer that touches the filesystem.
server/      Thin HTTP/WS adapter (Express + ws): workspace-scoped /api/workspaces/:id routes that project the runtime; serves the built IDE
bin/         agentprism-ide CLI entry
src/         React app: Monaco editor, meta form, workspace picker, file browser, run tree, ACP log, Handlebars preview, per-workspace store
workflows/   Saved workflow .js files            (resolved per workspace)
tools/       Capability modules + pure helpers   (resolved per workspace; imported host-side)
prompts/     Handlebars (.hbs) prompt templates  (resolved per workspace)
```

`workflows/`, `tools/`, and `prompts/` are resolved relative to each open **workspace** root (not the app). A user-level library at `~/.agentprism/tools/` and `~/.agentprism/prompts/` is merged in as a second tier ("Shared tools" / "Shared prompts"); project entries shadow user entries of the same name. The full architecture is documented in [`docs/workspace-architecture-plan.md`](docs/workspace-architecture-plan.md).

## Notes & limitations

- The vm sandbox is **not** a security boundary — workflows are trusted code you write. The ACP **mode** you pick (e.g. Claude `plan`, Codex `read-only`) governs what the agents may do.
- `opts.isolation: 'worktree'` is surfaced/logged but not yet enforced.
- `workflow()` supports inline script strings (one level deep), not saved‑name resolution.

## License

AgentPrism is © Loomba Enterprises LLC (d/b/a Automata Labs) and distributed under the **[Business Source License 1.1](./LICENSE)** (`BUSL-1.1`).

In plain terms:

- ✅ You may read, modify, and **run it locally or on your own infrastructure — including for commercial work** (e.g. building and running your own agent workflows).
- 🚫 You may **not** offer AgentPrism to third parties as a hosted or managed service that competes with a paid Automata Labs offering.
- ⏳ Each released version automatically converts to the **Apache License 2.0** on its Change Date (four years after that version's release).

BSL is **source‑available**, not OSI "open source," until the Change Date. For commercial licensing outside these terms, contact `vikash@automatalabs.io`.

Contributions are welcome under a **[Contributor License Agreement](./CLA.md)** — see **[CONTRIBUTING.md](./CONTRIBUTING.md)**.
