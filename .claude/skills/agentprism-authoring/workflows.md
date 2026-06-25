# Writing a workflow

A workflow is a plain ES module saved as **`workflows/<name>.js`** (or created/saved from the IDE's Workflows sidebar). It is run in a deterministic `vm` sandbox with the DSL globals in scope.

## Hard rules

1. **The first statement MUST be a literal `export const meta = { … }`** — an object literal (no variables, spreads, or function calls inside it).
2. **No non-determinism in the workflow body:** `Date.now()`, `Math.random()`, and `new Date()` are rejected. Pass timestamps via `args`; vary by index, not randomness.
3. The body runs as if inside an async function — use `await` at top level and `return` a final value.

## `meta` fields

```js
export const meta = {
  name: 'review_pr',                 // required — short identifier
  description: 'Review a PR end to end.', // required — one line
  phases: [{ title: 'Gather' }, { title: 'Review' }], // optional — titles match phase('…')
  capabilities: ['jira', 'gitlab'],  // optional — tool namespaces this workflow may call
  prompts: ['mrReview'],             // optional — prompt templates this workflow may call
  model: 'opus',                     // optional — default model for agents with no model set
  config: { verify: { reviewers: 3 } }, // optional — per-method overrides (keyed by method name)
  inputs: [                          // optional — typed inputs; each becomes a key on `args`
    { name: 'jiraKey', type: 'string', required: true, description: 'Ticket key' },
    { name: 'reviewers', type: 'string[]', default: ['alice'] }, // optional, with a default
  ],
}
```

Only names listed in `meta.capabilities` / `meta.prompts` are injected and typed; calling an undeclared one is a validation error. Qualify with `project:`/`user:`/`@me/` to force a tier (e.g. `'user:jira'`).

### Typed inputs (`meta.inputs`)

`meta.inputs` is an **optional** array of typed parameters. Each entry is `{ name, type, description?, default?, required? }`:

- `name` — a JS identifier; it becomes a key on the `args` global (`args.jiraKey`).
- `type` — one of `string | number | boolean | string[] | number[] | boolean[]`.
- `required` — defaults to `false`. A required param with no value blocks the run.
- `default` — must match `type`; seeds the IDE form and the value when omitted.

When `inputs` is declared, the IDE renders a generated form (one control per param) that **gates Run** until required fields are filled, `args` becomes precisely typed in the editor (no longer `any`), and the values are validated (strictly, no loose coercion) by the same `validateInputs` gate the **programmatic API** enforces before a run starts. Omitting `meta.inputs` keeps today's behavior exactly: free-form `args`, `args: any`, no gating.

## DSL globals

- `agent(prompt, opts?)` → the agent's final text, or a **validated typed object** when `opts.schema` (a JSON Schema) is given. Recoverable failures resolve to `null`.
- `jsonSchema(schema)` — identity helper that preserves a schema's literal type so a schema stored in a `const` still types the `agent({ schema })` result.
- `parallel(thunks)` — run `() => agent(...)` thunks concurrently; **barrier**, results in order. A thunk that throws → `null`.
- `pipeline(items, ...stages)` — fan each item through sequential stages; items flow independently (no barrier between stages).
- `phase(title)`, `log(message)` — progress. `args`, `cwd`, `budget` — inputs/limits. `process` — env access.
- Quality helpers: `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`, `checkpoint`.
- `workflow(scriptOrName, args?)` — run another workflow inline (currently inline-script strings).

### `agent()` options

```js
await agent('Review this diff.', {
  agent: 'codex',                 // which backend: 'claude' | 'codex' (omit → run's default)
  config: { model: 'gpt-5-codex', reasoning_effort: 'medium' }, // backend-specific session config
  schema: { type: 'object', properties: { approved: { type: 'boolean' } } }, // → typed result
  label: 'diff review',           // short display label
  phase: 'Review',                // override the current phase for this call
  isolation: 'worktree',          // run in a throwaway git worktree
  agentType: 'reviewer',          // named agent definition
  timeoutMs: 120000, retries: 1,
})
```

`config` is **agent-specific** (it narrows in the editor on `opts.agent`):
- **Claude** — `model` | `mode` | `effort` | `agent`
- **Codex** — `model` | `mode` | `reasoning_effort` | `fast-mode`

## Using capabilities and prompts

Declare them in `meta`, then call the injected global (capability) or `prompts.<name>(data)` (prompt). Capability calls return `Promise<result>` (the `ctx` param is dropped) and resolve to `null` on a recoverable failure. See **[tools.md](tools.md)** and **[prompts.md](prompts.md)** for authoring those.

You may also `import { fn } from '../tools/<helper>.ts'` to pull in a **pure helper** (deterministic compute, inlined into the sandbox).

## Worked example

```js
export const meta = {
  name: 'mr_review',
  description: 'Review a GitLab MR against Jira acceptance criteria.',
  capabilities: ['jira', 'gitlab', 'git'],
  prompts: ['mrReview'],
}

phase('Gather context')
const ticket = await jira.getTicket({ key: args.jiraKey })          // capability → Promise<…|null>
const comments = await gitlab.getMrComments({ project: args.project, mr: args.mr })
const diff = await gitlab.getMrDiff({ project: args.project, mr: args.mr })
const { worktree } = (await git.checkoutWorktree({ repo: args.repo, ref: args.ref })) ?? {}

phase('Review')
const prompt = prompts.mrReview({                                   // prompt template → string
  acceptanceCriteria: ticket?.acceptanceCriteria ?? [],
  comments: comments ?? [],
  diff: diff ?? '',
})
return await agent(prompt, {
  cwd: worktree,
  schema: jsonSchema({
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      blocking: { type: 'array', items: { type: 'string' } },
    },
    required: ['approved', 'blocking'],
  }),
})
```

Save it to `workflows/mr_review.js`. The IDE validates on every edit; fix any red squiggles before running.
