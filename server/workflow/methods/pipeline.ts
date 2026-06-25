import type { MethodFactory } from './index.ts'

/**
 * Fan each item through sequential stages; different items run concurrently.
 * Each stage receives (previousValue, originalItem, index). A stage that throws
 * a recoverable error drops that item to null.
 */
export const pipeline: MethodFactory = ({ helpers }) => {
  return async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ): Promise<unknown[]> => {
    if (!Array.isArray(items)) throw new TypeError('pipeline() expects an array of items as the first argument.')
    stages.forEach((s, i) => {
      if (typeof s !== 'function') throw new TypeError(`pipeline() stage ${i} is not a function.`)
    })
    return Promise.all(
      items.map((item, index) =>
        helpers.settleThunk(async () => {
          let value: unknown = item
          for (const stage of stages) value = await stage(value, item, index)
          return value
        }, `pipeline[${index}]`),
      ),
    )
  }
}
