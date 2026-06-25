# Embedding the AgentPrism runtime

A minimal host that imports the AgentPrism runtime and runs a workflow
programmatically — no IDE, no WebSocket. It demonstrates the three things a host
gets from `createRuntime`:

1. **The full event stream** — `handle.on(cb)` (push) or `handle.events()` (`for await`, pull).
2. **Mid-run interaction round-trips** — answer permission approvals (`onPermission`)
   and human-in-the-loop `checkpoint()` input (`onInput`) with plain JS handlers.
3. **A terminal result** — `await handle.done` → `{ runId, status, result?, error? }`.

The workflow here is declared inline as a string and uses `meta.inputs`, so its
`args` are typed and **validated before the run starts**.

## Run it

```bash
node examples/embed/run.mjs
```

Requirements:

- **Node ≥ 22** and an authenticated **Claude** or **Codex** agent (the runtime
  spawns the bundled ACP agents, reusing your CLI login — see the root README).
- The runtime loads `.ts` capability/helper modules via `tsx`, so run with a
  loader if your workflow imports tools: `node --import tsx examples/embed/run.mjs`.
- This example imports the package by name (`agentprism`). From inside this repo,
  build the library (`npm run build:lib`) and link it, or adapt the import to the
  built entry point. Once published, `npm i agentprism` is all a host needs.

## Secrets

Capability secrets come from the **environment only** (`RuntimeOptions.env`,
default `process.env`). They are never entered in code, never sent to a browser,
and never persisted. Export whatever your workflow's capabilities require before
running, e.g.:

```bash
export ANTHROPIC_API_KEY=...   # or rely on your Claude Code / Codex CLI login
node examples/embed/run.mjs
```

## What to change next

- Swap `{ source }` for `{ name: 'your_workflow' }` to run a saved workflow from
  `workflows/` instead of an inline script.
- Drop the `onPermission` / `onInput` resolvers and instead answer out-of-band:
  subscribe with `handle.on(...)`, watch for the interaction events, and call
  `handle.respond(requestId, response)` when you have an answer.
- Use `runWorkflow(workflow, input?, options?)` for a one-shot "run to completion
  and give me the result" call without managing a handle.
