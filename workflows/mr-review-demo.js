export const meta = {
  name: 'mr_review_demo',
  description: 'Review a merge request using the mrReview prompt template.',
  phases: [{ title: 'Review' }],
  prompts: ['mrReview'],   // resolves project prompts/ first, then Shared prompts
}

phase('Review')

const p = prompts.mrReview({
  acceptanceCriteria: ['Has tests', 'Updates docs', 'No leftover console.log'],
  comments: ['Consider the empty-input edge case'],
  diff: args.diff ?? 'diff --git a/x.ts b/x.ts\n+ const y = 1',
})

return await agent(p, { cwd, label: 'mr review', schema: {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'request-changes'] } },
} })
