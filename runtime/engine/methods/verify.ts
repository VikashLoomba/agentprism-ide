import type { MethodFactory, ParallelFn } from './index.ts'

const JSON_VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['real'],
}

/**
 * Adversarial fact-check: N reviewers independently vote on whether an item
 * holds up. Per-call opts override the resolved config (which already carries
 * defaults). Returns the aggregate verdict plus the raw votes.
 */
export const verify: MethodFactory = ({ host, scope, config, helpers }) => {
  const { agent } = host
  const { asText } = helpers
  return async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, opts.reviewers ?? (config.reviewers as number))
    const threshold = opts.threshold ?? (config.threshold as number)
    const lensCfg = opts.lens ?? (config.lens as string | string[] | undefined)
    const lenses = Array.isArray(lensCfg) ? lensCfg : lensCfg ? [lensCfg] : []
    const instruction = config.instruction as string
    const parallel = scope.parallel as ParallelFn
    const votes = (await parallel(
      Array.from({ length: reviewers }, (_, i) => async () => {
        const lens = lenses.length ? ` Use this lens: ${lenses[i % lenses.length]}.` : ''
        return agent(`${instruction}${lens}\n\n${asText(item)}`, {
          schema: JSON_VERDICT,
          label: `verify ${i + 1}/${reviewers}`,
        })
      }),
    )) as Array<{ real?: boolean; reason?: string } | null>
    const valid = votes.filter((v): v is { real?: boolean; reason?: string } => v != null)
    const realCount = valid.filter((v) => v.real).length
    const total = valid.length || 1
    return { real: realCount / total >= threshold, realCount, total, votes }
  }
}
