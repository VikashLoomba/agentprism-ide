// runtime/engine/prompt-loader.ts
// Host-side compile of .hbs templates + catalog build. Plain text => NO import(),
// NO zod default-export check, NO secretStatus. One bad file ≠ broken catalog.
//
// Mirrors runtime/engine/capability-loader.ts: two-tier scan, per-file loadError
// isolation, getPromptTemplates() resolving meta.prompts -> loaded templates.
// DIFFERS from capabilities: plain text (parsePrompt + Handlebars compile, no
// import()/zod/mixed-module discrimination, no secret plumbing). Per R1 each body
// is compiled exactly ONCE via compilePrompt — that single compile (with the shared
// PROMPT_COMPILE_OPTIONS) is BOTH the load-time error surface and the bound render
// delegate, so there is no per-call re-parse and no options mismatch.
import { scanPromptFiles } from '../store/prompts.ts'
import { parsePrompt, paramsToTsType } from '../../shared/prompt-frontmatter.ts'
import { createPromptEnv, registerPartial, compilePrompt } from '../../shared/prompt-env.ts'
import type { PromptTemplate } from '../../shared/prompt-template.ts'
import type { PromptCatalogEntry } from '../../shared/protocol.ts'
import type { PromptCatalog } from '../../shared/prompt-resolve.ts'
import { resolvePrompt } from '../../shared/prompt-resolve.ts'

const PREVIEW_LEN = 400

export interface LoadedPrompts {
  catalog: PromptCatalog                 // project>user, keyed by bareName per tier
  entries: PromptCatalogEntry[]          // flat, tier-tagged safe DTO (ships to browser)
  templates: Map<string, PromptTemplate> // keyed by bareName (== name == identifier)
}

export async function loadPrompts(
  promptDirs: readonly { dir: string; tier: 'project' | 'user' }[],
): Promise<LoadedPrompts> {
  const scanned = await scanPromptFiles(promptDirs)

  // One shared env across all templates so partials cross-resolve. Register FULL
  // bodies for every scanned file FIRST, then compile each as a renderable template.
  const env = createPromptEnv()
  const parsed = scanned.map((f) => ({ file: f, ...parsePrompt(f.body) }))
  for (const p of parsed) registerPartial(env, p.file.name, p.body) // full body, by identifier

  const entries: PromptCatalogEntry[] = []
  const templates = new Map<string, PromptTemplate>()
  const catalog: PromptCatalog = { project: {}, user: {} }

  for (const p of parsed) {
    const entry: PromptCatalogEntry = {
      name: p.file.name,
      tier: p.file.tier,
      params: p.params,
      paramsDts: paramsToTsType(p.params),
      preview: p.body.slice(0, PREVIEW_LEN),  // HOVER snippet only — NEVER a render input
      body: p.body,                            // FULL body — render-parity in the preview
      path: p.file.path,
      modifiedAt: p.file.modifiedAt,
    }
    try {
      if (p.error) throw new Error(`frontmatter: ${p.error}`)
      // R1: compile ONCE (with PROMPT_COMPILE_OPTIONS). This single compile is the
      // load-time error surface AND the bound render delegate — no second compile,
      // no per-call re-parse. Mirrors capabilities binding their effect fn once.
      const render = compilePrompt(env, p.body)
      const tpl: PromptTemplate = {
        name: p.file.name,
        params: p.params,
        render,
      }
      templates.set(p.file.name, tpl)
    } catch (err) {
      entry.loadError = err instanceof Error ? err.message : String(err)
    }
    entries.push(entry)
    catalog[p.file.tier][p.file.name] = entry
  }
  return { catalog, entries, templates }
}

/** Resolve declared meta.prompts (project>user, qualifiers) to loaded templates,
 *  keyed by the namespace member name (== bareName == identifier). Mirror of
 *  getCapabilityModules; unresolved names skipped (validator flags them). */
export function getPromptTemplates(loaded: LoadedPrompts, names: string[]): Map<string, PromptTemplate> {
  const out = new Map<string, PromptTemplate>()
  for (const raw of names) {
    const res = resolvePrompt(loaded.catalog, raw)
    if (!res.resolved) continue
    const tpl = loaded.templates.get(res.bareName)
    if (tpl) out.set(tpl.name, tpl)   // key == res.bareName == tpl.name; no mixing
  }
  return out
}
