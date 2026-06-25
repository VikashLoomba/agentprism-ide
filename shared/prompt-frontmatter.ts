// shared/prompt-frontmatter.ts  (isomorphic — NO node:* imports)
import { z } from 'zod'
import type { Json } from './capability.ts'

/** Closed set of declarable param types. Flat by design so paramsToTsType is total
 *  and dts emission can never produce an open/un-typed member. */
export const PROMPT_PARAM_TYPES = [
  'string', 'number', 'boolean',
  'string[]', 'number[]', 'boolean[]',
] as const
export type PromptParamType = (typeof PROMPT_PARAM_TYPES)[number]

/** One declared parameter (name + type, optional default/example/description). */
export interface PromptParam {
  name: string
  type: PromptParamType
  description?: string
  /** Seeds live-preview sample data + workflow-facing default. Must match `type`. */
  default?: Json
  /** Optional explicit preview sample, overriding the type-derived default. */
  example?: Json
}

/** Parsed result of one .hbs file: typed params + the Handlebars body (frontmatter stripped). */
export interface ParsedPrompt {
  params: PromptParam[]
  /** The Handlebars template source with the frontmatter fence removed. */
  body: string
}

/** Validator for any JSON value, so parsed `default`/`example` type as `Json`
 *  (not `unknown`) and satisfy `z.ZodType<PromptParam>`. */
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
)

const paramSchema = z.object({
  name: z.string().regex(/^[A-Za-z_$][\w$]*$/, 'param name must be an identifier'),
  type: z.enum(PROMPT_PARAM_TYPES),
  description: z.string().optional(),
  default: jsonValue.optional(),
  example: jsonValue.optional(),
}) satisfies z.ZodType<PromptParam>

const frontmatterSchema = z.object({
  params: z.array(paramSchema).default([]),
})

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/**
 * Split a .hbs source into { params, body }. The frontmatter is a leading
 * `---\n<json>\n---` fence whose JSON body has shape { params: PromptParam[] }.
 * Never throws: a missing/blank fence yields zero params; a malformed fence is
 * reported via `error` so the live preview degrades gracefully (warn-don't-reject).
 */
export function parsePrompt(source: string): ParsedPrompt & { error?: string } {
  const m = FENCE.exec(source)
  if (!m) return { params: [], body: source }
  const body = source.slice(m[0].length)
  try {
    const raw = JSON.parse(m[1]) as unknown
    const parsed = frontmatterSchema.parse(raw)
    return { params: parsed.params, body }
  } catch (err) {
    return { params: [], body, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Seed sample data for the live preview from the declared params:
 *  example ?? default ?? a type-derived placeholder. Deterministic. */
export function seedSampleData(params: PromptParam[]): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const p of params) {
    if (p.example !== undefined) { out[p.name] = p.example; continue }
    if (p.default !== undefined) { out[p.name] = p.default; continue }
    out[p.name] = placeholderFor(p.type, p.name)
  }
  return out
}

function placeholderFor(type: PromptParamType, name: string): Json {
  switch (type) {
    case 'string': return `<${name}>`
    case 'number': return 0
    case 'boolean': return false
    case 'string[]': return [`<${name}[0]>`]
    case 'number[]': return [0]
    case 'boolean[]': return [false]
  }
}

/** Map the declared params to a TS object-type literal string for the dts member.
 *  Total over PROMPT_PARAM_TYPES; empty params => `{}` (still valid). */
export function paramsToTsType(params: PromptParam[]): string {
  if (params.length === 0) return '{}'
  const lines = params.map((p) => {
    const doc = p.description ? `    /** ${p.description.replace(/\*\//g, '* /')} */\n` : ''
    return `${doc}    ${p.name}: ${TS_TYPE[p.type]};`
  })
  return `{\n${lines.join('\n')}\n  }`
}

const TS_TYPE: Record<PromptParamType, string> = {
  string: 'string', number: 'number', boolean: 'boolean',
  'string[]': 'string[]', 'number[]': 'number[]', 'boolean[]': 'boolean[]',
}
