// tools/gitlab.ts
import { defineCapability } from '../shared/capability.ts'

export default defineCapability({
  name: 'gitlab',
  secrets: ['GITLAB_TOKEN', 'GITLAB_BASE_URL'],
  effects: {
    async getMrComments(ctx, args: { project: string; mr: number }) {
      const base = ctx.secrets.GITLAB_BASE_URL
      if (!base) { ctx.log('GITLAB_BASE_URL missing'); return null }
      const project = encodeURIComponent(String(args.project))
      const res = await fetch(`${base}/api/v4/projects/${project}/merge_requests/${args.mr}/notes`, {
        headers: { 'PRIVATE-TOKEN': ctx.secrets.GITLAB_TOKEN ?? '' },
      })
      if (!res.ok) { ctx.log(`gitlab ${res.status}`); return null }
      const notes = await res.json() as { body?: string; system?: boolean }[]
      return notes
        .filter(n => !n.system)
        .map(n => n.body ?? '')
    },
    async getMrDiff(ctx, args: { project: string; mr: number }) {
      const base = ctx.secrets.GITLAB_BASE_URL
      if (!base) { ctx.log('GITLAB_BASE_URL missing'); return null }
      const project = encodeURIComponent(String(args.project))
      const res = await fetch(`${base}/api/v4/projects/${project}/merge_requests/${args.mr}/changes`, {
        headers: { 'PRIVATE-TOKEN': ctx.secrets.GITLAB_TOKEN ?? '' },
      })
      if (!res.ok) { ctx.log(`gitlab ${res.status}`); return null }
      const j = await res.json() as { changes?: { old_path?: string; new_path?: string; diff?: string }[] }
      return (j.changes ?? [])
        .map(c => `--- ${c.old_path ?? ''}\n+++ ${c.new_path ?? ''}\n${c.diff ?? ''}`)
        .join('\n')
    },
  },
})
