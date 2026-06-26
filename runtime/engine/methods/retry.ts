import type { MethodFactory } from './index.ts'

/**
 * Bounded retry of a thunk until a predicate holds. Returns the last value
 * regardless once attempts are exhausted. Per-call opts override config.
 */
export const retry: MethodFactory = ({ config }) => {
  return async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ): Promise<unknown> => {
    const attempts = Math.max(1, opts.attempts ?? (config.attempts as number))
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i)
      if (!opts.until || opts.until(last)) return last
    }
    return last
  }
}
