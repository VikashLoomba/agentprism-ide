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

/** Project-local capability/tool modules ("Tools" tier). */
export const PROJECT_TOOLS_DIR =
  process.env.AGENTPRISM_TOOLS_DIR ?? path.join(process.cwd(), 'tools')

/** User-level capability/tool modules ("Shared tools" tier). */
export const USER_TOOLS_DIR = path.join(HOME, '.agentprism', 'tools')

/** Ordered capability search dirs — project shadows user (project first). */
export const CAPABILITY_DIRS: { dir: string; tier: 'project' | 'user' }[] = [
  { dir: PROJECT_TOOLS_DIR, tier: 'project' },
  { dir: USER_TOOLS_DIR, tier: 'user' },
]

/** Project-local prompt-template (.hbs) dir ("Prompts" tier). */
export const PROJECT_PROMPTS_DIR =
  process.env.AGENTPRISM_PROMPTS_DIR ?? path.join(process.cwd(), 'prompts')

/** User-level prompt-template (.hbs) dir ("Shared prompts" tier). */
export const USER_PROMPTS_DIR = path.join(HOME, '.agentprism', 'prompts')

/** Ordered prompt-template search dirs — project shadows user (project first). */
export const PROMPT_DIRS: { dir: string; tier: 'project' | 'user' }[] = [
  { dir: PROJECT_PROMPTS_DIR, tier: 'project' },
  { dir: USER_PROMPTS_DIR, tier: 'user' },
]
