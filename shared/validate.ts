/**
 * Workflow script validation — a faithful port of the pi-dynamic-workflows
 * parser contract, runnable in both the browser (Monaco diagnostics) and the
 * Node executor.
 *
 *  1. Strip markdown fences.
 *  2. Reject non-deterministic primitives (Date.now / Math.random / new Date()).
 *  3. Parse as an ES module with acorn.
 *  4. Require `export const meta = <literal>` as the first statement.
 *  5. Statically evaluate the meta literal and validate its fields.
 *  6. Collect agent()/phase() call sites (for breakpoints + an "agent()
 *     required" hint).
 */
import { parse } from 'acorn'
import type { Node } from 'acorn'
import { DETERMINISM_BLOCKLIST } from './dsl.ts'
import type { WorkflowMeta } from './dsl.ts'
import { ACP_AGENTS } from './agents.ts'
import type { AcpAgentId } from './agents.ts'
import { AGENT_PRODUCER_NAMES, DSL_METHOD_MAP, validateMethodConfig } from './dsl-registry.ts'
import { resolveCapability } from './capability-resolve.ts'
import type { CapabilityCatalog } from './capability-resolve.ts'

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  message: string
  severity: DiagnosticSeverity
  /** 1-based. */
  startLine: number
  /** 1-based. */
  startColumn: number
  endLine: number
  endColumn: number
}

export interface ValidateResult {
  ok: boolean
  meta?: WorkflowMeta
  diagnostics: Diagnostic[]
  /** 1-based lines containing an agent() call. */
  agentCallLines: number[]
  /** 1-based lines containing a phase() call. */
  phaseCallLines: number[]
  /** Character offset in the (normalized) source where the body begins. */
  bodyStart: number
  /** The normalized source (fences stripped). */
  normalized: string
}

interface AcornLoc {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

function locOf(node: Node): Diagnostic | null {
  const loc = (node as unknown as { loc?: AcornLoc }).loc
  if (!loc) return null
  return {
    message: '',
    severity: 'error',
    startLine: loc.start.line,
    startColumn: loc.start.column + 1,
    endLine: loc.end.line,
    endColumn: loc.end.column + 1,
  }
}

function diagAt(node: Node, message: string, severity: DiagnosticSeverity = 'error'): Diagnostic {
  const base = locOf(node)
  if (base) return { ...base, message, severity }
  return { message, severity, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }
}

/** Strip a single wrapping ```lang ... ``` markdown fence, like pi does. */
export function normalizeScript(source: string): string {
  const trimmed = source.trim()
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/
  const m = trimmed.match(fence)
  return m ? m[1] : source
}

class LiteralError extends Error {
  node: Node
  constructor(message: string, node: Node) {
    super(message)
    this.node = node
  }
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Statically evaluate an allowed literal AST node (pi's evaluateLiteral). */
function evaluateLiteral(node: Node): unknown {
  switch (node.type) {
    case 'Literal':
      return (node as unknown as { value: unknown }).value
    case 'TemplateLiteral': {
      const tl = node as unknown as { expressions: Node[]; quasis: Array<{ value: { cooked: string } }> }
      if (tl.expressions.length > 0) {
        throw new LiteralError('meta must be a literal: template interpolation is not allowed', node)
      }
      return tl.quasis.map((q) => q.value.cooked).join('')
    }
    case 'UnaryExpression': {
      const ue = node as unknown as { operator: string; argument: Node }
      const arg = ue.argument as unknown as { type: string; value: unknown }
      if ((ue.operator === '-' || ue.operator === '+') && arg.type === 'Literal' && typeof arg.value === 'number') {
        return ue.operator === '-' ? -arg.value : arg.value
      }
      throw new LiteralError('meta must be a literal: only negative numeric literals are allowed', node)
    }
    case 'ArrayExpression': {
      const ae = node as unknown as { elements: Array<Node | null> }
      return ae.elements.map((el) => {
        if (el === null) throw new LiteralError('meta must be a literal: sparse arrays are not allowed', node)
        return evaluateLiteral(el)
      })
    }
    case 'ObjectExpression': {
      const oe = node as unknown as { properties: Node[] }
      const out: Record<string, unknown> = {}
      for (const prop of oe.properties) {
        const p = prop as unknown as {
          type: string
          computed: boolean
          kind: string
          method: boolean
          key: { type: string; name?: string; value?: unknown }
          value: Node
        }
        if (p.type === 'SpreadElement') {
          throw new LiteralError('meta must be a literal: spread is not allowed', prop)
        }
        if (p.computed) throw new LiteralError('meta must be a literal: computed keys are not allowed', prop)
        if (p.kind !== 'init' || p.method) {
          throw new LiteralError('meta must be a literal: getters/setters/methods are not allowed', prop)
        }
        const key = p.key.type === 'Identifier' ? p.key.name! : String(p.key.value)
        if (RESERVED_KEYS.has(key)) {
          throw new LiteralError(`meta must be a literal: reserved key "${key}" is not allowed`, prop)
        }
        out[key] = evaluateLiteral(p.value)
      }
      return out
    }
    default:
      throw new LiteralError(`meta must be a literal: unsupported node type "${node.type}"`, node)
  }
}

/** Validate the extracted meta object; returns field-level error messages. */
function validateMeta(meta: unknown): string[] {
  const errors: string[] = []
  if (typeof meta !== 'object' || meta === null) {
    return ['meta must be an object literal']
  }
  const m = meta as Record<string, unknown>
  if (typeof m.name !== 'string' || m.name.trim() === '') {
    errors.push('meta.name must be a non-empty string')
  }
  if (typeof m.description !== 'string' || m.description.trim() === '') {
    errors.push('meta.description must be a non-empty string')
  }
  if (m.model !== undefined && typeof m.model !== 'string') {
    errors.push('meta.model must be a string')
  }
  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases)) {
      errors.push('meta.phases must be an array')
    } else {
      for (const phase of m.phases) {
        if (typeof phase !== 'object' || phase === null || typeof (phase as Record<string, unknown>).title !== 'string') {
          errors.push('each meta phase must have a title string')
          break
        }
      }
    }
  }
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      errors.push('meta.capabilities must be an array of strings')
    } else {
      for (const cap of m.capabilities) {
        if (typeof cap !== 'string' || cap.trim() === '') {
          errors.push('each meta.capabilities entry must be a non-empty string')
          break
        }
      }
    }
  }
  if (m.config !== undefined) {
    if (typeof m.config !== 'object' || m.config === null || Array.isArray(m.config)) {
      errors.push('meta.config must be an object keyed by method name (e.g. { verify: { reviewers: 3 } })')
    } else {
      for (const [method, value] of Object.entries(m.config as Record<string, unknown>)) {
        const msg = validateMethodConfig(method, value)
        if (msg) errors.push(`meta.config.${method}: ${msg}`)
      }
    }
  }
  return errors
}

function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
  let line = 1
  let last = 0
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++
      last = i + 1
    }
  }
  return { line, column: offset - last + 1 }
}

export function validateWorkflow(
  rawSource: string,
  selectedAgentId?: AcpAgentId,
  connectedAgentIds?: AcpAgentId[],
  capabilityCatalog?: CapabilityCatalog,
): ValidateResult {
  const normalized = normalizeScript(rawSource)
  const diagnostics: Diagnostic[] = []
  const agentCallLines = new Set<number>()
  const phaseCallLines = new Set<number>()

  // 1. Determinism blocklist (matches pi's pre-parse check).
  const detMatch = normalized.match(DETERMINISM_BLOCKLIST)
  if (detMatch && detMatch.index !== undefined) {
    const { line, column } = offsetToLineCol(normalized, detMatch.index)
    diagnostics.push({
      message:
        'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (pass timestamps/randomness via args).',
      severity: 'error',
      startLine: line,
      startColumn: column,
      endLine: line,
      endColumn: column + detMatch[0].length,
    })
  }

  // 2. Parse.
  let ast: Node
  try {
    ast = parse(normalized, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as unknown as Node
  } catch (err) {
    const e = err as { message?: string; loc?: { line: number; column: number }; pos?: number }
    const line = e.loc?.line ?? 1
    const column = (e.loc?.column ?? 0) + 1
    diagnostics.push({
      message: (e.message ?? 'Syntax error').replace(/\s*\(\d+:\d+\)$/, ''),
      severity: 'error',
      startLine: line,
      startColumn: column,
      endLine: line,
      endColumn: column + 1,
    })
    return { ok: false, diagnostics, agentCallLines: [], phaseCallLines: [], bodyStart: 0, normalized }
  }

  const body = (ast as unknown as { body: Node[] }).body
  let meta: WorkflowMeta | undefined
  let bodyStart = 0

  // 3. First statement must be `export const meta = <literal>`.
  const first = body[0] as unknown as {
    type: string
    start: number
    end: number
    declaration?: {
      type: string
      kind: string
      declarations: Array<{ id: { type: string; name?: string }; init?: Node }>
    }
  }
  if (!first || first.type !== 'ExportNamedDeclaration') {
    diagnostics.push(diagAt(body[0] ?? (ast as Node), 'The first statement must be: export const meta = { name, description, phases? }'))
  } else if (
    !first.declaration ||
    first.declaration.type !== 'VariableDeclaration' ||
    first.declaration.kind !== 'const' ||
    first.declaration.declarations.length !== 1 ||
    first.declaration.declarations[0].id.type !== 'Identifier' ||
    first.declaration.declarations[0].id.name !== 'meta'
  ) {
    diagnostics.push(diagAt(body[0] as Node, 'The meta export must be `export const meta = { ... }`.'))
  } else {
    const init = first.declaration.declarations[0].init
    if (!init) {
      diagnostics.push(diagAt(body[0] as Node, 'meta must be assigned an object literal.'))
    } else {
      try {
        const value = evaluateLiteral(init)
        const metaErrors = validateMeta(value)
        if (metaErrors.length > 0) {
          for (const message of metaErrors) diagnostics.push(diagAt(init, message))
        } else {
          meta = value as WorkflowMeta
          // Resolve declared capabilities against the (optional) threaded
          // catalog. Done here, not in validateMeta, because it needs the AST
          // element locations and the catalog. Skipped entirely when no catalog
          // is supplied (graceful degradation).
          if (capabilityCatalog) {
            const metaObj = init as unknown as { type: string; properties?: Node[] }
            if (metaObj.type === 'ObjectExpression' && Array.isArray(metaObj.properties)) {
              for (const prop of metaObj.properties) {
                const p = prop as unknown as {
                  type: string
                  key?: { type: string; name?: string; value?: unknown }
                  value?: Node & { type?: string; elements?: Array<Node | null> }
                }
                if (p.type !== 'Property' || !p.key) continue
                const keyName =
                  p.key.type === 'Identifier'
                    ? p.key.name
                    : p.key.type === 'Literal' && typeof p.key.value === 'string'
                      ? p.key.value
                      : null
                if (keyName !== 'capabilities') continue
                if (!p.value || p.value.type !== 'ArrayExpression' || !Array.isArray(p.value.elements)) continue
                for (const el of p.value.elements) {
                  if (!el) continue
                  const elNode = el as unknown as { type: string; value?: unknown }
                  if (elNode.type !== 'Literal' || typeof elNode.value !== 'string') continue
                  const res = resolveCapability(capabilityCatalog, elNode.value)
                  if (res.resolved === null) {
                    diagnostics.push(diagAt(el, `capability "${res.bareName}" does not resolve`, 'error'))
                  } else if (res.shadowsUser) {
                    diagnostics.push(
                      diagAt(el, `${res.bareName} -> ./tools, shadowing Shared tools`, 'info'),
                    )
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof LiteralError) diagnostics.push(diagAt(err.node, err.message))
        else diagnostics.push(diagAt(init, 'meta must be a static object literal.'))
      }
    }
    bodyStart = first.end
  }

  // Inspect the agent() opts object (arguments[1]) for the removed `tier`
  // option, a non-connected `agent` backend selector, and config keys/values
  // that don't match the effective agent's catalog. The effective agent is the
  // per-call `agent` literal (a backend selector, distinct from Claude's
  // `config.agent` persona option) when present, else the run default
  // (selectedAgentId). All findings are warnings and never flip `ok` to false.
  const inspectAgentOptions = (opts: Node | null | undefined): void => {
    if (!opts) return
    const o = opts as unknown as { type: string; properties?: Node[] }
    if (o.type !== 'ObjectExpression' || !Array.isArray(o.properties)) return

    type PropNode = {
      type: string
      key?: { type: string; name?: string; value?: unknown }
      value?: Node & { type?: string; value?: unknown; properties?: Node[] }
    }
    const keyOf = (p: PropNode): string | null => {
      if (!p.key) return null
      if (p.key.type === 'Identifier') return p.key.name ?? null
      if (p.key.type === 'Literal' && typeof p.key.value === 'string') return p.key.value
      return null
    }

    // Resolve the per-call effective backend from the literal `agent` prop.
    let effectiveAgent: AcpAgentId | undefined = selectedAgentId
    const agentProp = o.properties.find((prop) => keyOf(prop as unknown as PropNode) === 'agent')
    if (agentProp) {
      const ap = agentProp as unknown as PropNode
      const av = ap.value as { type?: string; value?: unknown } | undefined
      if (av && av.type === 'Literal' && typeof av.value === 'string') {
        if (av.value in ACP_AGENTS) {
          effectiveAgent = av.value as AcpAgentId
          if (connectedAgentIds && !connectedAgentIds.includes(effectiveAgent)) {
            diagnostics.push(
              diagAt(agentProp, `agent: "${av.value}" is not currently connected`, 'warning'),
            )
          }
        } else {
          diagnostics.push(
            diagAt(agentProp, `agent: "${av.value}" is not a connected agent`, 'warning'),
          )
        }
      }
    }

    for (const prop of o.properties) {
      const p = prop as unknown as PropNode
      if (p.type !== 'Property') continue
      const key = keyOf(p)
      if (key === 'tier') {
        diagnostics.push(
          diagAt(prop, "agent: 'tier' is removed — use config: { model, effort }", 'warning'),
        )
        continue
      }
      if (key !== 'config' || !p.value || p.value.type !== 'ObjectExpression') continue
      const catalog = effectiveAgent ? ACP_AGENTS[effectiveAgent]?.configCatalog : undefined
      if (!catalog) continue
      const configProps = (p.value.properties ?? []) as Node[]
      for (const cprop of configProps) {
        const cp = cprop as unknown as PropNode
        if (cp.type !== 'Property') continue
        const ckey = keyOf(cp)
        if (ckey === null) continue
        const cval = cp.value as { type?: string; value?: unknown } | undefined
        if (!cval || cval.type !== 'Literal') continue
        const entry = catalog.find((c) => c.id === ckey)
        if (!entry) {
          diagnostics.push(
            diagAt(cprop, `agent.config.${ckey}: unknown option for ${effectiveAgent}`, 'warning'),
          )
          continue
        }
        if (
          entry.type === 'select' &&
          !entry.open &&
          !entry.conditional &&
          typeof cval.value === 'string' &&
          !(entry.values ?? []).some((v) => v.value === cval.value)
        ) {
          diagnostics.push(
            diagAt(
              cprop,
              `agent.config.${ckey}: "${cval.value}" is not a known value for ${effectiveAgent}`,
              'warning',
            ),
          )
        }
      }
    }
  }

  // 4. Walk for call sites.
  let sawAgentProducer = false
  const visit = (node: Node | null | undefined): void => {
    if (!node || typeof node !== 'object') return
    const n = node as unknown as {
      type: string
      callee?: { type: string; name?: string }
      arguments?: Node[]
      loc?: AcornLoc
    }
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier') {
      const name = n.callee.name!
      const line = n.loc?.start.line
      const callSite = DSL_METHOD_MAP.get(name)?.callSite
      if (callSite === 'agent' && line) agentCallLines.add(line)
      if (callSite === 'phase' && line) phaseCallLines.add(line)
      if (AGENT_PRODUCER_NAMES.has(name)) sawAgentProducer = true
      if (name === 'agent') inspectAgentOptions(n.arguments?.[1])
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object') visit(c as Node)
      } else if (child && typeof child === 'object') {
        visit(child as Node)
      }
    }
  }
  visit(ast)

  if (!sawAgentProducer && diagnostics.every((d) => d.severity !== 'error')) {
    diagnostics.push({
      message: 'A workflow should call agent() at least once (directly or via verify/judgePanel/parallel/...).',
      severity: 'warning',
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
    })
  }

  const ok = diagnostics.every((d) => d.severity !== 'error')
  return {
    ok,
    meta,
    diagnostics,
    agentCallLines: [...agentCallLines].sort((a, b) => a - b),
    phaseCallLines: [...phaseCallLines].sort((a, b) => a - b),
    bodyStart,
    normalized,
  }
}
