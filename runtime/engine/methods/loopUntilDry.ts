import type { MethodFactory } from './index.ts'

/**
 * Keep running rounds until they stop yielding new (deduped) items. Stops after
 * `consecutiveEmpty` barren rounds or `maxRounds`. Per-call opts override the
 * resolved config defaults.
 */
export const loopUntilDry: MethodFactory = ({ config, helpers }) => {
  const { isNonRecoverable } = helpers
  return async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[]
    key?: (item: unknown) => string
    consecutiveEmpty?: number
    maxRounds?: number
  }): Promise<unknown[]> => {
    if (typeof opts?.round !== 'function') throw new TypeError('loopUntilDry requires opts.round to be a function.')
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x))
    const stopAfter = Math.max(1, opts.consecutiveEmpty ?? (config.consecutiveEmpty as number))
    const maxRounds = opts.maxRounds ?? (config.maxRounds as number)
    const seen = new Set<string>()
    const acc: unknown[] = []
    let empties = 0
    for (let r = 0; r < maxRounds && empties < stopAfter; r++) {
      let produced: unknown[]
      try {
        produced = (await opts.round(r)) ?? []
      } catch (err) {
        if (isNonRecoverable(err)) return acc
        throw err
      }
      const fresh = produced.filter((item) => {
        const k = key(item)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      if (fresh.length === 0) empties++
      else {
        empties = 0
        acc.push(...fresh)
      }
    }
    return acc
  }
}
