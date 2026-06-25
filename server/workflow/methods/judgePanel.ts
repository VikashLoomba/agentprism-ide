import type { MethodFactory, ParallelFn } from './index.ts'

const JSON_SCORE = {
  type: 'object',
  properties: { score: { type: 'number' }, reason: { type: 'string' } },
  required: ['score'],
}

/**
 * Score each candidate attempt with a panel of judges and return the best
 * (highest mean score). Per-call opts override the resolved config defaults.
 */
export const judgePanel: MethodFactory = ({ host, scope, config, helpers }) => {
  const { agent } = host
  const { asText } = helpers
  return async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const judges = Math.max(1, opts.judges ?? (config.judges as number))
    const rubric = opts.rubric ?? (config.rubric as string)
    const parallel = scope.parallel as ParallelFn
    let best = { index: 0, attempt: attempts[0], score: -1, judgments: [] as unknown[] }
    for (let index = 0; index < attempts.length; index++) {
      const scores = (await parallel(
        Array.from({ length: judges }, (_, j) => async () =>
          agent(
            `Score the following attempt from 0 to 1 on ${rubric}. Return a numeric score.\n\n${asText(attempts[index])}`,
            { schema: JSON_SCORE, label: `judge ${j + 1} / attempt ${index + 1}` },
          ),
        ),
      )) as Array<{ score?: number } | null>
      const nums = scores.filter((s): s is { score: number } => s != null && typeof s.score === 'number')
      const mean = nums.length ? nums.reduce((a, s) => a + s.score, 0) / nums.length : 0
      if (mean > best.score) best = { index, attempt: attempts[index], score: mean, judgments: scores }
    }
    return best
  }
}
