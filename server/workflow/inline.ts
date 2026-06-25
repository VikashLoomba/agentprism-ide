import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { parse } from 'acorn'
import type { Node } from 'acorn'
import ts from 'typescript'
import { PROJECT_TOOLS_DIR, USER_TOOLS_DIR } from '../config.ts'

/**
 * Pure-helper inlining transform — the esbuild replacement (design §1/§7/§8 C4).
 *
 * The workflow body may `import { x } from '../tools/helper.ts'` a PURE helper
 * module. We must NOT feed the body to a real bundler (esbuild deadlocks on the
 * workflow's top-level `await`, top-level `return`, and `export const meta`).
 * Instead we:
 *
 *   1. acorn-parse the normalized body (script-with-ESM, top-level await/return
 *      allowed) and find each top-level `ImportDeclaration` whose specifier
 *      resolves UNDER a tools/ dir.
 *   2. For each such import, STATICALLY (no `import()`/execution) discriminate the
 *      target: acorn-parse the transpiled target source and REJECT it if it is a
 *      capability (a `defineCapability(...)` default export) or if it imports any
 *      node builtin / bare package. A pure helper is inlined; its OWN imports are
 *      recursively held to the same rule (transitive purity — §8 C4).
 *   3. Blank each inlined import line in the BODY in place with spaces of equal
 *      length, preserving every newline, so body line offsets are unchanged and
 *      the `codeLine - headerLines` stack mapping stays exact.
 *   4. Emit one single-logical-line header binding per helper:
 *        `const { x, y } = (() => { <helper-import-free>; return { x, y }; })();`
 *      All header bindings are concatenated (one per line) and handed to
 *      `instrumentWorkflow`, which counts them into `headerLines`.
 *
 * Discrimination NEVER imports/executes the target (that would run privileged
 * module top-level code in the trusted realm). It is a pure static AST decision.
 */

export interface InlineOptions {
  /**
   * Absolute path of the workflow source file, used to resolve relative import
   * specifiers. When the workflow is an in-memory/unsaved buffer, callers may
   * pass the workflows dir; specifiers that escape the tools/ dirs are ignored
   * (left untouched) rather than inlined.
   */
  workflowPath?: string
}

export interface InlineResult {
  /** The body with inlined-helper import lines blanked in place (newlines kept). */
  source: string
  /** Concatenated single-line header bindings (one helper per line), or ''. */
  headerBindings: string
}

/** Thrown when a tools/ import is a capability, a node builtin, or otherwise un-inlinable. */
export class InlineLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'INLINE_LOAD_ERROR'
  }
}

interface ImportNode extends Node {
  type: 'ImportDeclaration'
  source: { value: string }
  specifiers: Array<{
    type: 'ImportSpecifier' | 'ImportDefaultSpecifier' | 'ImportNamespaceSpecifier'
    local: { name: string }
    imported?: { name?: string }
  }>
}

const TOOLS_DIRS = [PROJECT_TOOLS_DIR, USER_TOOLS_DIR]
/** Candidate extensions when a specifier omits one (mirrors the scan: .ts/.js/.mjs). */
const RESOLVE_EXTS = ['', '.ts', '.js', '.mjs']

function parseModule(source: string): { body: Node[] } {
  return parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as unknown as { body: Node[] }
}

/** True when the specifier is a node: builtin or a bare npm package (no ./ or ../ or /). */
function isBareOrNodeSpecifier(spec: string): boolean {
  if (spec.startsWith('node:')) return true
  if (spec.startsWith('.') || spec.startsWith('/')) return false
  return true // bare package name
}

/**
 * Resolve a relative import specifier against the importer's dir, trying the
 * scan extension set. Returns the canonical real path or null when it does not
 * exist / cannot be resolved. Returns null for bare/node specifiers (handled by
 * the caller's reject path).
 */
function resolveToFile(spec: string, importerDir: string): string | null {
  if (isBareOrNodeSpecifier(spec)) return null
  const base = path.resolve(importerDir, spec)
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext
    try {
      return realpathSync(candidate)
    } catch {
      /* try next extension */
    }
  }
  return null
}

/** Is `file` contained within one of the tools/ dirs (after realpath)? */
function isUnderToolsDir(file: string): boolean {
  for (const dir of TOOLS_DIRS) {
    let realDir: string
    try {
      realDir = realpathSync(dir)
    } catch {
      // Dir may not exist yet; fall back to the configured path for containment.
      realDir = path.resolve(dir)
    }
    const rel = path.relative(realDir, file)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
  }
  return false
}

/** Transpile a tools/ module's raw source to import-preserving, type-free ESM JS. */
function transpileToolModule(rawSource: string, file: string): string {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return rawSource
  const out = ts.transpileModule(rawSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
      isolatedModules: true,
    },
    fileName: file,
  })
  return out.outputText
}

/** Does this parsed module default-export a `defineCapability(...)` call? => capability. */
function hasDefineCapabilityDefault(body: Node[]): boolean {
  for (const node of body) {
    const n = node as unknown as { type: string; declaration?: { type: string; callee?: { type: string; name?: string } } }
    if (n.type !== 'ExportDefaultDeclaration') continue
    const decl = n.declaration
    if (decl && decl.type === 'CallExpression' && decl.callee?.type === 'Identifier' && decl.callee.name === 'defineCapability') {
      return true
    }
  }
  return false
}

/** Collect the exported binding names of a pure-helper module (named exports only). */
function collectExportNames(body: Node[]): string[] {
  const names: string[] = []
  for (const node of body) {
    const n = node as unknown as {
      type: string
      declaration?: { type: string; declarations?: Array<{ id: { type: string; name?: string } }>; id?: { name?: string } }
      specifiers?: Array<{ exported: { name: string } }>
    }
    if (n.type !== 'ExportNamedDeclaration') continue
    if (n.declaration) {
      const d = n.declaration
      if (d.type === 'VariableDeclaration') {
        for (const v of d.declarations ?? []) {
          if (v.id.type === 'Identifier' && v.id.name) names.push(v.id.name)
        }
      } else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id?.name) {
        names.push(d.id.name)
      }
    } else if (n.specifiers) {
      for (const s of n.specifiers) names.push(s.exported.name)
    }
  }
  return names
}

/**
 * Build the import-free body of a pure helper module: every top-level import is
 * recursively validated + inlined (pure helpers only) and the import statements
 * are stripped, leaving runnable JS whose top-level bindings + named exports are
 * captured by the wrapping IIFE. `seen` guards against import cycles.
 */
function buildHelperBody(file: string, seen: Set<string>): { body: string; exports: string[] } {
  if (seen.has(file)) {
    throw new InlineLoadError(`circular pure-helper import detected at ${file}`)
  }
  seen.add(file)

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new InlineLoadError(`cannot read pure-helper module: ${file}`)
  }
  const transpiled = transpileToolModule(raw, file)
  let ast: { body: Node[] }
  try {
    ast = parseModule(transpiled)
  } catch (err) {
    throw new InlineLoadError(`failed to parse tools/ module ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Reject capability modules — they must be host-loaded, never inlined.
  if (hasDefineCapabilityDefault(ast.body)) {
    throw new InlineLoadError(
      `cannot inline "${file}": it is a capability (defineCapability default export). ` +
        `Declare it in meta.capabilities instead of importing it.`,
    )
  }

  const dir = path.dirname(file)
  // Collect this helper's exports BEFORE we strip imports (export decls remain).
  const exports = collectExportNames(ast.body)

  // Walk imports: recurse pure helpers, reject node/bare/capability, blank lines.
  const importNodes = ast.body.filter((n) => (n as unknown as Node).type === 'ImportDeclaration') as unknown as ImportNode[]
  const nestedBindings: string[] = []
  for (const imp of importNodes) {
    const spec = imp.source.value
    if (isBareOrNodeSpecifier(spec)) {
      throw new InlineLoadError(
        `pure helper "${file}" imports "${spec}": pure helpers may import ONLY other pure-helper tools/ files ` +
          `(no node builtins, no npm packages, no capabilities).`,
      )
    }
    const resolved = resolveToFile(spec, dir)
    if (!resolved || !isUnderToolsDir(resolved)) {
      throw new InlineLoadError(
        `pure helper "${file}" imports "${spec}" which does not resolve under tools/; ` +
          `pure helpers may import ONLY other pure-helper tools/ files.`,
      )
    }
    const nested = buildHelperBody(resolved, seen)
    nestedBindings.push(toHeaderBinding(nested.exports, nested.body))
  }

  // Strip the import statements from the transpiled helper, AND blank the leading
  // `export` keyword of every named export (it is illegal inside the wrapping
  // IIFE). Both are blanked in place so the captured top-level bindings keep their
  // identifiers and the IIFE can `return { ...exports }`.
  const spans: Array<[number, number]> = importNodes.map(
    (n) => [(n as unknown as Node).start, (n as unknown as Node).end] as [number, number],
  )
  for (const node of ast.body) {
    const n = node as unknown as { type: string; start: number }
    if (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') {
      // `ExportNamedDeclaration` re-export forms (`export { a } from '...'`) and
      // bare `export { a }` have no inline declaration to keep — those produce no
      // top-level binding and are simply blanked entirely. Declaration forms keep
      // their declaration; only the `export` keyword (6 chars) is blanked.
      const kw = transpiled.slice(n.start, n.start + 6)
      if (kw === 'export') {
        const hasInlineDecl = (node as unknown as { declaration?: unknown }).declaration != null
        if (hasInlineDecl) spans.push([n.start, n.start + 6])
        else spans.push([n.start, (node as unknown as Node).end]) // blank `export { ... }` wholesale
      }
    }
  }
  const body = blankSpans(transpiled, spans)

  seen.delete(file)
  // Nested pure-helper bindings are prepended so the helper body can reference them.
  const combined = nestedBindings.length ? nestedBindings.join('\n') + '\n' + body : body
  return { body: combined, exports }
}

/** Replace each [start,end) span with same-length spaces, preserving newlines. */
function blankSpans(source: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return source
  const chars = source.split('')
  for (const [start, end] of spans) {
    for (let i = start; i < end; i++) {
      // Preserve newlines so multi-line imports keep the line count intact.
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '
    }
  }
  return chars.join('')
}

/**
 * Emit a header binding capturing `exports` out of `body`.
 *
 * The binding opens and closes on single lines, but the helper `body` keeps its
 * REAL newlines in between — collapsing them to `;` would let a `//` line comment
 * (or any ASI-sensitive construct) swallow the rest of the helper. This is safe:
 * `instrumentWorkflow` derives `headerLines` from the ACTUAL newline count of the
 * emitted header, so the `codeLine - headerLines` body mapping stays exact no
 * matter how many physical lines the bindings span. The open `(() => {` and the
 * `return {...}` epilogue sit on their own lines so the body is never wrapped in
 * a comment or a broken statement.
 */
function toHeaderBinding(exports: string[], body: string): string {
  const names = exports.join(', ')
  return `const { ${names} } = (() => {\n${body}\n;return { ${names} };\n})();`
}

/**
 * Inline every pure-helper `tools/` import found at the TOP LEVEL of the body.
 *
 * - Imports that do NOT resolve under a tools/ dir are LEFT UNTOUCHED (the vm/
 *   validator handles them; only tools/ pure helpers are our concern).
 * - A tools/ import resolving to a capability or pulling in node/bare specifiers
 *   throws `InlineLoadError`.
 */
export function inlineHelpers(normalizedSource: string, opts: InlineOptions = {}): InlineResult {
  let ast: { body: Node[] }
  try {
    ast = parseModule(normalizedSource)
  } catch {
    // Validation runs before inlining; if parsing fails we pass the source
    // through untouched and let the vm surface the syntax error.
    return { source: normalizedSource, headerBindings: '' }
  }

  const importerDir = opts.workflowPath
    ? path.dirname(opts.workflowPath)
    : PROJECT_TOOLS_DIR // resolve "../tools/x" relative to a sibling of tools/
  // When no path is given, treat specifiers as relative to the workflows dir's
  // sibling so "../tools/x" lands in PROJECT_TOOLS_DIR. We approximate with the
  // project root (parent of PROJECT_TOOLS_DIR).
  const baseDir = opts.workflowPath ? importerDir : path.dirname(PROJECT_TOOLS_DIR)

  const importNodes = ast.body.filter((n) => (n as unknown as Node).type === 'ImportDeclaration') as unknown as ImportNode[]

  const blankSpansToApply: Array<[number, number]> = []
  const headerBindings: string[] = []
  const seen = new Set<string>()

  for (const imp of importNodes) {
    const spec = imp.source.value
    // Only consider relative specifiers that resolve under tools/. Everything
    // else (bare, node:, non-tools relative) is left untouched for the vm.
    if (isBareOrNodeSpecifier(spec)) continue
    const resolved = resolveToFile(spec, baseDir)
    if (!resolved || !isUnderToolsDir(resolved)) continue

    // It's a tools/ import — discriminate + inline (throws on capability/node).
    const helper = buildHelperBody(resolved, seen)
    seen.clear()

    // Capture the names actually imported by the workflow (alias-aware): we emit
    // bindings for the helper's exports, then the workflow uses them by their
    // imported names. Since header binds the exported names, an aliased import
    // (`import { a as b }`) needs a remap. Emit the helper's own export binding,
    // then alias to the local names the body references.
    headerBindings.push(toHeaderBinding(helper.exports, helper.body))
    const aliasLines = buildAliasLines(imp, helper.exports)
    if (aliasLines) headerBindings.push(aliasLines)

    blankSpansToApply.push([(imp as unknown as Node).start, (imp as unknown as Node).end])
  }

  const source = blankSpans(normalizedSource, blankSpansToApply)
  return { source, headerBindings: headerBindings.join('\n') }
}

/**
 * For an `import { a, b as c } from './tools/x'`, the header already binds the
 * helper's exported names (`a`, `b`). Emit `const c = b;` for any alias and bind
 * a default/namespace import to the captured object when present. Returns '' when
 * the import uses only direct-named specifiers matching export names.
 */
function buildAliasLines(imp: ImportNode, exportNames: string[]): string {
  const exportSet = new Set(exportNames)
  const aliases: string[] = []
  for (const s of imp.specifiers) {
    if (s.type === 'ImportSpecifier') {
      const imported = s.imported?.name
      const local = s.local.name
      if (imported && local !== imported) aliases.push(`const ${local} = ${imported};`)
      // direct named import where local === imported is already bound by the IIFE
      if (imported && !exportSet.has(imported)) {
        // Importing a name the helper does not export — surface clearly.
        throw new InlineLoadError(`pure helper does not export "${imported}" (imported in workflow).`)
      }
    } else if (s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier') {
      throw new InlineLoadError(
        `default/namespace import of a pure helper is not supported; use named imports (got "${s.local.name}").`,
      )
    }
  }
  return aliases.length ? aliases.join(' ') : ''
}
