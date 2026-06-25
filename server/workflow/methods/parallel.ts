import type { MethodFactory } from './index.ts'

/**
 * Run an array of () => Promise thunks concurrently. Results in input order;
 * a recoverable failure becomes null in that slot. Concurrency is bounded by
 * host.agent (the limiter) itself, not here.
 */
export const parallel: MethodFactory = ({ helpers }) => {
  return async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw new TypeError('parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)')
    }
    thunks.forEach((t, i) => {
      if (typeof t !== 'function') {
        throw new TypeError(`parallel()[${i}] is not a function. Pass () => agent(...), not agent(...).`)
      }
    })
    return Promise.all(thunks.map((t, i) => helpers.settleThunk(t, `parallel[${i}]`)))
  }
}
