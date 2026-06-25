// shared/capability-resolve.ts  (isomorphic — NO node:* imports)
import type { CapabilityCatalogEntry } from './protocol.ts'

export type CapabilityTier = 'project' | 'user'

/** Parsed qualifier from a meta.capabilities entry. */
export interface ParsedCapabilityRef {
  /** 'user' forced by `user:` or `@me/`; 'project' forced by `project:`; null = bare. */
  scope: CapabilityTier | null
  /** Namespace name with the qualifier stripped. */
  bareName: string
}

/** Parse `user:jira`, `@me/jira`, `project:jira`, or bare `jira`. */
export function parseCapabilityRef(raw: string): ParsedCapabilityRef {
  if (raw.startsWith('user:'))    return { scope: 'user',    bareName: raw.slice(5).trim() }
  if (raw.startsWith('@me/'))     return { scope: 'user',    bareName: raw.slice(4).trim() }
  if (raw.startsWith('project:')) return { scope: 'project', bareName: raw.slice(8).trim() }
  return { scope: null, bareName: raw.trim() }
}

export interface CapabilityResolution {
  /** The original meta.capabilities entry (with qualifier). */
  ref: string
  bareName: string
  /** Which tier actually resolved, or null if unresolved. */
  resolved: CapabilityTier | null
  /** True when BOTH tiers define bareName and project won (drives the INFO note). */
  shadowsUser: boolean
}

/** A flat, isomorphic view of what each tier offers — built server-side from
 *  scanned dirs, fetched browser-side from /api/capabilities. */
export interface CapabilityCatalog {
  project: Record<string, CapabilityCatalogEntry>  // bareName -> entry
  user: Record<string, CapabilityCatalogEntry>
}

/** Resolve a single meta.capabilities entry. Project wins on shadow. */
export function resolveCapability(catalog: CapabilityCatalog, raw: string): CapabilityResolution {
  const { scope, bareName } = parseCapabilityRef(raw)
  const inProject = bareName in catalog.project
  const inUser = bareName in catalog.user
  let resolved: CapabilityTier | null = null
  if (scope === 'project') resolved = inProject ? 'project' : null
  else if (scope === 'user') resolved = inUser ? 'user' : null
  else resolved = inProject ? 'project' : inUser ? 'user' : null   // bare: project-first
  return { ref: raw, bareName, resolved, shadowsUser: resolved === 'project' && inUser && scope === null }
}
