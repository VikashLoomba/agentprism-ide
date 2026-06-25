// shared/prompt-resolve.ts  (isomorphic — NO node:* imports)
import type { PromptCatalogEntry } from './protocol.ts'

export type PromptTier = 'project' | 'user'

/** Parsed qualifier from a meta.prompts entry. */
export interface ParsedPromptRef {
  /** 'user' forced by `user:` or `@me/`; 'project' forced by `project:`; null = bare. */
  scope: PromptTier | null
  /** Namespace member name with the qualifier stripped. */
  bareName: string
}

/** Parse `user:mrReview`, `@me/mrReview`, `project:mrReview`, or bare `mrReview`. */
export function parsePromptRef(raw: string): ParsedPromptRef {
  if (raw.startsWith('user:'))    return { scope: 'user',    bareName: raw.slice(5).trim() }
  if (raw.startsWith('@me/'))     return { scope: 'user',    bareName: raw.slice(4).trim() }
  if (raw.startsWith('project:')) return { scope: 'project', bareName: raw.slice(8).trim() }
  return { scope: null, bareName: raw.trim() }
}

export interface PromptResolution {
  /** The original meta.prompts entry (with qualifier). */
  ref: string
  bareName: string
  /** Which tier actually resolved, or null if unresolved. */
  resolved: PromptTier | null
  /** True when BOTH tiers define bareName and project won (drives the INFO note). */
  shadowsUser: boolean
}

/** A flat, isomorphic view of what each tier offers — built server-side from
 *  scanned dirs, fetched browser-side from /api/prompts. */
export interface PromptCatalog {
  project: Record<string, PromptCatalogEntry>   // bareName -> entry
  user: Record<string, PromptCatalogEntry>
}

/** Resolve a single meta.prompts entry. Project wins on shadow. */
export function resolvePrompt(catalog: PromptCatalog, raw: string): PromptResolution {
  const { scope, bareName } = parsePromptRef(raw)
  const inProject = bareName in catalog.project
  const inUser = bareName in catalog.user
  let resolved: PromptTier | null = null
  if (scope === 'project') resolved = inProject ? 'project' : null
  else if (scope === 'user') resolved = inUser ? 'user' : null
  else resolved = inProject ? 'project' : inUser ? 'user' : null   // bare: project-first
  return { ref: raw, bareName, resolved, shadowsUser: resolved === 'project' && inUser && scope === null }
}
