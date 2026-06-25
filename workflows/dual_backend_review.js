export const meta = {
  name: 'dual_backend_review',
  description:
    'Review the codebase with Claude AND Codex in parallel, then have Claude synthesize — showcases per-call agent selection with discriminated config.',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Synthesize' }],
}

// jsonSchema(...) preserves the literal type, so `scan.areas` below is string[].
const AREAS = jsonSchema({
  type: 'object',
  properties: {
    areas: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['areas'],
})

// jsonSchema(...) preserves the literal type so r.findings below is typed.
const FINDINGS = jsonSchema({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['area', 'issue', 'severity'],
      },
    },
  },
  required: ['findings'],
})

phase('Scan')
// Cheap inventory pass on Codex (read-only, low reasoning). The schema makes the
// contract explicit — `scan.areas` is a typed string[], no prompt-shaped parsing.
const scan = await agent('List the 3 most important source areas/modules to review.', {
  agent: 'codex',
  config: { mode: 'read-only', reasoning_effort: 'low' },
  schema: AREAS,
  label: 'scan (codex)',
})
const areas = (scan?.areas ?? []).map((a) => a.trim()).filter(Boolean)

phase('Review')
// Each area reviewed by BOTH backends concurrently — note how `config` narrows to
// each agent's options: Claude takes `effort`, Codex takes `reasoning_effort`.
const reviews = await parallel(
  areas.flatMap((area) => [
    () =>
      agent(`Review ${area} for correctness bugs. Report concrete issues.`, {
        agent: 'claude',
        config: { model: 'sonnet', effort: 'medium' },
        schema: FINDINGS,
        label: `claude: ${area}`,
      }),
    () =>
      agent(`Review ${area} for correctness bugs. Report concrete issues.`, {
        agent: 'codex',
        config: { model: 'gpt-5-codex', reasoning_effort: 'medium' },
        schema: FINDINGS,
        label: `codex: ${area}`,
      }),
  ]),
)

// Typed by jsonSchema(FINDINGS): `r.findings` is { area, issue, severity }[].
const allFindings = reviews.filter(Boolean).flatMap((r) => (r && Array.isArray(r.findings) ? r.findings : []))

phase('Synthesize')
// Claude (opus, high effort) merges both backends' findings into one report.
return await agent(
  'Merge and de-duplicate these findings from two independent reviewers into a concise report, ' +
    'grouped by severity:\n\n' +
    JSON.stringify(allFindings, null, 2),
  { agent: 'claude', config: { model: 'opus', effort: 'high' }, label: 'synthesize (claude)' },
)
