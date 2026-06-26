# P1 Fixes — Integrated Implementation Plan

Status: ready to implement. Scope is **exactly** three P1 defects; no gold‑plating.
Every decision below is grounded in the actual code (file + line) and in library
behavior verified empirically in this repo (see the "Evidence" call‑outs).

## Overview

Three P1 defects, all confirmed in a real browser smoke‑test:

- **P1‑A — Workspace close (X) is non‑functional.** The X `<button>` inside a Radix
  `Select.Item` stops `onPointerDown`+`onClick` but **not** `onPointerUp`, which is
  the actual mouse‑selection trigger in Radix Select. A mouse click on the X commits
  the item selection (switches workspace) and unmounts the row before the button's
  `onClick` DELETE can fire. The button is also unreachable by keyboard. Pure
  click/event‑layer defect — the store `closeWorkspace()` and the server DELETE route
  are already correct.

- **P1‑B — Added workspaces are in‑memory only.** `WorkspaceRegistry`
  (`runtime/workspace-registry.ts`) holds workspaces in a `Map` with no persistence,
  so a server restart drops every dynamically‑added (non‑default) workspace and the
  frontend desyncs (header shows a workspace the backend now 404s). Under
  `tsx watch server/index.ts`, editing a user‑tier tool file (which the capability
  loader `import()`s) restarts the dev server, dropping them. Fix: **persist** the
  non‑default roots to `~/.agentprism/workspaces.json` — **keyed by the canonical
  default root** so each project's IDE restores only its own additions (no bleed
  across unrelated projects, no cross‑clobber between concurrent IDEs of different
  cwds) — and restore on boot. Persistence is an **explicit opt‑in**
  (`RuntimeOptions.persistWorkspaces`, default `false`) enabled in **both** IDE
  entrypoints (`server/index.ts`, `bin/agentprism-ide.mjs`) and **nowhere else**, so
  the programmatic embed / `runWorkflow()` never reads or writes the file. Also
  **reconcile the frontend** on WS reconnect (the dangling‑active‑ws case) and
  **scope** the dev watcher so user‑tier tool edits don't needlessly restart.

- **P1‑C — `defineCapability` import story for external workspaces.** In‑repo tools
  import `{ defineCapability } from '../shared/capability.ts'`. For an arbitrary
  external workspace this is brittle: the current remediation (`ensureCapabilityShim`
  in `runtime/workspace.ts`, which **writes `<root>/shared/capability.ts` into the
  user's project tree**) litters the user's repo and silently breaks when the user
  already owns a `shared/` directory (`shared/` is an extremely common dir name — the
  shim detects the collision and bails with a `console.warn`, leaving the import
  resolving to the user's unrelated file). Fix: replace the project‑tree shim with a
  **collision‑proof bare specifier `agentprism/capability`**, resolved natively in
  the monorepo via a new package `exports` subpath and in external workspaces via a
  sentinel‑guarded, gitignored `node_modules/agentprism` shim — plus a fully
  supported **plain default‑export** fallback that needs no import at all.

### Cross‑cutting constraints honored

- Default/cwd workspace handling stays correct: the default workspace is always
  re‑derived from `cwd` on boot and is **never** persisted (P1‑B); the package‑root
  workspace self‑resolves `agentprism/capability` and gets **no** generated shim (P1‑C).
- Nothing new crosses the vm sandbox boundary. Persistence (`workspaces.json`) and the
  generated `node_modules/agentprism` shim are host‑side (runtime tier) filesystem
  artifacts; the effect/args payloads and protocol DTOs are unchanged and remain
  JSON‑serializable.
- Every author‑facing capability import changes; **package‑internal** relative imports
  of `../shared/capability.ts` / `../shared/capability-resolve.ts` (in `runtime/**`,
  `shared/**`, `server/**`) are correct and **must not** be touched.

---

## P1‑A — Workspace close (X) button

### Decision

Fix entirely in `src/features/workspace/WorkspacePicker.tsx` (one file). The wrapper
`src/components/ui/select.tsx`, the store `src/store/useStore.ts`, and the server
DELETE route are already correct and unchanged.

- **Mouse fix:** add `onPointerUp={(e) => e.stopPropagation()}` to the X `<button>`.
  Radix `Select.Item` (`node_modules/@radix-ui/react-select/dist/index.js`) commits a
  selection from `onPointerUp` **only when `pointerTypeRef === 'mouse'`** (the
  `handleSelect = onValueChange + onOpenChange(false)` path), and from `onClick` only
  for non‑mouse pointers. Today's handler stops `onPointerDown`+`onClick` but leaves
  `onPointerUp` to bubble to the item — that is the entire bug. With `onPointerUp`
  stopped, the menu stays open and the button's own `onClick` reliably fires
  `closeWorkspace(w.id)`.
- **Do NOT add `onMouseUp`:** Radix Select is Pointer‑Events‑only (zero `mouse*`
  handlers). `onMouseUp` would be dead weight.
- **Keyboard fix (required for "reachable + announced"):** the nested button is
  provably unreachable by keyboard — `Select.Content` wraps children in a trapped
  `FocusScope`, `preventDefault`s Tab, and navigates options by arrow/typeahead only;
  the button is not in the Collection. So attach close to the focusable
  `SelectItem` itself via `onKeyDown` (Delete/Backspace → `preventDefault` +
  `closeWorkspace`) and announce it with `aria-keyshortcuts="Delete"`. Delete/Backspace
  are neither Radix SELECTION_KEYS nor single‑char typeahead keys, and the shadcn
  wrapper spreads props onto `SelectPrimitive.Item` so a prop‑level `onKeyDown` composes
  **before** Radix's internal handler (`composeEventHandlers`) — `preventDefault()`
  cleanly suppresses it. Gate both to non‑active, non‑last rows.

### Exact changes — `src/features/workspace/WorkspacePicker.tsx`

In the `workspaces.map((w) => ( ... ))` body (currently lines 66–89), convert the arrow
to a **block body** to host two per‑row constants, and apply three edits:

1. Add per‑row derived flags at the top of the block body:
   ```ts
   const isActive = w.id === activeWorkspaceId
   const canClose = !isActive && workspaces.length > 1
   ```
2. On the `<SelectItem>` element (line 67), add (pass through the wrapper's `{...props}`
   spread to `SelectPrimitive.Item`):
   ```tsx
   aria-keyshortcuts={canClose ? 'Delete' : undefined}
   onKeyDown={
     canClose
       ? (e) => {
           if (e.key === 'Delete' || e.key === 'Backspace') {
             e.preventDefault()
             void closeWorkspace(w.id)
           }
         }
       : undefined
   }
   ```
3. On the close `<button>` (lines 72–85), **add** `onPointerUp`:
   ```tsx
   onPointerUp={(e) => e.stopPropagation()}
   ```
   Keep the existing `onPointerDown` stop, the `onClick` handler
   (`preventDefault`+`stopPropagation`+`closeWorkspace`), `disabled={workspaces.length === 1}`,
   the `aria-label`, and all `className`s unchanged. Keep the button rendered only when
   `!isActive` (now `{!isActive && (` using the new const). Do **not** add `onMouseUp`.

The `OPEN_SENTINEL` ("Open folder…") item is untouched (no close props, no X).

### Acceptance criteria

- Mouse‑clicking the X on a non‑active workspace fires a single `DELETE
  /api/workspaces/:id`, removes that row, and leaves `activeWorkspaceId` unchanged (no
  switch). The dropdown stays open.
- With the dropdown open, arrow‑focusing a non‑active workspace option and pressing
  Delete (or Backspace) closes it identically; the option exposes
  `aria-keyshortcuts="Delete"`.
- The active row and the last remaining workspace never expose a close affordance
  (mouse or keyboard).
- `npm run typecheck` and `npm run lint` pass.

### Edge cases

- **Single workspace:** it is active → X never renders; `canClose` is false → no
  keyboard close; the residual `disabled={workspaces.length === 1}` still guards.
- **Closing the active row** is intentionally not offered; the store still defends with
  its switch‑away‑to‑default path (`useStore.ts:671–678`) if ever invoked.
- **Touch/pen:** item selects via `onClick` for non‑mouse pointer types; the button's
  existing `onClick` stop already blocks that, so tapping the X closes without selecting.
- **Focus on unmount:** after close the row unmounts while the menu stays open; Radix
  `FocusScope` handles focus restoration — no trap break.

---

## P1‑B — Persist added workspaces + scope the dev watcher

### Decision

Persist the set of **non‑default** workspace roots to `~/.agentprism/workspaces.json`,
**keyed by the canonical default root**, and restore them on `createRuntime()` —
**only when the caller opts in** via `RuntimeOptions.persistWorkspaces: true`. The
registry is the only component that observes open/close, so it triggers persistence via
an injected `onChange` callback; the composition root (`createRuntime`) owns the file
I/O and the restore. The default workspace is derived from the first provided root (or
`cwd` when no roots are given) every boot and is **never** persisted (persisting a stale
cwd would pin a wrong default; it is also the persistence *key*, not a stored value).
Dead roots self‑prune. Separately, scope `tsx watch` so user‑tier tool edits (and the
user dir generally) don't restart the dev server.

**Persistence is anchored to the FIXED boot default root, NEVER the registry's mutable
default.** The registry reassigns its `defaultId` when the current default workspace is
closed mid‑session (`workspace-registry.ts:66‑68`), and closing a *non‑active* default IS
reachable from the IDE (the X renders for any non‑active row). If the persisted SET were
computed from the registry's live `defaultId`/`isDefault` while the KEY stayed the boot
default, the two would diverge the instant the default reassigns and a manually‑added
workspace would be silently dropped on restart (the blocking review's data‑loss path).
The fix decouples them: the registry's `onChange` reports **all** currently‑open roots, and
`createRuntime` both KEYS and FILTERS by the single `defaultRoot` captured once at boot —
`savePersistedRoots(defaultRoot, allOpenRoots.filter((r) => canonicalKey(r) !== canonicalKey(defaultRoot)))`.
So even if the boot default workspace is closed and the registry promotes another root to
default, that promoted root is still persisted under the stable boot key and restored on the
next launch (where the boot default is re‑derived from cwd). Re‑capturing the default in
`onChange` would NOT fix this — the set must be relative to the fixed boot default, not the
current one.

**Why opt‑in (`persistWorkspaces`), not "no `workspaces` provided":** the SHIPPED IDE
binary `bin/agentprism-ide.mjs:89` calls `createRuntime({ workspaces: [root, ...extraRoots] })`,
so a "persist only when `workspaces` is absent" heuristic would fix P1‑B for
`npm run dev:server` (which calls `createRuntime()` with no args, `server/index.ts:10`)
but **leave the bug shipping to end users**. Conversely, `runWorkflow()`
(`runtime/index.ts:76‑84`) and any host calling `createRuntime({ workspaces })` would
silently inherit (and clobber) the global persisted set. An explicit `persistWorkspaces`
flag is set `true` in **exactly** the two IDE entrypoints (`server/index.ts` and
`bin/agentprism-ide.mjs`) and nowhere else. When it is `false`, the registry's
`onChange` is **never wired** and **no** persistence file I/O happens — the embed
guarantee ("a library consumer neither reads nor writes the file") holds for boot **and**
for every post‑boot `runtime.workspaces.open/close`.

**Why key by default root, not a flat global list:** a single global `roots[]` makes
manually‑added workspaces bleed across unrelated projects (open the IDE in `/projA`, add
`/projB`; later open the IDE in `/projC` → `/projC` restores `/projB`), and two
concurrently‑running IDEs (different cwds) clobber the one file via last‑write‑wins. The
default workspace is per‑cwd; the persisted extras are conceptually tied to *that*
session's default root, so we store them under it:
`{ version: 2, byDefaultRoot: { '<canonical default root>': [extraRoots] } }`. A
read‑modify‑write save touches only the current default root's key, so IDEs of
**different** projects never clobber each other. (Two IDEs of the **same** cwd still
last‑write‑wins on the one shared key — a degenerate case, documented in the edge cases.)

**Compose order on boot** (when `persistWorkspaces` is true): (1) open the provided
roots (or the back‑compat `cwd` default) — the **first** is the default; (2) restore the
persisted non‑default roots for *this* default root **on top** of the provided set
(skipping any that resolve to an already‑open ws, including the default; dead roots
skipped); (3) write one authoritative save of the surviving non‑default set under the
default‑root key. Consequence: CLI `--workspace` roots (which arrive in `workspaces`)
**are persisted** — once opened they join the added set and survive subsequent plain
launches, which is the least‑surprising behavior (they are indistinguishable from
IDE‑added roots after boot).

Rationale for placement: the server calls `registry.open`/`registry.close` **directly**
on `runtime.workspaces` (`server/factory.ts:101,116`), so `createRuntime` cannot
intercept those — the registry must fire the persistence hook. File I/O lives in a new
runtime module so the registry stays pure‑ish (it receives a callback, not an fs path).

### Exact changes

**1. `runtime/paths.ts` — add the persisted‑file anchor.**
After `USER_PROMPTS_DIR` (line 56) add:
```ts
/** Persisted list of dynamically‑added (non‑default) workspace roots (P1‑B). */
export const USER_WORKSPACES_FILE = path.join(HOME, '.agentprism', 'workspaces.json')
```

**2. `runtime/workspace-store.ts` — NEW module (host‑side persistence).**
The persisted set is **keyed by the canonical default root** so each project's IDE
restores only its own additions and concurrent IDEs of different cwds don't clobber
each other (read‑modify‑write touches only the current key). The default/cwd workspace
is re‑derived each boot and is never stored as a value (it is the key).
```ts
// runtime/workspace-store.ts
// Persistence for dynamically‑added (non‑default) workspace roots (P1‑B), keyed by
// the canonical default (cwd) root. ONLY the two IDE entrypoints opt in
// (persistWorkspaces); the programmatic embed never touches this file.
import fs from 'node:fs'
import path from 'node:path'
import { USER_WORKSPACES_FILE } from './paths.ts'

interface PersistShape { version: 2; byDefaultRoot: Record<string, string[]> }

/** Canonical, stable key for a root (realpath; falls back to resolve). EXPORTED so the
 *  composition root (`runtime/index.ts`) filters the persisted set against the SAME fixed
 *  boot‑default key this module writes under — never against the registry's mutable default. */
export function canonicalKey(p: string): string {
  try { return fs.realpathSync.native(path.resolve(p)) } catch { return path.resolve(p) }
}

/** Read+normalize the whole file. Tolerates missing/corrupt/legacy → empty shape. */
function readStore(): PersistShape {
  let raw: string
  try { raw = fs.readFileSync(USER_WORKSPACES_FILE, 'utf8') } catch { return { version: 2, byDefaultRoot: {} } }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistShape> | null
    const byDefaultRoot = parsed?.byDefaultRoot
    if (parsed?.version === 2 && byDefaultRoot && typeof byDefaultRoot === 'object') {
      return { version: 2, byDefaultRoot: byDefaultRoot as Record<string, string[]> }
    }
  } catch { /* corrupt → empty */ }
  return { version: 2, byDefaultRoot: {} }
}

/** Read the persisted non‑default roots for `defaultRoot`. Tolerates missing/corrupt
 *  (→ []). Filters to absolute paths that currently exist as directories (auto‑prune). */
export function loadPersistedRoots(defaultRoot: string): string[] {
  const roots = readStore().byDefaultRoot[canonicalKey(defaultRoot)]
  if (!Array.isArray(roots)) return []
  return roots.filter((r): r is string => {
    if (typeof r !== 'string' || !path.isAbsolute(r)) return false
    try { return fs.statSync(r).isDirectory() } catch { return false }
  })
}

/** Atomically persist `roots` under `defaultRoot`'s key (read‑modify‑write so other
 *  projects' keys survive; mkdir -p, temp+rename). An empty list deletes the key.
 *  Best‑effort: a write failure is swallowed (persistence is a convenience, never
 *  load‑bearing for a single session). */
export function savePersistedRoots(defaultRoot: string, roots: string[]): void {
  try {
    const key = canonicalKey(defaultRoot)
    const store = readStore()
    if (roots.length === 0) delete store.byDefaultRoot[key]
    else store.byDefaultRoot[key] = roots
    fs.mkdirSync(path.dirname(USER_WORKSPACES_FILE), { recursive: true })
    const tmp = `${USER_WORKSPACES_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, USER_WORKSPACES_FILE)
  } catch { /* best‑effort */ }
}
```

**3. `runtime/workspace-registry.ts` — fire an `onChange` hook on real mutations.**
- Extend the options: `createWorkspaceRegistry(opts: { env?: NodeJS.ProcessEnv; onChange?: (allOpenRoots: string[]) => void } = {})`.
- Add a private helper that reports **every** currently‑open root — **NOT** filtered by
  `defaultId`. The default‑exclusion happens in `createRuntime` against the FIXED boot key,
  not here against the registry's mutable `defaultId` (this is the blocking‑review fix; the
  registry must not bake its reassignable default into the persisted set):
  ```ts
  const fireChange = () => {
    opts.onChange?.([...map.values()].map((ws) => ws.root))
  }
  ```
- In `open()` call `fireChange()` **only when a new workspace was actually added**
  (i.e., not on the early `if (existing) return existing` path) — after `map.set(id, ws)`.
- In `close()` call `fireChange()` after `map.delete(id)` (including when the closed ws was
  the default — the consumer keys off the boot default, so a reassignment here is inert).
- Do **not** special‑case the first‑ever default open — it is fine for it to fire (the boot
  default is filtered out downstream, so it persists `[]`); the restore guard (below)
  suppresses writes during boot anyway.

**4. `runtime/index.ts` — add the opt‑in flag + wire restore/persistence.**
First extend `RuntimeOptions` (after the `env` field, line ~24):
```ts
  /** IDE‑only opt‑in: restore + persist non‑default workspace roots to
   *  ~/.agentprism/workspaces.json (keyed by the default root). Default false —
   *  the programmatic embed never reads or writes that file. Set true ONLY in the
   *  two IDE entrypoints (server/index.ts, bin/agentprism-ide.mjs). */
  persistWorkspaces?: boolean
```
Then replace the construction block (lines 42–54) with a restoring‑guarded sequence.
Crucially, the `onChange` hook is **only wired when `persistWorkspaces` is true** — when
false the registry never calls back and no file I/O occurs (the embed guarantee):
```ts
import { createWorkspaceRegistry } from './workspace-registry.ts'
import { loadPersistedRoots, savePersistedRoots, canonicalKey } from './workspace-store.ts'
// ...
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env
  const persistEnabled = options.persistWorkspaces === true

  // Suppress per‑open persistence writes during boot; persist once after restore.
  // `defaultRoot` is the FIXED persistence key, captured after the first open below and
  // NEVER reassigned — even if the registry later promotes a different default on close.
  let restoring = true
  let defaultRoot = ''
  // Persist every open root EXCEPT the fixed boot default (it is the key, re‑derived from
  // cwd each boot). Filtering here — against `defaultRoot`, not the registry's mutable
  // `defaultId` — is what keeps a promoted‑on‑close root in the persisted set (blocking‑
  // review fix). `onChange` already passes ALL open roots; we drop the boot default here.
  const persistNonDefault = (allOpenRoots: string[]) => {
    savePersistedRoots(defaultRoot, allOpenRoots.filter((r) => canonicalKey(r) !== canonicalKey(defaultRoot)))
  }
  const registry = createWorkspaceRegistry({
    env,
    // When persistence is off, pass NO callback at all → the registry's open/close
    // are fully inert w.r.t. the filesystem (programmatic embed / runWorkflow).
    onChange: persistEnabled
      ? (allOpenRoots) => { if (!restoring) persistNonDefault(allOpenRoots) }
      : undefined,
  })

  // 1. Open the provided roots (first = default) or the back‑compat cwd default.
  if (options.workspaces && options.workspaces.length > 0) {
    for (const w of options.workspaces) {
      if (typeof w === 'string') registry.open(w)
      else registry.open(w.root, { env: w.env })
    }
  } else {
    // Back‑compat default workspace at cwd ?? process.cwd() (sole process.cwd() reader).
    registry.open(options.cwd ?? process.cwd(), { useEnvDirOverrides: true })
  }
  defaultRoot = registry.default().root

  // 2. IDE‑only: restore previously‑added (non‑default) roots for THIS default root,
  //    on top of the provided set. open() dedups by workspace id, so a persisted root
  //    that equals the default (or any already‑open root) is a harmless no‑op.
  if (persistEnabled) {
    for (const root of loadPersistedRoots(defaultRoot)) {
      try { registry.open(root) } catch { /* skip unreadable/missing root */ }
    }
  }

  restoring = false
  // 3. IDE‑only: one authoritative write of the surviving set under the FIXED boot
  //    default‑root key (prunes dead roots, captures CLI --workspace additions). Filter by
  //    the boot `defaultRoot` — NOT `w.isDefault` — so this stays consistent with the
  //    onChange path and with the key even after an in‑session default reassignment.
  if (persistEnabled) {
    persistNonDefault(registry.list().map((w) => w.root))
  }

  return { /* unchanged */ }
}
```
Notes:
- `persistEnabled` is the SOLE gate. The programmatic embed (`createRuntime({ workspaces })`,
  `runWorkflow()`) leaves it `false` → no `onChange`, no restore, no save — even for
  post‑boot `runtime.workspaces.open/close`. `runWorkflow()` (`runtime/index.ts:76‑84`)
  needs no change: it never sets `persistWorkspaces`.
- Both IDE entrypoints set it `true` (see change 6 below): `server/index.ts` via
  `createRuntime({ persistWorkspaces: true })` and `bin/agentprism-ide.mjs` via
  `createRuntime({ workspaces: [root, ...extraRoots], persistWorkspaces: true })`. So the
  fix reaches BOTH `npm run dev:server` and the shipped `npx agentprism-ide` binary.
- `registry.open(root)` for a restored root uses default env‑dir overrides
  (`useEnvDirOverrides` defaults to `id === defaultId` → false for non‑default), matching
  the live "Open folder…" behavior (`server/factory.ts:101`). No `fs` import is needed in
  `index.ts` — `loadPersistedRoots` already prunes non‑directory/missing roots, and
  `open()` dedups the default.

**5. `package.json` — scope the dev watcher.** (Owned by **Agent S**, see Sequencing.)
Change `scripts.dev:server` from `tsx watch server/index.ts` to:
```
tsx watch --exclude "**/.agentprism/**" --exclude "**/node_modules/**" server/index.ts
```
Evidence: `tsx watch --help` lists `--exclude <glob>` (verified, tsx v4.22.4). This stops
restarts triggered by editing user‑tier tool files under `~/.agentprism/tools/**` (which
the capability loader `import()`s). The `workspaces.json` write does **not** trigger a
restart (it is read via fs, never in the import graph). External **project** workspace
roots are arbitrary and cannot be globbed, but with persistence in place a restart is now
non‑destructive (the roots are restored), so any such restart is harmless.

**6. The two IDE entrypoints — opt in to persistence.** (Owned by **Agent B**.)
These are the ONLY two call sites that set `persistWorkspaces: true`; nothing else does.
- `server/index.ts:10` — change `createRuntime()` to:
  ```ts
  const runtime = createRuntime({ persistWorkspaces: true })
  ```
- `bin/agentprism-ide.mjs:89` — change to:
  ```js
  const runtime = createRuntime({ workspaces: [root, ...extraRoots], persistWorkspaces: true })
  ```
  (The built/published path imports the same `createRuntime`; the new field is plain
  JSON‑serializable data, so it works identically under `dist-lib`.)

**7. `src/store/useStore.ts` — reconcile the active workspace on WS reconnect.** (Owned by **Agent B**.)
P1‑B's primary trigger is the `tsx watch` restart with the PAGE STILL OPEN: the WS
reconnects and the server sends a fresh `hello` (`server/factory.ts:305‑311`). The
current `hello` handler (lines 962‑987) updates `workspaces`/`defaultWorkspaceId` but
never reconciles `activeWorkspaceId`. Persistence makes the active ws *usually* survive a
restart, but does NOT eliminate the dangle: a persisted root deleted off‑disk (auto‑pruned
on restart) that happened to be the active ws leaves `activeWorkspaceId` pointing at a
gone workspace — every `/api/workspaces/:id/*` call then 404s and the picker's
`Select value={activeWorkspaceId}` shows empty. `init()` already does this reconciliation
on a full page reload (lines 480‑483), but reconnect‑without‑reload bypasses `init()`.

In the `hello` case, after computing `validation`, derive whether the active ws survived
and repoint if not — reusing `setActiveWorkspace` so the target's catalogs/files refetch
exactly as on a manual switch:
```ts
case 'hello': {
  const s = get()
  const selectedAgent = s.selectedAgent
  const validation = validateWorkflow(/* …unchanged… */)
  const activeStillValid = msg.workspaces.some((w) => w.id === s.activeWorkspaceId)
  set({
    agents: msg.agents,
    workspaces: msg.workspaces,
    defaultWorkspaceId: msg.defaultWorkspaceId,
    workflowDts: workflowDtsFor(/* …unchanged… */),
    validation,
    ...inputStatePatch(/* …unchanged… */),
  })
  // Active ws vanished across a reconnect (e.g. a pruned persisted root that was
  // active): repoint to the new default and refetch its catalogs/files. `set` above
  // left `activeWorkspaceId` unchanged, so setActiveWorkspace sees a real prev→next
  // delta (it early‑returns only when prev === next).
  if (!activeStillValid && msg.defaultWorkspaceId) {
    void get().setActiveWorkspace(msg.defaultWorkspaceId)
  }
  break
}
```
`setActiveWorkspace` (lines 611‑643) already persists `ACTIVE_WS_KEY`, repoints the run /
editor / catalog mirrors, sets `defaultCwd`, and `refreshFiles` + `fetchCatalogsFor` — so
no bespoke refetch logic is duplicated. (The outgoing‑editor snapshot it writes for the
gone ws is a harmless dead slot, same as any close.) The happy path — active ws survived —
is untouched (its cached catalogs remain valid since the restarted server re‑derives the
identical catalogs).

### Acceptance criteria

- Open an extra workspace via the IDE → `~/.agentprism/workspaces.json` contains its
  absolute root under `byDefaultRoot["<canonical default root>"]`.
- Restart the server → `GET /api/workspaces` returns the extra workspace; the frontend
  header lists it; its scoped routes respond (no 404).
- Close the extra workspace → it disappears from `workspaces.json` (its default‑root key
  is removed when the list becomes empty; other projects' keys are untouched).
- Delete a persisted root directory off‑disk, then restart → it is absent from both
  `GET /api/workspaces` and `workspaces.json` (auto‑pruned); no crash, no directory is
  recreated. If that root was the active ws, after the WS reconnect the header/picker
  repoints to the default (no dangling active id, no perpetual 404s).
- The shipped `npx agentprism-ide` binary (not just `npm run dev:server`) persists and
  restores: launch it, add a workspace, relaunch in the same cwd → the workspace returns.
- A workspace added while the IDE runs in `/projA` does **not** appear when the IDE is
  later launched in an unrelated `/projC` (per‑default‑root keying).
- **Close‑the‑default survival:** boot default `/projA` (cwd) with an added `/projB`; switch
  active to `/projB`; close the now‑non‑active default `/projA` (registry promotes `/projB`
  to default); restart the IDE in cwd `/projA` → `/projB` is still restored (persistence
  stayed keyed to the boot default `/projA`, not the promoted `/projB`). No data loss.
- `runWorkflow(wf, input)` / `createRuntime({ workspaces })` with no `persistWorkspaces`
  neither creates nor mutates `~/.agentprism/workspaces.json` (verify the file's mtime is
  unchanged across an embed run).
- Editing a file under `~/.agentprism/tools/**` does **not** restart `npm run dev:server`.
- `npm run typecheck` and `npm run lint` pass.

### Edge cases

- **Default workspace** is never written to `workspaces.json` (filtered out by
  `canonicalKey(r) !== canonicalKey(defaultRoot)` against the FIXED boot key); it is the
  persistence *key*, not a stored value.
- **Closing the (non‑active) default mid‑session** is reachable from the UI (the X renders
  for any non‑active row, incl. the default) and is **safe** under this design: the registry
  reassigns its `defaultId` to a still‑open root, but persistence is keyed/filtered by the
  fixed boot `defaultRoot`, so the promoted root is persisted under the boot key and the set
  is never recomputed from the registry's new default. On restart in the same cwd the boot
  default is re‑derived and the promoted root is restored. **No** added workspace is lost.
  (This is the blocking‑review data‑loss path, closed by the fixed‑key filter.)
- **Corrupt/missing/legacy‑v1 file** → `readStore` returns the empty v2 shape; server still
  boots with just the default and the next save rewrites the file as v2.
- **Duplicate of default** among persisted roots → `registry.open` dedups by
  `computeWorkspaceId` (returns the existing default without re‑adding); restore is idempotent.
- **Programmatic embed / `runWorkflow`** (`persistWorkspaces` unset) neither reads nor
  writes the file — no `onChange` is wired, so even post‑boot `runtime.workspaces.open/close`
  are filesystem‑inert. No surprise side effects for library consumers.
- **Concurrent IDEs, different cwds** → each touches only its own default‑root key
  (read‑modify‑write), so they never clobber each other. **Same cwd** → last‑write‑wins on
  the one shared key; this is a degenerate case (two IDEs of one project) and accepted.
- **CLI `--workspace` roots** are persisted (they join the non‑default set captured by the
  post‑boot save) and survive a subsequent plain `npx agentprism-ide` in the same cwd.
- **No write loop:** `workspaces.json` lives under `~/.agentprism/`, which the dev watcher
  now excludes, and it is never in the import graph — writing it cannot retrigger `tsx watch`.

---

## P1‑C — Real `defineCapability` import story (bare specifier + node_modules shim)

### Decision

Adopt the package‑name bare specifier **`agentprism/capability`** as the single,
collision‑proof, maintainable import for capability authors, and **retire** the
project‑tree `<root>/shared/capability.ts` shim. Resolution works in every mode without
publishing:

- **Monorepo / default workspace** (`root === PACKAGE_ROOT`): Node **self‑referencing**
  resolves `agentprism/capability` via the package's own `exports` — no shim written.
  *Evidence:* a probe package whose `package.json` sets
  `"exports": { "./capability": "./shared/capability.ts" }` resolved
  `import { defineCapability } from 'agentprism/capability'` from inside itself under
  `node --import tsx` (printed `SELF_REF_OK`).
- **External workspace** (`root !== PACKAGE_ROOT`): the runtime generates a tiny,
  sentinel‑guarded `node_modules/agentprism/` shim package re‑exporting PACKAGE_ROOT's
  capability source; standard Node resolution from `<root>/tools/foo.ts` walks up to it.
  *Evidence:* the same probe, with an external tool importing the bare specifier resolved
  via a `node_modules/agentprism` entry under `node --import tsx` (printed `EXT_BARE_OK`).
  `node_modules/` is gitignored, so the user's source tree is never polluted; and when a
  **real** `agentprism` is installed (future published consumer), the shim detects it and
  steps aside so the real package's `./capability` export resolves natively.
- **Plain default‑export fallback** (no import at all): `export default { name, secrets,
  effects }` already loads (`capability-loader.ts:115–119` validates the default‑export
  shape) and already derives per‑namespace dts (`derive-capability-dts.ts` reads
  `(typeof tool)['effects']` from the AST, independent of `defineCapability`). This is the
  documented zero‑dependency path for external authors who don't want types.

**Why the `./capability` target is source `.ts` (not `dist-lib`):** capability tool files
are themselves `.ts` and can only be `import()`ed by an environment with a `.ts` loader.
The IDE bin registers `tsx` in **both** the published and dev load paths
(`bin/agentprism-ide.mjs`), so any environment that can load a `.ts` tool can load the
`.ts` capability target. A conditional `import → dist-lib/...js` target would break dev
(no `dist-lib` until `build:lib`). Pre‑compiled‑`.js` external tools under a plain‑node
host are the only unsupported case and are explicitly out of scope (no such host exists;
the runtime + bin always run under tsx).

This single mechanism replaces the three‑pronged `../shared/capability.ts` resolution
(runtime shim, dts overlay, Monaco virtual lib) with one bare specifier — but **the three
tiers resolve it by DIFFERENT real mechanisms, not one uniform overlay**, and conflating
them is exactly the trap the dts step fell into (see change #3):

- **Runtime `import()` (Node):** self‑ref (PACKAGE_ROOT) or the on‑disk
  `node_modules/agentprism` shim (external/user). Real disk.
- **dts Program (`derive-capability-dts.ts`, Bundler resolution):** **also real disk** —
  the synthetic check/inject files are written under `workspaceRoot`, so the bare specifier
  resolves through the SAME on‑disk artifacts as the Node runtime (PACKAGE_ROOT self‑ref for
  the default ws; `<root>/node_modules/agentprism` shim for an external ws). It does **not**
  use a virtual `node_modules` overlay — a virtual overlay does **not** work here (proven
  below), because `ts.createCompilerHost`'s `directoryExists`/`realpath` consult the REAL
  disk and short‑circuit the `node_modules` probe for a directory that is not on disk, while
  the host only overrides `getSourceFile`/`fileExists`/`readFile`.
- **Monaco editor (browser worker):** a **purely virtual** `node_modules/agentprism`
  package fed via `extraLibs`. This is the one tier where a virtual overlay is correct,
  because Monaco's worker filesystem is entirely virtual (its `directoryExists` is virtual
  too — the same path that already resolves `zod/v4`).

**Critical ordering invariant (dts + runtime):** the on‑disk resolution target —
PACKAGE_ROOT's `exports['./capability']` (default ws) or the `<root>/node_modules/agentprism`
shim (external) / `~/.agentprism/node_modules/agentprism` (user tier) — MUST already exist
before `deriveCapabilityDts` (and the capability `import()`) run. It does:
`createWorkspace` writes both shims (`ensureAgentprismPackageShim` + `ensureUserAgentprismShim`,
lines 238–239) synchronously during `registry.open()`, **before** `loadCapabilities` →
`deriveCapabilityDts` is ever invoked for that workspace. This invariant is the load‑bearing
contract for change #3 and is documented at both ends (the shim writer and the dts deriver).

### Exact changes

**1. `package.json` — add the `exports` subpath.** (Owned by **Agent S**.)
Add to `exports` (after `"./server"`):
```json
"./capability": "./shared/capability.ts"
```
`shared/` is already in `files`, so the source ships. *Evidence:* string‑target
`"./capability": "./shared/capability.ts"` is exactly the form proven by the self‑ref and
external probes above.

**2. `runtime/workspace.ts` — replace the project‑tree shim with a node_modules shim.**
Replace the `ensureCapabilityShimAt` / `ensureCapabilityShim` / `ensureUserCapabilityShim`
block (lines 158–208) with a node_modules‑package generator. Keep the call sites in
`createWorkspace` (lines 238–239) but pointing at the new functions.

- New constant: `const SHIM_MARKER = '_agentprismShim'` (a boolean field in the generated
  `package.json` used as the idempotency/ownership sentinel).
- `function ensureAgentprismPackageShim(root: string): void`:
  - If `canonicalizeRoot(root) === canonicalizeRoot(PACKAGE_ROOT)` → **return** (the
    in‑repo/default workspace self‑resolves; never shim the package itself).
  - `const pkgDir = path.join(root, 'node_modules', 'agentprism')`,
    `pkgJson = path.join(pkgDir, 'package.json')`,
    `capFile = path.join(pkgDir, 'capability.ts')`.
  - If `pkgJson` exists: read+parse it; if `parsed._agentprismShim !== true` → a real
    install or user file → `return` (leave it; the real package provides `./capability`).
    If parse fails → treat as foreign → `return`.
  - Otherwise (re)write idempotently, with the **mkdir + writes wrapped in a
    best‑effort `try/catch`** (see "Write‑failure handling" below):
    - `package.json`:
      ```json
      { "name": "agentprism", "version": "0.0.0-agentprism-shim", "type": "module",
        "exports": { "./capability": "./capability.ts" }, "_agentprismShim": true }
      ```
    - `capability.ts`: `// @agentprism-capability-shim (generated; safe to delete)\n` +
      `export * from <JSON.stringify(rel)>\n`, where
      `rel = relative(pkgDir, path.join(PACKAGE_ROOT, 'shared', 'capability.ts'))`
      normalized to forward slashes and prefixed `./` when not already `.`‑relative.
    - `fs.mkdirSync(pkgDir, { recursive: true })` first.
  - Always rewrite when we own it (cheap; self‑heals a moved PACKAGE_ROOT).
- **Write‑failure handling (REQUIRED — both tiers).** The shim writes run synchronously
  inside `createWorkspace` (lines 238–239), i.e. inside `registry.open()` and thus inside
  `POST /api/workspaces` AND inside the P1‑B restore loop. A read‑only / full / permission‑
  denied external root must NOT fail the whole open. Wrap the `mkdirSync` + both
  `writeFileSync` calls (in each of `ensureAgentprismPackageShim` and
  `ensureUserAgentprismShim`) in a `try { … } catch { /* best‑effort: shim is a convenience;
  the tool degrades to a per‑module loadError */ }` — exactly the `savePersistedRoots`
  posture. Rationale: the documented degrade path is a per‑module `loadError`
  (`capability-loader.ts:129–131` already captures it), which is strictly better than a 500
  that prevents the workspace from opening at all. This also interlocks with P1‑B: if the
  shim write threw, `createWorkspace`→`open` would throw, the restore loop's `catch` would
  SKIP that root, and the single post‑restore `savePersistedRoots` would PRUNE it from disk
  permanently — silently dropping a previously‑persisted workspace on a transient write
  failure. Making the shim non‑fatal keeps the root open and persisted. The `pkgJson`
  read/parse probe stays as‑is (its `catch` already treats unreadable as "foreign → leave").
- `function ensureUserAgentprismShim(): void`: same generator (same best‑effort try/catch),
  targeting `path.dirname(USER_TOOLS_DIR)` (= `~/.agentprism`), but only when
  `~/.agentprism/tools` actually contains a capability file (preserve the existing
  `readdirSync(USER_TOOLS_DIR).some(/\.(ts|mts|js|mjs)$/)` gate). This writes
  `~/.agentprism/node_modules/agentprism/`, resolvable from `~/.agentprism/tools/foo.ts`.
- Update `createWorkspace` (lines 238–239):
  ```ts
  ensureAgentprismPackageShim(dirs.root)
  ensureUserAgentprismShim()
  ```
- Update the explanatory comments (lines 158–167) to describe the node_modules shim.
- **Do not** delete any pre‑existing `<root>/shared/capability.ts` left by the old shim;
  it is now inert (tools no longer import it) and removing files from the user's tree is
  out of scope. (Mention in the doc comment.)

**3. `runtime/engine/derive-capability-dts.ts` — resolve the bare specifier via REAL disk
(no virtual node_modules overlay).** The throwaway TS Program (Bundler resolution,
`allowImportingTsExtensions`) resolves `agentprism/capability` through the same on‑disk
artifacts as the Node runtime, **not** through an overlay.

> **Why NOT a virtual `node_modules/agentprism` overlay (rejected after empirical test).**
> The overlay host overrides only `getSourceFile`/`fileExists`/`readFile` (lines 95–111). A
> purely‑virtual `node_modules/agentprism` was reproduced against this exact host and TS
> returned **2307** (cannot find module): `ts.createCompilerHost`'s `directoryExists` and
> `realpath` hit the REAL disk and short‑circuit the `node_modules` probe
> (`directoryProbablyExists`) for a directory that does not exist on disk. The
> `runtime/tool-intellisense.ts` precedent does **not** apply — it resolves the workspace's
> REAL on‑disk `node_modules` and only re‑keys harvested files to virtual paths for the
> browser (the opposite direction). An overlay here would silently give false confidence
> while resolution actually rode on the on‑disk shim. We therefore do NOT overlay; we rely
> on disk and assert the on‑disk artifacts in verification. (If a future read‑only‑root need
> ever forces an overlay, it MUST additionally override `host.directoryExists` and
> `host.realpath` to be overlay‑aware and be re‑proven with the probe — the 3‑method set is
> provably insufficient.)

How real resolution lands for each tier (all on disk, all guaranteed present by the change‑#3
ordering invariant above — `createWorkspace` writes the shims before any derive runs):
- **Default ws** (`workspaceRoot === PACKAGE_ROOT`): the synthetic `__prism_inject__.ts` /
  `__prism_check__.ts` are written under `workspaceRoot` = PACKAGE_ROOT, so the bare
  specifier **self‑refs** through PACKAGE_ROOT's own `package.json` `exports['./capability']`
  (Agent S's change #1) → `shared/capability.ts`. *Verified: self‑ref → `shared/capability.ts`,
  diags `[]`.*
- **External ws**: the bare specifier walks up from `<root>/__prism_inject__.ts` and the
  per‑tool `<root>/tools/foo.ts` to `<root>/node_modules/agentprism` (the on‑disk shim from
  change #2) → its `exports['./capability']` → `capability.ts` → PACKAGE_ROOT source.
  *Verified: external on‑disk shim → `capability.ts`, diags `[]`.*
- **User‑tier tools** (`~/.agentprism/tools/foo.ts`): resolve up to
  `~/.agentprism/node_modules/agentprism` (the user‑tier shim from change #2).

Exact edits:
- Change `INJECT_SRC` (line 57): `import type { CapabilityContext } from 'agentprism/capability'`.
- **Delete** the `capSrc` read + the two `<...>/shared/capability.ts` overlay lines
  (164–171) entirely — there is **no** replacement overlay. The `overlays` map keeps ONLY
  `[injectPath, INJECT_SRC]` and `[checkPath, buildCheckSrc(files)]`; the base host resolves
  `agentprism/capability` off disk unchanged. Remove the now‑unused
  `import fs from 'node:fs'` (line 10).
- **Drop the dead params.** `packageRoot` and `userToolsParent` were used ONLY by the
  removed overlay. Remove both from `DeriveDtsOptions` (lines 22–29) and from the destructure
  at line 143 (`const { workspaceRoot } = opts`). Update the interface doc comment to state
  the bare specifier resolves off disk via the pre‑written shim/self‑ref (the ordering
  invariant), not via an injected overlay.
- **Update the one caller** `runtime/engine/capability-loader.ts` (lines 80–87): call
  `deriveCapabilityDts(scanned.map((f) => ({ path: f.path, modifiedAt: f.modifiedAt })),
  { workspaceRoot: o.workspaceRoot })`. `packageRoot`/`userToolsParent` are no longer passed.
  `LoadCapabilitiesOptions.packageRoot` (line 48) then has no remaining reader, so remove that
  field too and drop the `packageRoot: PACKAGE_ROOT` argument at `runtime/workspace.ts:265`
  (no dead threading). If removing `userToolsParent` leaves `path`/`USER_TOOLS_DIR` imports
  unused in `capability-loader.ts`, drop those imports as well (let `npm run lint` confirm).

**4. `src/lib/monaco-setup.ts` — resolve the bare specifier in the editor.**
Monaco's TS defaults already use Bundler resolution (`moduleResolution: 100`,
`allowImportingTsExtensions: true` — lines 99–111), so feed it a virtual
`node_modules/agentprism` package instead of `file:///<wsId>/shared/capability.ts`.
- Remove `capabilityLibPath` (lines 17–22). Replace `baseToolLibs(wsId)` (lines 156–161)
  to return the virtual package + the node shim:
  ```ts
  function agentprismPkgJson(wsId: string) {
    return {
      filePath: `file:///${wsId}/node_modules/agentprism/package.json`,
      content: JSON.stringify({
        name: 'agentprism', version: '0.0.0', type: 'module',
        exports: { './capability': './capability.ts' },
      }),
    }
  }
  function baseToolLibs(wsId: string) {
    return [
      agentprismPkgJson(wsId),
      { content: capabilitySource, filePath: `file:///${wsId}/node_modules/agentprism/capability.ts` },
      { content: NODE_SHIM_DTS, filePath: NODE_SHIM_FILE_PATH },
    ]
  }
  ```
  `capabilitySource` (the `@shared/capability.ts?raw` import, line 12) is unchanged — only
  its virtual path moves. Update the header comment (lines 8–11, 17–19).

**5. In‑repo capability tools — migrate the import.**
For each in‑repo capability module that imports `from '../shared/capability.ts'`, change it
to `from 'agentprism/capability'`. Confirmed sites: `tools/git.ts:2`, `tools/gitlab.ts:2`,
`tools/jira.ts:2`. Also `grep -n "from '\.\./shared/capability\.ts'" tools/*.ts` and migrate
any remaining match (e.g. `tools/mr-prompt.ts` if present). The default export
(`defineCapability({...})`) and effect bodies are unchanged. *Evidence:* self‑ref proven.
- **Scope guard:** do **not** touch `../shared/capability.ts` / `../shared/capability-resolve.ts`
  imports anywhere under `runtime/**`, `shared/**`, `server/**`, or `src/**` (those are
  correct package‑internal relative imports / `@shared` aliases, not author tools).

**6. `src/features/editor/WorkflowEditor.tsx` — comment only.**
Line ~176 references resolving "its relative `../shared/capability.ts` import against the
injected cap lib". Update the comment to reference `agentprism/capability`. No logic change
(verify there is no code keyed on the old string before editing).

**7. `.claude/skills/agentprism-authoring/tools.md` — update the authoring contract.**
Change the canonical import (line 16) from `'../shared/capability.ts'` to
`'agentprism/capability'`, and document the plain default‑export fallback
(`export default { name, secrets, effects }` — no import needed; least‑friction for
external workspaces).

### Acceptance criteria

- **In‑repo:** `GET /api/workspaces/:id/capabilities` for the default workspace lists
  `git`/`gitlab`/`jira` with their methods and **no `loadError`** (self‑ref resolved the
  bare specifier). No `<root>/shared/capability.ts` is created in the repo.
- **External:** opening a fresh external workspace whose `tools/foo.ts` imports
  `agentprism/capability` yields `foo` loaded with methods and no `loadError`; a
  `node_modules/agentprism/{package.json,capability.ts}` shim is generated under that root;
  a sibling `tools/bar.ts` using a **plain default export** (no import) also loads. No file
  is written into the external workspace's source tree (only under its `node_modules/`).
- **Real install untouched:** if `<root>/node_modules/agentprism/package.json` lacks the
  `_agentprismShim` sentinel, it is left as‑is.
- **Read‑only external root:** opening a root whose `node_modules` cannot be written
  (mounted RO / permission‑denied / disk full) still **succeeds** (HTTP 200, the ws opens);
  its `agentprism/capability`‑importing tools surface a normal per‑module `loadError`
  instead of failing the whole open with a 500. Under P1‑B such a root remains in
  `workspaces.json` (it is not pruned by a transient shim‑write failure).
- **Editor:** opening `foo.ts` in Monaco shows no "cannot find module 'agentprism/capability'"
  (2307) marker, and `defineCapability`/`Capability` are typed.
- **Derived dts:** the capabilities response `dts` for `foo` is non‑empty (effect signatures
  derived after the dts Program resolved `agentprism/capability` through the **on‑disk** shim /
  self‑ref — not a virtual overlay). For the default ws, the same response for `git`/`gitlab`/
  `jira` has non‑empty `dts` (PACKAGE_ROOT self‑ref). Removing/renaming a workspace's
  `node_modules/agentprism` shim before derive (violating the ordering invariant) would
  regress `dts` to the loose fallback — the shim‑before‑derive ordering is the guard.
- `npm run typecheck` and `npm run lint` pass.

### Edge cases

- **User‑owned `shared/` dir** in an external workspace no longer matters — nothing is
  written there and nothing imports `../shared/capability.ts`.
- **User‑tier tools** (`~/.agentprism/tools/*.ts`) resolve the bare specifier via the
  `~/.agentprism/node_modules/agentprism` shim (written only when user tools exist).
- **Default workspace == PACKAGE_ROOT** gets no generated shim and self‑resolves; the
  repo's own `node_modules/agentprism` is never created (the self‑ref path is used).
- **Orphaned old shim** (`<root>/shared/capability.ts` from prior runs) is inert and left
  in place.
- **Shim write fails** (RO/full/permission) → both tiers swallow the error (best‑effort);
  `createWorkspace`/`registry.open` never throw on this path, so the workspace opens and
  (P1‑B) is not pruned from persistence. The tool importing the bare specifier then loads
  with a `loadError`; the plain default‑export fallback is unaffected.

---

## Verification (empirical, per fix)

All three share the static gates first:

- `npm run typecheck` (tsc project refs + server tsconfig) — clean.
- `npm run lint` (oxlint) — clean.

Then per‑fix runtime/browser proof (dev: `npm run dev`, server on `:8787`, web on Vite):

**P1‑A (browser).** Open ≥2 workspaces. Clear the network log. Mouse‑click the X on a
non‑active workspace → observe exactly one `DELETE /api/workspaces/:id` (→ `{ok:true}`),
the row gone, `activeWorkspaceId` unchanged, dropdown still open. Re‑open the dropdown,
arrow to a non‑active option, press Delete → same DELETE + removal. Inspect the option
node for `aria-keyshortcuts="Delete"`. (Drive via the browser MCP: `read_network_requests`
for the DELETE, `read_page`/accessibility for the attribute.)

**P1‑B (runtime).** (1) `curl -s -XPOST :8787/api/workspaces -H 'content-type:application/json'
-d '{"root":"/tmp/ws-b"}'` (create `/tmp/ws-b` first) → then `cat ~/.agentprism/workspaces.json`
shows `{ "version": 2, "byDefaultRoot": { "<canonical cwd>": ["/tmp/ws-b"] } }`. (2) Restart the
server (same cwd) → `curl -s :8787/api/workspaces` lists `ws-b`; load the IDE → header shows it.
(3) `curl -s -XDELETE :8787/api/workspaces/<ws-b-id>` → `workspaces.json` no longer lists it (the
cwd key is dropped when its list empties). (4) Re‑add `/tmp/ws-b`, stop server, `rm -rf /tmp/ws-b`,
restart → `GET /api/workspaces` omits it and `workspaces.json` is pruned (no crash, dir not
recreated). (5) `echo '//x' >> ~/.agentprism/tools/<someTool>.ts` while `dev:server` runs →
confirm **no** restart line in the server log. (6) **Shipped bin:** `node bin/agentprism-ide.mjs
--cwd /tmp/projA --port 8790`, POST‑add `/tmp/ws-b`, kill, relaunch the same command → `ws-b`
returns (proves the fix ships via the bin, not just `dev:server`). (7) **Per‑project isolation:**
launch the bin with `--cwd /tmp/projC` → `GET /api/workspaces` does NOT list `/tmp/ws-b`
(keyed by default root). (8) **Embed inertness:** record `stat -c %Y ~/.agentprism/workspaces.json`,
run a `runWorkflow(wf, input)` (or `createRuntime({ workspaces:['/tmp/projA'] })` + open/close) in a
throwaway script, re‑stat → mtime unchanged (no `persistWorkspaces` → no file I/O). (9)
**Reconnect reconcile:** with the IDE page open and `/tmp/ws-b` the active ws, `rm -rf /tmp/ws-b`
and restart `dev:server` (page stays open, WS reconnects) → after the `hello`, the header/picker
repoints to the default ws and its routes 200 (no dangling active id, no 404 storm). (10)
**Close‑the‑default survival:** `node bin/agentprism-ide.mjs --cwd /tmp/projA --port 8790`,
POST‑add `/tmp/ws-b`, switch active to `/tmp/ws-b`, then `DELETE` the default `/tmp/projA`'s id
(promotes `/tmp/ws-b` to registry default) → `cat ~/.agentprism/workspaces.json` still lists
`/tmp/ws-b` under the `/tmp/projA` key; kill + relaunch the same command → `GET /api/workspaces`
returns `/tmp/ws-b` (proves persistence is keyed to the fixed boot default, not the promoted one).
(Drive the attribute/network checks via the browser MCP.)

**P1‑C (runtime + editor).** (1) Default workspace: `curl -s :8787/api/workspaces/<default>/capabilities`
→ `git`/`gitlab`/`jira` present, `loadError` absent; `git status` shows no new
`shared/capability.ts`. (2) Scaffold `/tmp/ws-c/tools/foo.ts` importing `agentprism/capability`
with one typed effect, and `/tmp/ws-c/tools/bar.ts` as a plain default export; open it via
`POST /api/workspaces` → `GET .../capabilities` shows `foo` and `bar` with methods, no
`loadError`, non‑empty `dts` for `foo`; assert `/tmp/ws-c/node_modules/agentprism/package.json`
exists with `_agentprismShim:true` and `/tmp/ws-c/shared/` does **not** exist. (3) In the IDE,
open `foo.ts` → no 2307 marker on the import; hover `defineCapability` shows its type. (4)
**Read‑only root:** `chmod -R a-w /tmp/ws-ro` (an external root with a `tools/foo.ts` importing
the bare specifier), `POST /api/workspaces {root:/tmp/ws-ro}` → HTTP 200 (the ws opens), `GET
.../capabilities` returns `foo` with a `loadError` (not a 500), and — if this run also exercised
P1‑B restore — `/tmp/ws-ro` is still present in `workspaces.json` (not pruned by the shim‑write
failure).

A focused Node smoke for the resolver (mirrors the proven probe) can also be run:
`node --import tsx <foo.ts>` from the repo resolves `agentprism/capability` via the shim
(EXT_BARE_OK pattern) — already verified for the mechanism.

---

## Sequencing & file ownership (fan‑out, no edit conflicts)

Partitioned so each concern is one agent with a disjoint file set. The **only** shared file
is `package.json`; it is owned solely by **Agent S**. No other file is edited by more than
one agent.

- **Agent A — P1‑A (UI/event layer).** Owns: `src/features/workspace/WorkspacePicker.tsx`.
  No dependencies. Fully parallel.

- **Agent B — P1‑B (persistence + restore + reconnect reconcile).** Owns: `runtime/paths.ts`,
  `runtime/workspace-store.ts` (new), `runtime/workspace-registry.ts`, `runtime/index.ts`,
  `server/index.ts`, `bin/agentprism-ide.mjs` (both set `persistWorkspaces: true`), and
  `src/store/useStore.ts` (the `hello` reconnect reconcile — change 7). Disjoint from Agent A
  (which owns only `WorkspacePicker.tsx`, not the store) and Agent C. Depends on Agent S only
  for the `dev:server` watcher flag at **verification** time (not at edit time — different
  file). Parallel with A and C.

- **Agent C — P1‑C (capability import story).** Owns: `runtime/workspace.ts`,
  `runtime/engine/derive-capability-dts.ts`, `runtime/engine/capability-loader.ts` (drop the
  now‑dead `packageRoot`/`userToolsParent` args to `deriveCapabilityDts` + the unused
  `LoadCapabilitiesOptions.packageRoot` field), `src/lib/monaco-setup.ts`,
  `src/features/editor/WorkflowEditor.tsx`, `tools/git.ts`, `tools/gitlab.ts`,
  `tools/jira.ts`, `tools/mr-prompt.ts` (only if it imports `../shared/capability.ts`),
  `.claude/skills/agentprism-authoring/tools.md`. Depends on Agent S for the
  `exports["./capability"]` entry at **runtime/verification** time (different file, no edit
  conflict). `capability-loader.ts` is C‑exclusive (B never touches it). Parallel with A and B.

- **Agent S — shared `package.json`.** Owns: `package.json` exclusively — makes **both**
  the P1‑C `exports["./capability"]` addition and the P1‑B `scripts.dev:server` watcher
  change (two non‑overlapping JSON keys, one owner → no merge conflict). Must land before B
  and C run their empirical (runtime) verification, but can edit fully in parallel with all.

Boundaries that keep the partition clean: B touches `runtime/` engine‑adjacent files
(registry/index/paths + new store), the two IDE entrypoints (`server/index.ts`,
`bin/agentprism-ide.mjs`), and `src/store/useStore.ts` — never `runtime/workspace.ts`,
`derive-capability-dts.ts`, or `capability-loader.ts` (C's); C never touches the
registry/index/store/entrypoints (B's). Note B exports `canonicalKey` from the new
`workspace-store.ts` and imports it into `runtime/index.ts` (both B‑owned — no cross‑agent
dependency).
`src/store/useStore.ts` is edited ONLY by B (the `hello` handler); Agent A edits only
`WorkspacePicker.tsx`, so the store has a single owner. P1‑A's "store unchanged" note refers to
`closeWorkspace()` (P1‑A's concern), which B does not touch — B edits a disjoint part (the
`hello` case). `runtime/paths.ts` is edited only by B (append a const); C imports from it without
editing it. Both B and C import from `package.json`'s effects at runtime only — neither edits it
(Agent S does).
