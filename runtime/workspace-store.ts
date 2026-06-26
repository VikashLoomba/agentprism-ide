// runtime/workspace-store.ts
// Persistence for dynamically‑added (non‑default) workspace roots (P1‑B), keyed by
// the canonical default (cwd) root. ONLY the two IDE entrypoints opt in
// (persistWorkspaces); the programmatic embed never touches this file.
import fs from 'node:fs'
import path from 'node:path'
import { USER_WORKSPACES_FILE } from './paths.ts'

interface PersistShape {
  version: 2
  byDefaultRoot: Record<string, string[]>
}

/** Canonical, stable key for a root (realpath; falls back to resolve). EXPORTED so the
 *  composition root (`runtime/index.ts`) filters the persisted set against the SAME fixed
 *  boot‑default key this module writes under — never against the registry's mutable default. */
export function canonicalKey(p: string): string {
  try {
    return fs.realpathSync.native(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

/** Read+normalize the whole file. Tolerates missing/corrupt/legacy → empty shape. */
function readStore(): PersistShape {
  let raw: string
  try {
    raw = fs.readFileSync(USER_WORKSPACES_FILE, 'utf8')
  } catch {
    return { version: 2, byDefaultRoot: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistShape> | null
    const byDefaultRoot = parsed?.byDefaultRoot
    if (parsed?.version === 2 && byDefaultRoot && typeof byDefaultRoot === 'object') {
      return { version: 2, byDefaultRoot: byDefaultRoot as Record<string, string[]> }
    }
  } catch {
    /* corrupt → empty */
  }
  return { version: 2, byDefaultRoot: {} }
}

/** Read the persisted non‑default roots for `defaultRoot`. Tolerates missing/corrupt
 *  (→ []). Filters to absolute paths that currently exist as directories (auto‑prune). */
export function loadPersistedRoots(defaultRoot: string): string[] {
  const roots = readStore().byDefaultRoot[canonicalKey(defaultRoot)]
  if (!Array.isArray(roots)) return []
  return roots.filter((r): r is string => {
    if (typeof r !== 'string' || !path.isAbsolute(r)) return false
    try {
      return fs.statSync(r).isDirectory()
    } catch {
      return false
    }
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
  } catch {
    /* best‑effort */
  }
}
