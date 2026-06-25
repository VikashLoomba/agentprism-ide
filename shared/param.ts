// shared/param.ts  (isomorphic — NO node:* imports)
//
// Neutral parameter primitives shared by prompt templates (PromptParam) and
// workflow inputs (WorkflowInputParam). Both declare a flat, closed set of
// param types so dts emission is total and can never produce an open member.
//
// Lives here (not in prompt-frontmatter.ts) so the workflow side can depend on
// the type union + helpers without pulling the prompt frontmatter parser. The
// prompt-frontmatter module re-exports these for back-compat.
import type { Json } from './capability.ts'

/** Closed set of declarable param types. Flat by design so paramsToTsType is
 *  total and dts emission can never produce an open/un-typed member. */
export const PARAM_TYPES = [
  'string', 'number', 'boolean',
  'string[]', 'number[]', 'boolean[]',
] as const
export type ParamType = (typeof PARAM_TYPES)[number]

/** Structural shape that BOTH PromptParam and WorkflowInputParam satisfy.
 *  `optional` drives whether the emitted dts member is `name?:` vs `name:`. */
export interface TsParam {
  name: string
  type: ParamType
  description?: string
  optional?: boolean
}

/** Type-derived placeholder value for a param (live-preview seed / default). */
export function placeholderFor(type: ParamType, name: string): Json {
  switch (type) {
    case 'string': return `<${name}>`
    case 'number': return 0
    case 'boolean': return false
    case 'string[]': return [`<${name}[0]>`]
    case 'number[]': return [0]
    case 'boolean[]': return [false]
  }
}

const TS_TYPE: Record<ParamType, string> = {
  string: 'string', number: 'number', boolean: 'boolean',
  'string[]': 'string[]', 'number[]': 'number[]', 'boolean[]': 'boolean[]',
}

/** Map declared params to a TS object-type literal string for a dts member.
 *  Total over PARAM_TYPES; empty params => `{}` (still valid). Members are
 *  required (`name:`) unless `optional` is true (`name?:`). */
export function paramsToTsType(params: TsParam[]): string {
  if (params.length === 0) return '{}'
  const lines = params.map((p) => {
    const doc = p.description ? `    /** ${p.description.replace(/\*\//g, '* /')} */\n` : ''
    return `${doc}    ${p.name}${p.optional ? '?' : ''}: ${TS_TYPE[p.type]};`
  })
  return `{\n${lines.join('\n')}\n  }`
}
