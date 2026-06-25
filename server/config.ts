import path from 'node:path'
import os from 'node:os'

export const PORT = Number(process.env.PORT ?? 8787)

/** Where workflow .js files are saved/loaded. */
export const WORKFLOWS_DIR =
  process.env.AGENTPRISM_WORKFLOWS_DIR ?? path.join(process.cwd(), 'workflows')

/** Default working directory agents operate in for a new run. */
export const DEFAULT_CWD = process.env.AGENTPRISM_DEFAULT_CWD ?? process.cwd()

/** Local agent binaries (preferred over npx when installed). */
export const AGENT_BINS: Record<string, string> = {
  claude: 'claude-agent-acp',
  codex: 'codex-acp',
}

export const HOME = os.homedir()
