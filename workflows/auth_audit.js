export const meta = {
  name: 'auth_audit',
  description: 'Find routes missing auth checks and verify the findings',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
}

phase('Scan')
const files = await agent('List every route file under src/ (one path per line, no prose).', {
  config: { model: 'haiku' },
  label: 'route inventory',
})

phase('Review')
const findings = await parallel(
  (files ?? '')
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((file) => () =>
      agent(`Audit ${file} for routes missing authentication/authorization checks. Be concise.`, {
        config: { model: 'sonnet' },
        label: `audit ${file}`,
      }),
    ),
)

phase('Verify')
return await agent(
  'Synthesize and double-check these audit findings into a short report:\n\n' +
    findings.filter(Boolean).join('\n\n'),
  { config: { model: 'opus', effort: 'high' }, label: 'synthesis' },
)
