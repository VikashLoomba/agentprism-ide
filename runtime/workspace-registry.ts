// runtime/workspace-registry.ts
//
// The WorkspaceRegistry (§1, §1.2): hosts N workspaces in one process. open() and
// close() are first-class runtime mutations (the LSP added/removed delta model).
// The backing Map preserves insertion order, used for default reassignment on
// close. There is ALWAYS ≥1 open workspace post-construction (close rejects
// closing the last), so default()/defaultId()/getOrThrow never dangle.
import { createWorkspace, computeWorkspaceId } from './workspace.ts'
import type { Workspace, WorkspaceInfo, WorkspaceOpenOptions, WorkspaceRegistry } from './workspace.ts'
import { evictCapabilityDtsCache } from './engine/derive-capability-dts.ts'

export function createWorkspaceRegistry(opts: { env?: NodeJS.ProcessEnv } = {}): WorkspaceRegistry {
  const env = opts.env ?? process.env
  const map = new Map<string, Workspace>() // insertion order preserved
  let defaultId = ''

  function getOrThrow(id: string): Workspace {
    const ws = map.get(id)
    if (!ws) throw new Error(`Unknown workspace: ${id}`)
    return ws
  }

  return {
    open(root, o: WorkspaceOpenOptions = {}) {
      const id = computeWorkspaceId(root)
      const existing = map.get(id)
      if (existing) return existing
      const firstEver = defaultId === ''
      if (firstEver) defaultId = id
      const useEnvDirOverrides = o.useEnvDirOverrides ?? id === defaultId
      const ws = createWorkspace(root, { env: o.env ?? env, useEnvDirOverrides })
      map.set(id, ws)
      return ws
    },

    get: (id) => map.get(id),
    getOrThrow,
    has: (id) => map.has(id),

    list(): WorkspaceInfo[] {
      return [...map.values()].map((ws) => ({
        id: ws.id,
        name: ws.name,
        root: ws.root,
        isDefault: ws.id === defaultId,
      }))
    },

    default(): Workspace {
      if (!defaultId || !map.has(defaultId)) throw new Error('No workspaces open')
      return map.get(defaultId)!
    },

    defaultId(): string {
      if (!defaultId) throw new Error('No workspaces open')
      return defaultId
    },

    async close(id) {
      const ws = getOrThrow(id) // throws 'Unknown workspace: <id>' when absent
      if (map.size === 1) throw new Error('Cannot close the last open workspace')
      // Cancel in-flight runs (fire-and-forget) + evict the one per-workspace cache.
      for (const handle of ws.runtime.list()) handle.cancel()
      evictCapabilityDtsCache(ws.dirs.root)
      // Reassign default BEFORE removal when closing the current default.
      if (id === defaultId) {
        defaultId = [...map.keys()].find((k) => k !== id)! // guaranteed: size > 1
      }
      map.delete(id)
    },
  }
}
