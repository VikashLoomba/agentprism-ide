import fs from 'node:fs/promises'
import path from 'node:path'
import { CAPABILITY_DIRS } from '../config.ts'

export interface CapabilityFileInfo {
  /** Bare capability name (file basename without extension). */
  name: string
  /** Absolute path to the resolved file. */
  path: string
  /** Which tier this file resolved from. */
  tier: 'project' | 'user'
  modifiedAt: number
}

const CAPABILITY_EXTS = ['.ts', '.js', '.mjs']

/** Guard against traversal / odd filenames — mirrors `safeName` in workflows.ts. */
function isSafeFileName(name: string): boolean {
  if (path.basename(name) !== name) return false
  return /^[\w.\- ]+$/.test(name)
}

/** Bare name = filename with a recognized capability extension stripped. */
function bareNameOf(fileName: string): string {
  const ext = path.extname(fileName)
  return CAPABILITY_EXTS.includes(ext) ? fileName.slice(0, -ext.length) : fileName
}

/**
 * Cheap, safe filesystem scan of capability/tool modules across all tiers.
 * Does NOT `import()` anything — purely stats files. Mirrors `listWorkflows`.
 *
 * - mkdir -p each tier dir (so first run never fails),
 * - readdir for *.ts / *.js / *.mjs,
 * - safeName-style guard + realpath containment check,
 * - dedupe by bareName, project tier wins (project shadows user).
 */
export async function scanCapabilityFiles(): Promise<CapabilityFileInfo[]> {
  const byBareName = new Map<string, CapabilityFileInfo>()

  for (const { dir, tier } of CAPABILITY_DIRS) {
    await fs.mkdir(dir, { recursive: true })

    // Resolve the tier root once for containment comparison.
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
      if (!isSafeFileName(fileName)) continue
      if (!CAPABILITY_EXTS.includes(path.extname(fileName))) continue

      const full = path.join(dir, fileName)

      // realpath containment: the resolved target must stay inside the tier dir.
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
      // Project tier is scanned first; once a bareName is claimed it wins.
      if (byBareName.has(name)) continue
      byBareName.set(name, { name, path: full, tier, modifiedAt: st.mtimeMs })
    }
  }

  return [...byBareName.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

/**
 * Read one tool/capability file by its FULL filename (incl. extension), guarded
 * against traversal + containment. Powers the editor "open tool" flow (mirrors
 * readPrompt in store/prompts.ts; capability extensions vary, so the caller passes
 * the basename with its extension).
 */
export async function readCapabilityFile(
  tierDir: string,
  fileName: string,
): Promise<{ path: string; content: string }> {
  if (!isSafeFileName(fileName) || !CAPABILITY_EXTS.includes(path.extname(fileName))) {
    throw new Error('Invalid tool file name (.ts/.js/.mjs only).')
  }
  const full = path.join(tierDir, fileName)
  const real = await fs.realpath(full)
  const rel = path.relative(await fs.realpath(tierDir), real)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes tools dir.')
  return { path: full, content: await fs.readFile(real, 'utf8') }
}

/** Write one tool/capability file by full filename (safeName-guarded). */
export async function writeCapabilityFile(
  tierDir: string,
  fileName: string,
  content: string,
): Promise<CapabilityFileInfo> {
  if (!isSafeFileName(fileName) || !CAPABILITY_EXTS.includes(path.extname(fileName))) {
    throw new Error('Invalid tool file name (.ts/.js/.mjs only).')
  }
  await fs.mkdir(tierDir, { recursive: true })
  const full = path.join(tierDir, fileName)
  await fs.writeFile(full, content, 'utf8')
  const st = await fs.stat(full)
  return { name: bareNameOf(fileName), path: full, tier: 'project', modifiedAt: st.mtimeMs }
}
