export const meta = {
  name: 'codebase_review',
  description: 'Find potential bugs across the codebase and adversarially verify each one',
  phases: [{ title: 'Map' }, { title: 'Find' }, { title: 'Verify' }, { title: 'Report' }],
}

// Wrap in jsonSchema(...) so agent({ schema: BUG_SCHEMA }) infers a typed result
// (r.bugs[i].file / .severity autocomplete) — works in plain JS without `as const`.
const BUG_SCHEMA = jsonSchema({
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['file', 'description', 'severity'],
      },
    },
  },
  required: ['bugs'],
})

phase('Map')
const areas = await agent(
  'List the 4 most important source directories or modules in this project, one per line.',
  { config: { model: 'haiku' }, label: 'project map' },
)

phase('Find')
const findings = await parallel(
  (areas ?? '')
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((area) => () =>
      agent(`Review ${area} for correctness bugs. Report concrete issues.`, {
        schema: BUG_SCHEMA,
        config: { model: 'sonnet' },
        label: `find: ${area}`,
      }),
    ),
)

const bugs = findings
  .filter(Boolean)
  .flatMap((r) => (r && Array.isArray(r.bugs) ? r.bugs : []))

phase('Verify')
const confirmed = await parallel(
  bugs.map((bug) => async () => {
    const verdict = await verify(`${bug.file}: ${bug.description}`, { reviewers: 2 })
    return verdict.real ? bug : null
  }),
)

phase('Report')
return await agent(
  'Write a concise review summary from these confirmed bugs:\n\n' +
    JSON.stringify(confirmed.filter(Boolean), null, 2),
  { config: { model: 'opus', effort: 'high' }, label: 'final report' },
)
