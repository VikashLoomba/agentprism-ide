// shared/prompt-template.ts  (isomorphic — NO node:* imports)
import type { Json } from './capability.ts'
import type { PromptParam } from './prompt-frontmatter.ts'

/** A loaded, compiled prompt template (the host-side counterpart of a Capability). */
export interface PromptTemplate {
  /** Namespace member name injected as prompts.<name>. == bareName == filename.
   *  Identifier-only (Option A): no transform, mirrors Capability.name exactly. */
  name: string
  /** Declared params (from frontmatter) — types the call + seeds preview. */
  params: PromptParam[]
  /** Pure synchronous render: prompts.<name>(data) => string. NO ctx, NO secrets. */
  render: (data: Json) => string
}

/** Identity helper; validates the name is an identifier (same regex as defineCapability). */
export function definePromptTemplate<T extends PromptTemplate>(tpl: T): T {
  if (!tpl.name || !/^[A-Za-z_$][\w$]*$/.test(tpl.name)) {
    throw new Error(`definePromptTemplate: invalid prompt name "${tpl.name}"`)
  }
  return tpl
}
