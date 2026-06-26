# Writing a tool

A `tools/<name>.ts` module is one of two kinds, distinguished purely by what it exports:

- **Capability** — `export default defineCapability({ … })`. A *world-touching* effect (HTTP, git, secrets) that runs in the **trusted host realm** and is injected into workflows as a namespace global.
- **Pure helper** — named exports only, **no** `defineCapability` default. Deterministic compute that is **inlined into the sandbox** and imported by workflows.

Both live in `tools/` (the **project tier**, resolved relative to the active **workspace** root — the directory AgentPrism is pointed at) or `~/.agentprism/tools/` (the **user tier**, a cross-workspace shared library; project shadows user). A capability's npm imports resolve from *that workspace's* `node_modules`, and the editor resolves the same types — so editor intellisense matches what the runtime loads at run time.

---

## Capability

```ts
// tools/jira.ts
import { defineCapability } from 'agentprism/capability'

export default defineCapability({
  name: 'jira',                          // namespace → workflows call `jira.<method>(args)`
  secrets: ['JIRA_TOKEN', 'JIRA_BASE_URL'], // ENV VAR NAMES only — never values
  effects: {
    async getTicket(ctx, args: { key: string }) {
      const base = ctx.secrets.JIRA_BASE_URL
      if (!base) { ctx.log('JIRA_BASE_URL missing'); return null } // recoverable → null
      const res = await fetch(`${base}/rest/api/3/issue/${args.key}`, {
        headers: { Authorization: `Bearer ${ctx.secrets.JIRA_TOKEN ?? ''}` },
      })
      if (!res.ok) { ctx.log(`jira ${res.status}`); return null }
      const j = await res.json() as { fields?: { customfield_ac?: string[] } }
      return { key: args.key, acceptanceCriteria: j.fields?.customfield_ac ?? [] }
    },
  },
})
```

`defineCapability` is imported from the bare specifier **`agentprism/capability`**. It resolves natively in the monorepo (the package self-references its own `./capability` export) and in any external workspace via a small generated `node_modules/agentprism` shim — nothing is written into your source tree.

**No-import fallback (zero dependency).** `defineCapability` is purely an identity helper that exists for the types. If you don't want any import, export the same shape as a plain object — it loads identically and its namespace types are still auto-derived from the effect signatures:

```ts
// tools/jira.ts — no import needed
export default {
  name: 'jira',
  secrets: ['JIRA_TOKEN'],
  effects: {
    async getTicket(ctx, args: { key: string }) { /* … */ return null },
  },
}
```

Rules:

- **`name`** is an identifier; it becomes the injected global. A name colliding with a DSL global (`agent`, `args`, `prompts`, …) is skipped.
- **`secrets`** are environment-variable **names**. Values are read from `process.env` host-side at run time and exposed only as `ctx.secrets.<NAME>` (string or `undefined`). They never enter the sandbox, logs, or storage; the run panel shows only present/missing. Set them in your shell before running.
- **`effects`** is `{ method(ctx, args) { … } }`. Each effect:
  - receives `ctx = { secrets: Record<string, string|undefined>, log(message, data?) }` and your `args`.
  - may be `async` or sync; runs in the **trusted host realm**, so `fetch`, `node:*`, etc. are allowed.
  - **args and the return value must be JSON-serializable.** Annotate `args` with a concrete type (`args: { key: string }`) — the namespace's TypeScript types are **auto-derived from these signatures** (no hand-written `.d.ts`).
  - return `null` on a **recoverable** failure (and `ctx.log(...)` it) — workflows treat a `null` result as "soft fail," same as `agent()`.
- The workflow sees the method with **`ctx` dropped and always async**: `jira.getTicket(args) => Promise<{ key; acceptanceCriteria } | null>`.
- A workflow must list `'jira'` in `meta.capabilities` to call it.
- **One namespace per file.** A capability module has a single `export default defineCapability(...)`, and the catalog is keyed by filename — so `tools/jira.ts` defines exactly one namespace (`jira`). For a second namespace (e.g. `confluence`), add a second file.

Group related powers as **many effects under one namespace**, not many files: `jira.getTicket`, `jira.createTicket`, `jira.addComment` all live in `tools/jira.ts`. To keep a large capability readable, split the effect implementations into other modules and just assemble them — the capability is host-loaded with a real `import()`, so it can import from anywhere:

```ts
// tools/jira.ts
import { getTicket, createTicket } from '../lib/jira/effects.ts'
export default defineCapability({ name: 'jira', secrets: ['JIRA_TOKEN'], effects: { getTicket, createTicket } })
```

Keep those implementation files **out of the flat-scanned `tools/` top level** (a subdirectory like `tools/_jira/`, or a different directory) so they're never picked up as their own capability — only `*.ts`/`*.js`/`*.mjs` directly in `tools/` (and `~/.agentprism/tools/`) are scanned.

---

## Pure helper

```ts
// tools/mr-prompt.ts — pure helper: no defineCapability, no world access.
export function buildReviewPrompt(input: {
  acceptanceCriteria: string[]; comments: string[]; diff: string
}): string {
  return [
    'Review this merge request against its acceptance criteria.',
    'ACCEPTANCE CRITERIA:', ...input.acceptanceCriteria.map((c) => `- ${c}`),
    'DIFF:', input.diff,
  ].join('\n')
}
```

Rules (enforced at inline time — a violation rejects the workflow):

- **No default `defineCapability` export** — that makes it a capability, not a helper.
- **Must be pure / deterministic.** It runs inside the sandbox, so the same determinism rules apply (no time, no randomness, no IO).
- **May NOT import `node:` builtins or bare npm packages**, and **may not import a capability**. It *may* import other pure helpers (relative `.ts`), which are inlined recursively.

A workflow uses it with a normal relative import (the line is blanked and the helper inlined):

```js
import { buildReviewPrompt } from '../tools/mr-prompt.ts'
```

---

## Which one to write?

- Needs the network, the filesystem, git, or a secret → **capability** (and declare it in `meta.capabilities`).
- Just transforms data already in hand (e.g. assembles a prompt string, reshapes results) → **pure helper** (and `import` it). For templated text, prefer a **[prompt template](prompts.md)** over a string-building helper.
