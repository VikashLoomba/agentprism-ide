import type { MethodFactory } from './index.ts'

const JSON_COMPLETE = {
  type: 'object',
  properties: { complete: { type: 'boolean' }, missing: { type: 'array', items: { type: 'string' } } },
  required: ['complete'],
}

/** Final "what's missing?" critic over a set of results. */
export const completenessCheck: MethodFactory = ({ host, config, helpers }) => {
  const { agent } = host
  const { asText } = helpers
  return async (taskArgs: unknown, results: unknown) => {
    const instruction = (config.instruction as string)
    return agent(`${instruction}\n\nARGS:\n${asText(taskArgs)}\n\nRESULTS:\n${asText(results)}`, {
      schema: JSON_COMPLETE,
      label: 'completeness check',
    })
  }
}
