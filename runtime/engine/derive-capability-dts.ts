// runtime/engine/derive-capability-dts.ts
// Derives each capability's injected-namespace `.d.ts` body from its effect
// FUNCTION SIGNATURES, using the TypeScript checker to COMPUTE the transformed
// signatures (we do no string surgery on signatures). A synthetic in-memory
// module imports each tool and applies a mapped/conditional type that drops the
// trusted-realm `ctx` param and makes every effect async:
//     (ctx: CapabilityContext, args: A) => Promise<R> | R   ==>   (args: A) => Promise<Awaited<R>>
// `checker.typeToString` then prints the fully-resolved structural object type.

import fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

/** Per-tool inputs needed to derive + cache (path identifies, mtime invalidates). */
export interface DerivableFile {
  path: string
  modifiedAt: number
}

/** Anchors for the throwaway dts Program (§5.3). Every path derives from the
 *  workspace root + the AgentPrism package root — never from process.cwd(). */
export interface DeriveDtsOptions {
  /** The owning workspace's root (anchors @types/node + npm resolution + cache key). */
  workspaceRoot: string
  /** AgentPrism's install dir; its `shared/capability.ts` backs the cap-API overlay. */
  packageRoot: string
  /** `path.dirname(USER_TOOLS_DIR)` = `~/.agentprism` — the user-tier shim parent (B15). */
  userToolsParent: string
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true, // resolve the tools' `../shared/capability.ts` import
  noEmit: true,
  strict: true,
  // Authors narrow `args` below EffectFn's `Json` param; under strictFunctionTypes
  // that fails a contravariant check and collapses effects to an index signature.
  // Turning it off keeps per-effect types WITHOUT loosening return-type inference.
  strictFunctionTypes: false,
  skipLibCheck: true,
  // Keep private/patched/monorepo-linked deps under <ws>/node_modules so the
  // node_modules filter + virtual re-keying keep working (§5.2).
  preserveSymlinks: true,
  types: ['node'], // auto-include @types/node so node:* builtins resolve
}

// Force STRUCTURAL printing (full object literal) instead of an alias name, and
// never abbreviate — the body must be self-contained for `declare const <ns>: {…}`.
const TYPE_FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias

// The transform helpers, as a synthetic module. TypeScript itself computes the
// ctx-drop and the always-async Promise<Awaited<R>> wrap. Expand<> forces the
// checker to print the structural object rather than `InjectedNamespace<…>`.
const INJECT_SRC = `
import type { CapabilityContext } from './shared/capability.ts'
export type InjectedEffect<F> =
  F extends (ctx: CapabilityContext, args: infer A) => infer R ? (args: A) => Promise<Awaited<R>>
  : F extends (ctx: CapabilityContext) => infer R ? () => Promise<Awaited<R>>
  : never
export type InjectedNamespace<E> = { [K in keyof E]: InjectedEffect<E[K]> }
export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never
`

/** Stable per-tool driver-const name from the file path (NOT the namespace). */
function driverName(filePath: string): string {
  return 'v_' + Buffer.from(filePath).toString('hex')
}

/** The synthetic check module: one value-import + one driver const per tool. The
 *  inject module is a sibling, so it is imported by relative specifier. */
function buildCheckSrc(files: DerivableFile[]): string {
  const lines = [`import type { InjectedNamespace, Expand } from './__prism_inject__.ts'`]
  files.forEach((f, i) => lines.push(`import _t${i} from '${f.path}'`))
  files.forEach((f, i) =>
    lines.push(
      `export declare const ${driverName(f.path)}: Expand<InjectedNamespace<(typeof _t${i})['effects']>>`,
    ),
  )
  return lines.join('\n') + '\n'
}

/** Overlay CompilerHost: layers the synthetic files + the cap-API overlay over
 *  disk; node + @types + the .ts relative imports keep resolving through the
 *  unmodified base host, anchored at the workspace root. */
function buildProgram(
  overlays: Map<string, string>,
  checkPath: string,
  workspaceRoot: string,
): { program: ts.Program; checker: ts.TypeChecker } {
  const host = ts.createCompilerHost(COMPILER_OPTIONS)
  host.getCurrentDirectory = () => workspaceRoot

  const norm = new Map<string, string>()
  for (const [p, text] of overlays) norm.set(ts.sys.resolvePath(p), text)

  const origGet = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, lv, onErr, shouldCreate) => {
    const o = norm.get(ts.sys.resolvePath(fileName))
    return o !== undefined
      ? ts.createSourceFile(fileName, o, lv, true)
      : origGet(fileName, lv, onErr, shouldCreate)
  }
  const origExists = host.fileExists.bind(host)
  host.fileExists = (fileName) => norm.has(ts.sys.resolvePath(fileName)) || origExists(fileName)
  const origRead = host.readFile.bind(host)
  host.readFile = (fileName) => {
    const o = norm.get(ts.sys.resolvePath(fileName))
    return o !== undefined ? o : origRead(fileName)
  }

  const program = ts.createProgram([checkPath], COMPILER_OPTIONS, host)
  return { program, checker: program.getTypeChecker() }
}

/** Strip exactly one outer `{ }` pair → the brace BODY stored in entry.dts
 *  (matches buildCapabilityDts's `declare const <ns>: {\n<body>\n};`). */
function toBraceBody(objType: string): string {
  const s = objType.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return s
  return s.slice(1, -1).trim()
}

// Building a TS Program is CPU-heavy and loadCapabilities() runs on every
// /api/validate. Cache by (workspaceRoot) -> (path:mtime) signature so the
// Program is rebuilt only when a tool file actually changes, and two workspaces
// with same-path/same-mtime tools do not share a derived dts (B4, §5.3).
const cache = new Map<string, { sig: string; map: Map<string, string> }>()

/** Drop a closed workspace's derived-dts cache entry (WorkspaceRegistry.close,
 *  §1.2 step 2). The runtime's ONLY per-workspace catalog cache. */
export function evictCapabilityDtsCache(workspaceRoot: string): void {
  cache.delete(workspaceRoot)
}

/**
 * Map each capability file path → its derived namespace `.d.ts` body (the inside
 * of `declare const <ns>: { … }`). Files that don't default-export a capability
 * (pure helpers) yield an empty `{}` body, which is then skipped.
 */
export function deriveCapabilityDts(files: DerivableFile[], opts: DeriveDtsOptions): Map<string, string> {
  const { workspaceRoot, packageRoot, userToolsParent } = opts
  const sig = files
    .map((f) => `${f.path}:${f.modifiedAt}`)
    .sort()
    .join('|')
  const cached = cache.get(workspaceRoot)
  if (cached && cached.sig === sig) return cached.map

  const injectPath = path.join(workspaceRoot, '__prism_inject__.ts')
  const checkPath = path.join(workspaceRoot, '__prism_check__.ts')

  const map = new Map<string, string>()
  if (files.length > 0) {
    const overlays = new Map<string, string>([
      [injectPath, INJECT_SRC],
      [checkPath, buildCheckSrc(files)],
    ])
    // The single AgentPrism-owned capability API source (§0). Overlaid at BOTH the
    // workspace-relative path (project-tier tools + INJECT_SRC's `./shared/...`) AND
    // the user-tier path (~/.agentprism/shared/...) so every tier's relative import
    // resolves to PACKAGE_ROOT's source. Both overlays point at the ONE source.
    try {
      const capSrc = fs.readFileSync(path.join(packageRoot, 'shared', 'capability.ts'), 'utf8')
      overlays.set(path.join(workspaceRoot, 'shared', 'capability.ts'), capSrc)
      overlays.set(path.join(userToolsParent, 'shared', 'capability.ts'), capSrc)
    } catch {
      /* PACKAGE_ROOT cap source unreadable — fall through; imports squiggle but the
         loader still degrades to the loose fallback dts per-file. */
    }
    const { program, checker } = buildProgram(overlays, checkPath, workspaceRoot)
    const checkSf = program.getSourceFile(checkPath)
    if (checkSf) {
      // keyed by driver-const name, to map results back to file.path.
      const byDriver = new Map(files.map((f) => [driverName(f.path), f.path]))
      const visit = (node: ts.Node): void => {
        if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name)) continue
            const filePath = byDriver.get(decl.name.text)
            if (!filePath) continue
            const sym = checker.getSymbolAtLocation(decl.name)
            if (!sym) continue
            const type = checker.getTypeOfSymbolAtLocation(sym, decl)
            const body = toBraceBody(checker.typeToString(type, decl, TYPE_FLAGS))
            // Empty body == no effects (pure helper / `{}`); skip so the loader's
            // `derivedDts.get(path) ?? ''` falls through to the loose fallback.
            if (body) map.set(filePath, body)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(checkSf)
    }
  }

  cache.set(workspaceRoot, { sig, map })
  return map
}
