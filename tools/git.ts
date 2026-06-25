// tools/git.ts
import { defineCapability } from '../shared/capability.ts'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export default defineCapability({
  name: 'git',
  secrets: [],
  effects: {
    async checkoutWorktree(ctx, args: { repo: string; ref: string }) {
      const base = await mkdtemp(join(tmpdir(), 'agentprism-wt-'))
      const worktree = join(base, 'wt')
      try {
        await run('git', ['-C', args.repo, 'worktree', 'add', '--detach', worktree, args.ref])
      } catch (err) {
        ctx.log(`git worktree add failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
      return { worktree }
    },
  },
})
