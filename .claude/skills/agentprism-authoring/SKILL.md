---
name: agentprism-authoring
description: Author AgentPrism workflows, prompt templates, and capability tools in this repo. Use whenever the user asks to create, edit, or debug a workflow (a .js DSL script in workflows/), a prompt template (a Handlebars .hbs file in prompts/), or a tool/capability or pure helper (a .ts module in tools/). Covers where each file lives, its required structure, and the project conventions.
---

# Authoring for AgentPrism

AgentPrism is a local IDE for **dynamic agent workflows**. A workflow is plain-JavaScript orchestration; it can pull in two kinds of reusable pieces:

- **Tools** (`tools/*.ts`) — *world-touching* **capabilities** (host-run effects like API calls) and *pure* **helpers** (deterministic compute).
- **Prompt templates** (`prompts/*.hbs`) — Handlebars templates with typed params, rendered to strings.

How it runs (you must respect this to author correctly):

- The **browser** only authors + validates. The **Node backend** runs the workflow body inside a deterministic `vm` sandbox; each `agent()` call drives a real ACP coding agent (Claude / Codex).
- The sandbox is **deterministic**: `Date.now()`, `Math.random()`, and `new Date()` are banned in workflows.
- **Capabilities run in a trusted host realm** (outside the sandbox) — that's the only place secrets and IO live. Workflows see capabilities as injected globals.
- **Prompt templates render purely** — no IO, no secrets — so the same render happens on the server and in the browser preview.

## Route by what the user wants

Read the matching file for the full rules, required structure, and worked examples before writing anything:

| The user wants to… | Read |
|---|---|
| Write or edit a **workflow** (the `.js` DSL, `agent()`/`parallel()`/`pipeline()`, using capabilities + prompts) | **[workflows.md](workflows.md)** |
| Write or edit a **prompt template** (a `.hbs` file with typed frontmatter params) | **[prompts.md](prompts.md)** |
| Write or edit a **tool** — a **capability** (world-touching effect) or a **pure helper** | **[tools.md](tools.md)** |

If the request spans several (e.g. "a workflow that calls Jira and assembles a review prompt"), read all the relevant files, then build bottom-up: **tool → prompt → workflow**.

## Conventions shared by all three

- **Two tiers.** Each kind resolves a **project** copy first (`tools/`, `prompts/`, `workflows/` in this repo), then a **user library** (`~/.agentprism/tools/`, `~/.agentprism/prompts/`). A project entry **shadows** a user entry of the same name. Force a tier by qualifying the declared name with `project:`, `user:`, or `@me/` (e.g. `user:jira`).
- **Identifier names.** A tool's `name`, a prompt's **filename bareName**, and any name you declare in `meta` must be a valid JS identifier (`/^[A-Za-z_$][\w$]*$/`) — e.g. `mrReview`, not `mr-review`. The name becomes the global/member you call.
- **JSON-serializable boundaries.** Anything crossing the sandbox boundary (capability args + results, `agent({ schema })` results) must be JSON-serializable.
- **Don't store secrets in files.** Capabilities declare secret **names** only; values come from the host environment at run time.

After writing, the IDE validates live (red squiggles + a status line). Keep `export const meta = {…}` as the first statement of every workflow, and prefer the worked examples in each linked file as templates.
