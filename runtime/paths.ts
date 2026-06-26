// runtime/paths.ts
//
// Path/anchor resolution owned by the runtime tier. This holds the process-global
// install anchor (PACKAGE_ROOT) and the user-tier dirs (~/.agentprism), plus the
// pure per-workspace dir derivation (deriveWorkspaceDirs). It NEVER reads
// process.cwd() for resolution — every workspace path derives from an explicit
// `root` passed by the composition root.
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

/**
 * The installed package root (where `node_modules/` and the built `dist/` live),
 * as distinct from the user's working directory. Derived by walking up from this
 * module's directory to the nearest `package.json` — robust to the differing
 * layouts of tsx-run (`runtime/paths.ts` → `../`) vs. the compiled lib
 * (`dist-lib/runtime/paths.js` → `../../`). A fixed offset would break one mode.
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

/** User-level capability/tool modules ("Shared tools" tier). */
export const USER_TOOLS_DIR = path.join(HOME, '.agentprism', 'tools')

/** User-level prompt-template (.hbs) dir ("Shared prompts" tier). */
export const USER_PROMPTS_DIR = path.join(HOME, '.agentprism', 'prompts')

export interface DerivedDirs {
  root: string
  tools: string
  prompts: string
  workflows: string
  nodeModules: string
}

/**
 * Derive a workspace's conventional subdirs from its root. AGENTPRISM_*_DIR
 * overrides are honored ONLY when useEnvOverrides is true (the default workspace,
 * back-compat). Pure: reads `opts.env` (process.env by default) but NEVER
 * process.cwd().
 */
export function deriveWorkspaceDirs(
  root: string,
  opts: { env?: NodeJS.ProcessEnv; useEnvOverrides?: boolean } = {},
): DerivedDirs {
  const env = opts.env ?? process.env
  const o = opts.useEnvOverrides === true
  return {
    root,
    tools: o && env.AGENTPRISM_TOOLS_DIR ? env.AGENTPRISM_TOOLS_DIR : path.join(root, 'tools'),
    prompts: o && env.AGENTPRISM_PROMPTS_DIR ? env.AGENTPRISM_PROMPTS_DIR : path.join(root, 'prompts'),
    workflows: o && env.AGENTPRISM_WORKFLOWS_DIR ? env.AGENTPRISM_WORKFLOWS_DIR : path.join(root, 'workflows'),
    nodeModules: path.join(root, 'node_modules'),
  }
}
