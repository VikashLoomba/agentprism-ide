import fs from 'node:fs/promises'
import path from 'node:path'

export interface PromptFileInfo {
  /** Bare name (filename minus .hbs); GUARANTEED a JS identifier. */
  name: string
  /** Absolute path to the resolved file. */
  path: string
  /** Which tier this file resolved from. */
  tier: 'project' | 'user'
  modifiedAt: number
  /** Full .hbs source (frontmatter NOT yet stripped). */
  body: string
}

const PROMPT_EXTS = ['.hbs']

/**
 * Traversal guard PLUS identifier guard. Unlike isSafeFileName in store/capabilities.ts
 * (which allows '-', ' ', '.'), the prompt bareName MUST be a valid JS identifier so
 * name == injected key == dts member == partial name with NO transform (Option A).
 */
function isSafePromptFileName(name: string): boolean {
  if (path.basename(name) !== name) return false
  const ext = path.extname(name)
  if (!PROMPT_EXTS.includes(ext)) return false
  const bare = name.slice(0, -ext.length)
  return /^[A-Za-z_$][\w$]*$/.test(bare)
}

/** Bare name = filename with the .hbs extension stripped. */
function bareNameOf(fileName: string): string {
  const ext = path.extname(fileName)
  return PROMPT_EXTS.includes(ext) ? fileName.slice(0, -ext.length) : fileName
}

/**
 * Two-tier scan over PROMPT_DIRS, project shadows user. Reads bodies (cheap text).
 *
 * - mkdir -p each tier dir (so first run never fails),
 * - readdir for *.hbs,
 * - identifier-style guard + realpath containment check,
 * - dedupe by bareName, project tier wins (project shadows user).
 */
export async function scanPromptFiles(
  promptDirs: readonly { dir: string; tier: 'project' | 'user' }[],
): Promise<PromptFileInfo[]> {
  const byBareName = new Map<string, PromptFileInfo>()
  for (const { dir, tier } of promptDirs) {
    await fs.mkdir(dir, { recursive: true })
    let dirReal: string
    try {
      dirReal = await fs.realpath(dir)
    } catch {
      continue
    }
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const fileName = entry.name
      if (!isSafePromptFileName(fileName)) continue
      const full = path.join(dir, fileName)
      let real: string
      let st
      try {
        real = await fs.realpath(full)
        st = await fs.stat(real)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      const rel = path.relative(dirReal, real)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      const name = bareNameOf(fileName)
      if (byBareName.has(name)) continue // project scanned first → wins
      const body = await fs.readFile(real, 'utf8')
      byBareName.set(name, { name, path: full, tier, modifiedAt: st.mtimeMs, body })
    }
  }
  return [...byBareName.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/** Single-file read for the editor "open prompt" flow (safeName + .hbs guard). */
export async function readPrompt(
  tierDir: string,
  name: string,
): Promise<{ path: string; content: string }> {
  const fileName = name.endsWith('.hbs') ? name : `${name}.hbs`
  if (!isSafePromptFileName(fileName)) throw new Error('Invalid prompt name (identifier + .hbs only).')
  const full = path.join(tierDir, fileName)
  const real = await fs.realpath(full)
  const rel = path.relative(await fs.realpath(tierDir), real)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes prompts dir.')
  return { path: full, content: await fs.readFile(real, 'utf8') }
}

export async function writePrompt(
  tierDir: string,
  name: string,
  content: string,
  tier: 'project' | 'user',
): Promise<PromptFileInfo> {
  const fileName = name.endsWith('.hbs') ? name : `${name}.hbs`
  if (!isSafePromptFileName(fileName)) throw new Error('Invalid prompt name (identifier + .hbs only).')
  await fs.mkdir(tierDir, { recursive: true })
  const full = path.join(tierDir, fileName)
  await fs.writeFile(full, content, 'utf8')
  const st = await fs.stat(full)
  return { name: bareNameOf(fileName), path: full, tier, modifiedAt: st.mtimeMs, body: content }
}
