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

## Architecture

```
┌──────────────────────────────┐         ┌─────────────────────────────────────────┐
│  Browser (Vite + React 19)   │  WS/REST │  Node backend (Express + ws)            │
│  • Monaco editor + validation│ <──────> │  • RunManager → WorkflowRun             │
│  • run tree / ACP log / BPs  │          │  • vm sandbox executor (DSL globals)    │
│  • zustand store             │          │  • AcpAgentConnection (stdio JSON-RPC)  │
└──────────────────────────────┘          └───────────────┬─────────────────────────┘
                                                           │ spawns
                                          ┌────────────────┴───────────────┐
                                          │ claude-agent-acp / codex-acp    │  (ACP agents)
                                          └─────────────────────────────────┘
```

- The browser only authors & validates; it can't spawn processes.
- The backend runs the workflow in a Node `vm` realm (determinism prelude + async IIFE, mirroring pi‑dynamic‑workflows). The injected `agent()` drives an **ACP session**; `parallel`/`pipeline`/the quality‑pattern stdlib are implemented on top of it.
- Shared TypeScript types in `shared/` define the DSL, the run‑event model, and the WS/REST protocol used by both ends.

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

## Authoring with an AI agent

Point your coding agent at the **[`agentprism-authoring`](.claude/skills/agentprism-authoring/SKILL.md)** skill (`.claude/skills/agentprism-authoring/`). It teaches an agent *where* and *how* to write **workflows**, **prompt templates**, and **tools**, routing to a focused guide per task. In Claude Code it loads automatically; with any other agent, point it at the `SKILL.md` and the linked files.

## Project layout

```
shared/      DSL types, run-event model, WS/REST protocol, capability + prompt env, the validator (browser + server)
server/      Express + ws, ACP connection, vm executor, capability/prompt loaders, run orchestration, file store
src/         React app: Monaco editor, meta form, file browser, run tree, ACP log, Handlebars preview, store
workflows/   Saved workflow .js files
tools/       Capability modules (world-touching effects) + pure helpers, imported host-side
prompts/     Handlebars (.hbs) prompt templates with typed frontmatter params
```

A user-level library at `~/.agentprism/tools/` and `~/.agentprism/prompts/` is merged in as a second tier ("Shared tools" / "Shared prompts"); project entries shadow user entries of the same name.

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
