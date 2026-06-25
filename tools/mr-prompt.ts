// tools/mr-prompt.ts  — pure helper: no defineCapability, no world access.
// Inlined into the sandbox by server/workflow/inline.ts (never host-loaded).
export function buildReviewPrompt(input: {
  acceptanceCriteria: string[]
  comments: string[]
  diff: string
}): string {
  return [
    'Review this merge request against its acceptance criteria.',
    'ACCEPTANCE CRITERIA:',
    ...input.acceptanceCriteria.map((c) => `- ${c}`),
    'REVIEWER COMMENTS:',
    ...input.comments.map((c) => `- ${c}`),
    'DIFF:',
    input.diff,
    'Return JSON: { approved: boolean, blocking: string[], notes: string[] }.',
  ].join('\n')
}
