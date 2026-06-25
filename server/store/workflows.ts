import fs from 'node:fs/promises'
import path from 'node:path'
import { WORKFLOWS_DIR } from '../config.ts'
import type { WorkflowFileInfo } from '../../shared/protocol.ts'

function safeName(name: string): string {
  const base = path.basename(name.trim())
  if (!base || !/^[\w.\- ]+$/.test(base)) {
    throw new Error('Invalid workflow name (use letters, numbers, spaces, dots, dashes).')
  }
  return base.endsWith('.js') ? base : `${base}.js`
}

export async function ensureDir(): Promise<void> {
  await fs.mkdir(WORKFLOWS_DIR, { recursive: true })
}

export async function listWorkflows(): Promise<WorkflowFileInfo[]> {
  await ensureDir()
  const entries = await fs.readdir(WORKFLOWS_DIR, { withFileTypes: true })
  const out: WorkflowFileInfo[] = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      const full = path.join(WORKFLOWS_DIR, entry.name)
      const st = await fs.stat(full)
      out.push({ name: entry.name, path: full, size: st.size, modifiedAt: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function readWorkflow(name: string): Promise<string> {
  const full = path.join(WORKFLOWS_DIR, safeName(name))
  return fs.readFile(full, 'utf8')
}

export async function writeWorkflow(name: string, content: string): Promise<WorkflowFileInfo> {
  await ensureDir()
  const fileName = safeName(name)
  const full = path.join(WORKFLOWS_DIR, fileName)
  await fs.writeFile(full, content, 'utf8')
  const st = await fs.stat(full)
  return { name: fileName, path: full, size: st.size, modifiedAt: st.mtimeMs }
}

export async function deleteWorkflow(name: string): Promise<void> {
  const full = path.join(WORKFLOWS_DIR, safeName(name))
  await fs.rm(full, { force: true })
}
