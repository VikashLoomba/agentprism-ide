import * as ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolLib } from '../shared/protocol.ts'

// ---------------------------------------------------------------------------
// Editor intellisense for tool/capability files (anchor-parameterized, §4/§5).
//
// A tool `.ts` buffer is host-loaded at run time via `await import()`, so its
// relative sibling imports (`./helpers.ts`) and npm imports (`import _ from
// 'lodash'`) resolve fine on disk. The Monaco editor only holds the open buffer
// plus the injected capability lib + node:* shim, so those imports squiggle as
// "cannot find module" even though they run.
//
// We close the gap in two pieces, mirroring how Monaco wants to be fed:
//   • listToolSourceLibs()      — every tool SOURCE file, loaded into the editor's
//     virtual filesystem up front so sibling imports always resolve.
//   • resolvePackageTypeLibs()  — the `.d.ts` graph (+ package.json) for a set of
//     npm specifiers, fetched on demand when Monaco reports one unresolved.
//
// Every resolution anchors at the WORKSPACE (its node_modules + tool dirs), never
// at PACKAGE_ROOT or process.cwd(); the virtual paths are namespaced by the
// workspaceId so two workspaces' libs never collide in the single Monaco worker
// (§2.4). The transitive declaration graph is walked by the TypeScript compiler
// itself (a throwaway Program), not by hand.
// ---------------------------------------------------------------------------

/** Resolution anchor for a workspace's tool intellisense (§4). */
export interface ToolIntellisenseAnchor {
  workspaceId: string
  /** = workspace.dirs.root — the probe lives here; the bundler walks its node_modules. */
  nodeModulesRoot: string
  /** workspace.capabilityDirs — ordered [project, user]. */
  capabilityDirs: readonly { dir: string }[]
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  allowJs: true,
  checkJs: false,
  noEmit: true,
  skipLibCheck: true,
  strict: false,
  esModuleInterop: true,
  resolveJsonModule: true,
  // Keep private/patched/monorepo-linked deps under <ws>/node_modules so the
  // node_modules filter + virtual re-keying keep working (§5.2).
  preserveSymlinks: true,
  // Don't auto-pull @types/node; node:* is shimmed loosely in the editor and
  // shipping all of @types/node would bloat the payload. Real npm packages still
  // resolve via moduleResolution.
  types: [],
  lib: [],
}

interface ToolFile {
  abs: string
  /** file:///<wsId>/tools/<relative-path-from-its-tools-dir> — matches the editor model URI. */
  virtual: string
}

/**
 * Recursively list every source file under the workspace's tool dirs (project +
 * user). Project shadows user: the first tier to claim a virtual path wins
 * (capabilityDirs is ordered [project, user]). Subdirectories ARE walked so a
 * capability split across helper files (e.g. tools/_jira/effects.ts) is visible.
 */
function listToolFiles(a: ToolIntellisenseAnchor): ToolFile[] {
  const byVirtual = new Map<string, ToolFile>()
  for (const { dir } of a.capabilityDirs) {
    const stack: string[] = [dir]
    while (stack.length) {
      const cur = stack.pop() as string
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = path.join(cur, e.name)
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue
          stack.push(full)
          continue
        }
        if (!e.isFile() && !e.isSymbolicLink()) continue
        if (!SOURCE_EXTS.has(path.extname(e.name))) continue
        const rel = path.relative(dir, full).split(path.sep).join('/')
        const virtual = `file:///${a.workspaceId}/tools/${rel}`
        if (!byVirtual.has(virtual)) byVirtual.set(virtual, { abs: full, virtual })
      }
    }
  }
  return [...byVirtual.values()]
}

/** Map an absolute node_modules path to its `file:///<wsId>/node_modules/...` virtual path. */
function nodeModulesVirtual(workspaceId: string, absFileName: string): string | null {
  const norm = absFileName.split(path.sep).join('/')
  const idx = norm.indexOf('node_modules/')
  if (idx === -1) return null
  return `file:///${workspaceId}/${norm.slice(idx)}`
}

/**
 * The package root dir for a node_modules file: `node_modules/<pkg>` or
 * `node_modules/@scope/<pkg>`. Used to also ship the package's package.json so the
 * editor resolver can read its "types"/"exports" conditions.
 */
function packageRootOf(absFileName: string): string | null {
  const marker = `node_modules${path.sep}`
  const idx = absFileName.indexOf(marker)
  if (idx === -1) return null
  const root = absFileName.slice(0, idx + marker.length)
  const after = absFileName.slice(idx + marker.length).split(path.sep)
  if (after.length === 0) return null
  const take = after[0].startsWith('@') ? 2 : 1
  if (after.length < take) return null
  return root + after.slice(0, take).join(path.sep)
}

/** Every tool source file, for the editor's virtual filesystem (sibling resolution). */
export function listToolSourceLibs(a: ToolIntellisenseAnchor): ToolLib[] {
  const out: ToolLib[] = []
  for (const f of listToolFiles(a)) {
    try {
      out.push({ filePath: f.virtual, content: fs.readFileSync(f.abs, 'utf8') })
    } catch {
      /* unreadable file — skip */
    }
  }
  return out
}

/**
 * Resolve the declaration-file graph (+ package.json) for a set of npm specifiers
 * (e.g. ['lodash', 'zod/v4']). A throwaway Program over a synthetic entry that
 * imports each specifier lets TypeScript walk the transitive `.d.ts` graph from
 * the WORKSPACE node_modules; we then harvest everything it pulled in under
 * node_modules and re-key it at `file:///<wsId>/node_modules/...`.
 */
export function resolvePackageTypeLibs(a: ToolIntellisenseAnchor, specifiers: string[]): ToolLib[] {
  const specs = [
    ...new Set(
      specifiers.filter(
        (s) => typeof s === 'string' && s.length > 0 && !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:'),
      ),
    ),
  ]
  if (specs.length === 0) return []

  // Synthetic entry under the WORKSPACE root so bare specifiers resolve against the
  // workspace's installed node_modules (the SAME upward walk Node's await import()
  // uses for the same tool file — §4). It exists only in the overlay host.
  const entryAbs = path.resolve(path.join(a.nodeModulesRoot, '__prism_types_probe__.ts'))
  const entrySrc = specs.map((s, i) => `import * as _p${i} from ${JSON.stringify(s)};`).join('\n') + '\nexport {}\n'

  const host = ts.createCompilerHost(COMPILER_OPTIONS, true)
  host.getCurrentDirectory = () => a.nodeModulesRoot
  const origGet = host.getSourceFile.bind(host)
  const origRead = host.readFile.bind(host)
  const origExists = host.fileExists.bind(host)
  host.getSourceFile = (fileName, lv, onError, shouldCreate) =>
    path.resolve(fileName) === entryAbs
      ? ts.createSourceFile(fileName, entrySrc, lv, true)
      : origGet(fileName, lv, onError, shouldCreate)
  host.readFile = (fileName) => (path.resolve(fileName) === entryAbs ? entrySrc : origRead(fileName))
  host.fileExists = (fileName) => (path.resolve(fileName) === entryAbs ? true : origExists(fileName))

  const program = ts.createProgram({ rootNames: [entryAbs], options: COMPILER_OPTIONS, host })

  const libs: ToolLib[] = []
  const seen = new Set<string>()
  const pkgRoots = new Set<string>()
  for (const sf of program.getSourceFiles()) {
    const fn = sf.fileName
    if (!fn.includes('node_modules/') && !fn.includes(`node_modules${path.sep}`)) continue
    // Accept every declaration-file flavour: .d.ts, .d.mts, .d.cts (packages like
    // zod point their `exports.types` condition at a .d.cts).
    if (!/\.d\.[mc]?ts$/.test(fn)) continue
    const virtual = nodeModulesVirtual(a.workspaceId, fn)
    if (!virtual) continue
    if (virtual.includes('/node_modules/typescript/')) continue // TS's own lib.*.d.ts
    if (virtual.includes('/node_modules/@types/node/')) continue // covered by the node:* shim
    if (seen.has(virtual)) continue
    seen.add(virtual)
    libs.push({ filePath: virtual, content: sf.text })
    const root = packageRootOf(fn)
    if (root) pkgRoots.add(root)
  }

  // package.json for each shipped package so the editor resolver finds its
  // "types"/"exports" entry (zod's points at index.d.cts, etc.).
  for (const root of pkgRoots) {
    const pkgJson = path.join(root, 'package.json')
    const virtual = nodeModulesVirtual(a.workspaceId, pkgJson)
    if (!virtual || seen.has(virtual)) continue
    try {
      const content = fs.readFileSync(pkgJson, 'utf8')
      seen.add(virtual)
      libs.push({ filePath: virtual, content })
    } catch {
      /* package without a package.json — fine, skip */
    }
  }

  return libs
}
