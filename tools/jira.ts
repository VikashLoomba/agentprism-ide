// tools/jira.ts
import { defineCapability } from 'agentprism/capability'

export default defineCapability({
  name: 'jira',
  secrets: ['JIRA_TOKEN', 'JIRA_BASE_URL'],
  effects: {
    async getTicket(ctx, args: { key: string }) {
      const base = ctx.secrets.JIRA_BASE_URL
      if (!base) { ctx.log('JIRA_BASE_URL missing'); return null }
      const res = await fetch(`${base}/rest/api/3/issue/${args.key}`, {
        headers: { Authorization: `Bearer ${ctx.secrets.JIRA_TOKEN ?? ''}` },
      })
      if (!res.ok) { ctx.log(`jira ${res.status}`); return null }
      const j = await res.json() as { fields?: { description?: string; customfield_ac?: string[] } }
      return { key: args.key, acceptanceCriteria: j.fields?.customfield_ac ?? [] }
    },
  },
})
