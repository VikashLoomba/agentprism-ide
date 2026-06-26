import fs from 'node:fs/promises'
import path from 'node:path'
import type { WorkflowFileInfo } from '../../shared/protocol.ts'

function safeName(name: string): string {
  const base = path.basename(name.trim())
  if (!base || !/^[\w.\- ]+$/.test(base)) {
    throw new Error('Invalid workflow name (use letters, numbers, spaces, dots, dashes).')
  }
  return base.endsWith('.js') ? base : `${base}.js`
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function listWorkflows(dir: string): Promise<WorkflowFileInfo[]> {
  await ensureDir(dir)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: WorkflowFileInfo[] = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      const full = path.join(dir, entry.name)
      const st = await fs.stat(full)
      out.push({ name: entry.name, path: full, size: st.size, modifiedAt: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function readWorkflow(dir: string, name: string): Promise<string> {
  const full = path.join(dir, safeName(name))
  return fs.readFile(full, 'utf8')
}

export async function writeWorkflow(dir: string, name: string, content: string): Promise<WorkflowFileInfo> {
  await ensureDir(dir)
  const fileName = safeName(name)
  const full = path.join(dir, fileName)
  await fs.writeFile(full, content, 'utf8')
  const st = await fs.stat(full)
  return { name: fileName, path: full, size: st.size, modifiedAt: st.mtimeMs }
}

export async function deleteWorkflow(dir: string, name: string): Promise<void> {
  const full = path.join(dir, safeName(name))
  await fs.rm(full, { force: true })
}
