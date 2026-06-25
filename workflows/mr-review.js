export const meta = {
  name: 'mr-review',
  description: 'Review a GitLab MR against Jira acceptance criteria with one agent pass.',
  capabilities: ['jira', 'gitlab', 'git'],
}
import { buildReviewPrompt } from '../tools/mr-prompt.ts'

phase('Gather context')
const ticket = await jira.getTicket({ key: args.jiraKey })
const comments = await gitlab.getMrComments({ project: args.project, mr: args.mr })
const diff = await gitlab.getMrDiff({ project: args.project, mr: args.mr })
const { worktree } = await git.checkoutWorktree({ repo: args.repo, ref: args.ref })

phase('Review')
const prompt = buildReviewPrompt({
  acceptanceCriteria: ticket?.acceptanceCriteria ?? [],
  comments: comments ?? [],
  diff: diff ?? '',
})
const review = await agent(prompt, {
  cwd: worktree,
  schema: { type: 'object', properties: {
    approved: { type: 'boolean' },
    blocking: { type: 'array', items: { type: 'string' } },
    notes:    { type: 'array', items: { type: 'string' } },
  }, required: ['approved', 'blocking', 'notes'] },
})

phase('Write result')
return review
