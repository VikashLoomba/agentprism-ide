import { parse } from 'acorn'
import type { WorkflowMeta } from '@shared/dsl'

/** Render a WorkflowMeta back into a `export const meta = {...}` literal. */
export function metaToCode(meta: WorkflowMeta): string {
  const lines: string[] = ['export const meta = {']
  lines.push(`  name: ${JSON.stringify(meta.name)},`)
  lines.push(`  description: ${JSON.stringify(meta.description)},`)
  if (meta.model) lines.push(`  model: ${JSON.stringify(meta.model)},`)
  if (meta.phases && meta.phases.length) {
    const items = meta.phases.map((p) => {
      const parts = [`title: ${JSON.stringify(p.title)}`]
      if (p.detail) parts.push(`detail: ${JSON.stringify(p.detail)}`)
      if (p.model) parts.push(`model: ${JSON.stringify(p.model)}`)
      return `{ ${parts.join(', ')} }`
    })
    lines.push(`  phases: [${items.join(', ')}],`)
  }
  lines.push('}')
  return lines.join('\n')
}

/** Replace the leading meta export in `source` with a regenerated literal. */
export function replaceMeta(source: string, meta: WorkflowMeta): string | null {
  try {
    const ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as { body: Array<{ type: string; start: number; end: number }> }
    const first = ast.body[0]
    if (!first || first.type !== 'ExportNamedDeclaration') return null
    return source.slice(0, first.start) + metaToCode(meta) + source.slice(first.end)
  } catch {
    return null
  }
}
