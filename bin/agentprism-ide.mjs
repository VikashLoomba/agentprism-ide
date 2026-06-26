#!/usr/bin/env node
// bin/agentprism-ide.mjs
//
// `npx agentprism-ide` — boots the local AgentPrism IDE server.
//
// The IDE server is nothing but a consumer of the published runtime (one engine):
// it builds a Runtime via `createRuntime()` and adapts it to HTTP/WS via
// `createServer(runtime)`. This bin wires those together and listens.
//
// Two load paths share one shape:
//   - published: import the built JS from dist-lib/ (consumers can't run tsx).
//   - in-repo/dev: import the TS source directly (tsx loads the `.ts` modules).
// In BOTH paths tsx is registered first, so user-authored `.ts` tools/capabilities
// loaded at run time resolve regardless of how the runtime itself was imported.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'tsx/esm/api'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Walk up from a starting dir to the nearest dir containing package.json. */
function findPackageRoot(start) {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** Minimal `--flag value` / `--flag=value` parser for the passthrough flags.
 *  `--workspace` is repeatable and accumulates into an array (the LSP
 *  initial-workspace-set model); every other flag is last-wins. */
function parseArgs(argv) {
  const out = {}
  const push = (key, value) => {
    if (key === 'workspace') (out.workspace ??= []).push(value)
    else out[key] = value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      push(arg.slice(2, eq), arg.slice(eq + 1))
    } else {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        push(arg.slice(2), next)
        i++
      } else {
        out[arg.slice(2)] = true
      }
    }
  }
  return out
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))

  // --cwd picks the DEFAULT workspace root (no chdir — the runtime derives every
  // path from the explicit root). Repeatable --workspace pre-opens more roots
  // (the LSP initial-set model); the first opened (the default root) is default.
  const root = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd()
  const extraRoots = (Array.isArray(flags.workspace) ? flags.workspace : []).map((w) => path.resolve(w))

  const port = Number(flags.port ?? process.env.PORT ?? 8787)

  // Register tsx so `.ts` modules (the dev runtime path AND user `.ts` tools) load.
  register()

  const packageRoot = findPackageRoot(HERE)

  // Prefer the built lib when present (published install); fall back to the TS
  // source for the in-repo/dev path.
  const builtFactory = path.join(packageRoot, 'dist-lib', 'server', 'factory.js')
  const builtRuntime = path.join(packageRoot, 'dist-lib', 'runtime', 'index.js')
  const useBuilt = fs.existsSync(builtFactory) && fs.existsSync(builtRuntime)

  const factoryEntry = useBuilt ? builtFactory : path.join(packageRoot, 'server', 'factory.ts')
  const runtimeEntry = useBuilt ? builtRuntime : path.join(packageRoot, 'runtime', 'index.ts')

  const { createServer } = await import(pathToFileURL(factoryEntry).href)
  const { createRuntime } = await import(pathToFileURL(runtimeEntry).href)

  const runtime = createRuntime({ workspaces: [root, ...extraRoots] })
  const server = createServer(runtime)
  server.listen(port)
}

main().catch((err) => {
  console.error('[agentprism-ide] failed to start:', err)
  process.exit(1)
})
