import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

export const PORT = Number(process.env.PORT ?? 8787)

/**
 * The installed package root (where `node_modules/` and the built `dist/` live),
 * as distinct from the user's working directory. Derived by walking up from this
 * module's directory to the nearest `package.json` — robust to the differing
 * layouts of tsx-run (`server/config.ts` → `../`) vs. the compiled lib
 * (`dist-lib/server/config.js` → `../../`). A fixed offset would break one mode.
 */
function findPackageRoot(start: string): string {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

export const PACKAGE_ROOT = findPackageRoot(import.meta.dirname)

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

/**
 * Resolve the absolute path to an agent's local binary inside the package's
 * `node_modules/.bin`, or `undefined` when the agent has no mapped bin. Uses
 * {@link PACKAGE_ROOT} (the installed package) — NOT the user's cwd — so a
 * `npx agentprism-ide` launched from an arbitrary directory still finds the
 * bundled agents. Existence is the caller's concern (spawn falls back to npx).
 */
export function resolveAgentBin(agentId: string): string | undefined {
  const bin = AGENT_BINS[agentId]
  if (!bin) return undefined
  return path.join(PACKAGE_ROOT, 'node_modules', '.bin', bin)
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
