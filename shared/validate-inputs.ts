// shared/validate-inputs.ts  (isomorphic — NO node:* imports)
//
// The reusable run gate: validate a bag of input VALUES against a workflow's
// declared `meta.inputs`. Used by both the engine (before VM exec) and the IDE
// (to gate Run + derive `inputsValid`). Strict types, no coercion.
import type { WorkflowInputParam } from './dsl.ts'
import type { ParamType } from './param.ts'
import type { Json } from './capability.ts'

export interface InputValidationResult {
  ok: boolean
  /** The cleaned input bag, keyed by declared input name. When inputs are
   *  declared, only declared keys survive (unknown extras are dropped). */
  value: Record<string, Json>
  errors: string[]
}

/** True when `value` strictly matches the declared param `type` (no coercion). */
function valueMatchesParamType(value: unknown, type: ParamType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'string[]': return Array.isArray(value) && value.every((v) => typeof v === 'string')
    case 'number[]': return Array.isArray(value) && value.every((v) => typeof v === 'number')
    case 'boolean[]': return Array.isArray(value) && value.every((v) => typeof v === 'boolean')
  }
}

/**
 * Validate `values` against the declared `inputs`.
 *
 * - `inputs` undefined/empty → back-compat: pass `values` through untouched
 *   (free-form `args` still work), no errors.
 * - Otherwise, STRICT: required & missing → error; provided & type mismatch →
 *   error; missing optional with a `default` → seeded from the default; unknown
 *   extra keys are DROPPED (value stays clean).
 */
export function validateInputs(
  inputs: WorkflowInputParam[] | undefined,
  values: unknown,
): InputValidationResult {
  // Back-compat: no declared inputs ⇒ free-form args pass through untouched.
  if (!inputs || inputs.length === 0) {
    return { ok: true, value: (values ?? {}) as Record<string, Json>, errors: [] }
  }

  const obj =
    values && typeof values === 'object' && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : undefined

  const errors: string[] = []
  const value: Record<string, Json> = {}
  for (const input of inputs) {
    const provided = obj ? obj[input.name] : undefined
    if (provided === undefined) {
      if (input.required) {
        errors.push(`input "${input.name}" is required`)
      } else if (input.default !== undefined) {
        value[input.name] = input.default
      }
      continue
    }
    if (!valueMatchesParamType(provided, input.type)) {
      errors.push(`input "${input.name}" must be of type ${input.type}`)
      continue
    }
    value[input.name] = provided as Json
  }
  return { ok: errors.length === 0, value, errors }
}
