// runtime/engine/capability-loader.ts
// Host-side (TRUSTED realm) loading of capability modules + catalog build.
// This is the ONLY place a tools/ capability module is import()ed for real,
// so it must never run inside the vm sandbox. One bad module must not break
// the whole catalog: per-module import/validation failures are captured as a
// `loadError` string on the entry instead of throwing.

import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { scanCapabilityFiles } from '../store/capabilities.ts'
import { deriveCapabilityDts } from './derive-capability-dts.ts'
import type { Capability, EffectFn } from '../../shared/capability.ts'
import type { CapabilityCatalogEntry } from '../../shared/protocol.ts'
import type { CapabilityCatalog } from '../../shared/capability-resolve.ts'
import { resolveCapability } from '../../shared/capability-resolve.ts'

/** Shape returned by the filesystem scan (runtime/store/capabilities.ts, item 9). */
interface ScannedCapabilityFile {
  name: string
  path: string
  tier: 'project' | 'user'
  modifiedAt: number
}

/** Runtime validation of a module's default export against the `Capability` shape.
 *  Effect fns are validated as functions only (their bodies run host-side). */
const capabilitySchema = z.object({
  name: z.string().regex(/^[A-Za-z_$][\w$]*$/, 'invalid capability namespace name'),
  secrets: z.array(z.string()),
  effects: z.record(z.string(), z.custom<EffectFn>((v) => typeof v === 'function', 'effect must be a function')),
}) satisfies z.ZodType<Capability>

export interface LoadedCapabilities {
  /** Isomorphic catalog (project>user), keyed by bareName per tier. */
  catalog: CapabilityCatalog
  /** Flat, tier-tagged metadata view (safe DTO — no effect fns, no secret values). */
  entries: CapabilityCatalogEntry[]
  /** Successfully loaded modules, keyed by namespace name (bareName). */
  modules: Map<string, Capability>
}

/** Anchored inputs to load a workspace's capability catalog (§WU-3). */
export interface LoadCapabilitiesOptions {
  capabilityDirs: readonly { dir: string; tier: 'project' | 'user' }[]
  workspaceRoot: string
  env?: NodeJS.ProcessEnv
}

/** Compute per-secret presence from the host env (booleans only — never values). */
function computeSecretStatus(
  secrets: string[],
  env: NodeJS.ProcessEnv,
): Record<string, { present: boolean }> {
  const status: Record<string, { present: boolean }> = {}
  for (const key of secrets) {
    const val = env[key]
    status[key] = { present: typeof val === 'string' && val.length > 0 }
  }
  return status
}

/**
 * Load every scanned capability module in the trusted Node realm.
 *
 * For each file: `import()` with a `?v=<mtime>` cache-bust (so an edited module
 * reloads under `tsx watch`), validate `default` against the `Capability` shape,
 * compute `secretStatus` from `env`, and build a safe catalog entry. Failures are
 * captured per-module as `loadError` so one bad file never breaks the catalog.
 */
export async function loadCapabilities(o: LoadCapabilitiesOptions): Promise<LoadedCapabilities> {
  const env = o.env ?? process.env
  const scanned = (await scanCapabilityFiles(o.capabilityDirs)) as ScannedCapabilityFile[]

  // Derive each capability's namespace `.d.ts` from its effect signatures (no
  // hand-written `dts`). Cached by (workspaceRoot)+(path+mtime), so this only
  // rebuilds a TS Program when a tool file actually changes (§5.3).
  const derivedDts = deriveCapabilityDts(
    scanned.map((f) => ({ path: f.path, modifiedAt: f.modifiedAt })),
    { workspaceRoot: o.workspaceRoot },
  )

  const entries: CapabilityCatalogEntry[] = []
  const modules = new Map<string, Capability>()
  const catalog: CapabilityCatalog = { project: {}, user: {} }

  for (const file of scanned) {
    // Base entry — populated on success, carries `loadError` on failure.
    const entry: CapabilityCatalogEntry = {
      name: file.name,
      tier: file.tier,
      secrets: [],
      secretStatus: {},
      methods: [],
      dts: '',
      path: file.path,
      modifiedAt: file.modifiedAt,
    }

    try {
      const url = `${pathToFileURL(file.path).href}?v=${file.modifiedAt}`
      const mod = (await import(url)) as { default?: unknown }

      // tools/ is a MIXED directory: capabilities (`export default defineCapability(...)`)
      // AND pure helpers (named exports only, inlined into the sandbox by inline.ts).
      // A module is a capability ONLY if it default-exports an object; a pure helper
      // has no/object-less default and must be skipped — never surfaced as a broken
      // capability. (Mirrors inline.ts's static defineCapability discrimination.)
      if (typeof mod.default !== 'object' || mod.default === null) {
        continue
      }

      const cap = capabilitySchema.parse(mod.default) as Capability

      entry.name = cap.name
      entry.secrets = cap.secrets
      entry.secretStatus = computeSecretStatus(cap.secrets, env)
      entry.methods = Object.keys(cap.effects)
      // Namespace types are derived from the effect signatures, not hand-written.
      entry.dts = derivedDts.get(file.path) ?? ''

      modules.set(file.name, cap)
    } catch (err) {
      entry.loadError = err instanceof Error ? err.message : String(err)
    }

    entries.push(entry)
    catalog[file.tier][file.name] = entry
  }

  return { catalog, entries, modules }
}

/**
 * Resolve a workflow's declared `meta.capabilities` (with `user:`/`@me/`/`project:`
 * qualifiers) to the actual loaded `Capability` modules, honoring project>user.
 * Returns a map keyed by the capability namespace name so the run injects only
 * the declared + resolved namespaces. Unresolved or un-loaded names are skipped
 * (the validator surfaces unresolved names as hard errors separately).
 */
export function getCapabilityModules(
  loaded: LoadedCapabilities,
  names: string[],
): Map<string, Capability> {
  const out = new Map<string, Capability>()
  for (const raw of names) {
    const res = resolveCapability(loaded.catalog, raw)
    if (!res.resolved) continue
    const cap = loaded.modules.get(res.bareName)
    if (cap) out.set(cap.name, cap)
  }
  return out
}
