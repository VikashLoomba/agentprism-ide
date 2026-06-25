import type { MethodFactory } from './index.ts'

/**
 * Run a thunk, validate its output, and feed the validator's feedback into the
 * next attempt. Returns { ok, value, attempts }. Per-call opts override config.
 */
export const gate: MethodFactory = ({ config }) => {
  return async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ): Promise<{ ok: boolean; value: unknown; attempts: number }> => {
    const attempts = Math.max(1, opts.attempts ?? (config.attempts as number))
    let feedback: string | undefined
    let value: unknown
    for (let i = 0; i < attempts; i++) {
      value = await thunk(feedback, i)
      const verdict = await validator(value)
      if (verdict.ok) return { ok: true, value, attempts: i + 1 }
      feedback = verdict.feedback
    }
    return { ok: false, value, attempts }
  }
}
