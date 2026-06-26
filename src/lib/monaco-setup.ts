import type { Monaco } from '@monaco-editor/react'
import type { Uri } from 'monaco-editor'
// Registers the bundled Handlebars language (id 'handlebars', ext '.hbs') so .hbs
// files highlight (mustache delimiters + the embedded html grammar). Without this
// side-effect import, .hbs falls back to plaintext — the single most likely
// "no highlighting" bug for the prompt-template live editor.
import 'monaco-editor/esm/vs/basic-languages/handlebars/handlebars.contribution'
// The real source of shared/capability.ts, injected into the TS service as a
// virtual `node_modules/agentprism` package so a tool module's
// `import { defineCapability } from 'agentprism/capability'` resolves to its
// actual types (full intellisense) instead of squiggling as an unresolved module.
import capabilitySource from '@shared/capability.ts?raw'
import { INITIAL_WORKFLOW_DSL_DTS } from './workflow-dts'
import { fetchToolSources, fetchToolTypes } from './api'

const WORKFLOW_DTS_FILE_PATH = 'ts:agentprism-workflow-globals.d.ts'
const NODE_SHIM_FILE_PATH = 'ts:agentprism-node-shim.d.ts'
// Tool modules may `import { execFile } from 'node:child_process'` etc. Rather
// than ship all of @types/node into the browser editor, declare node:* as a
// shorthand ambient module (no body) — that resolves EVERY import from it,
// including named ones, to `any`, so those imports don't squiggle as unresolved.
const NODE_SHIM_DTS = `declare module 'node:*';\n`

let configured = false
// Tracks the currently-injected DSL .d.ts so re-injection is skipped when the
// generated string is unchanged.
let lastDts = INITIAL_WORKFLOW_DSL_DTS

export const MONACO_THEME = 'agentprism-dark'

export function configureMonaco(monaco: Monaco): void {
  if (configured) return
  configured = true

  monaco.editor.defineTheme(MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e4e4e7' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c4b5fd' },
      { token: 'string', foreground: '86efac' },
      { token: 'string.escape', foreground: '5eead4' },
      { token: 'number', foreground: 'fda4af' },
      { token: 'identifier', foreground: 'e4e4e7' },
      { token: 'delimiter', foreground: '9ca3af' },
      { token: 'type', foreground: '7dd3fc' },
      { token: 'delimiter.handlebars', foreground: 'c4b5fd' },
      { token: 'keyword.helper.handlebars', foreground: 'c4b5fd' },
      { token: 'variable.parameter.handlebars', foreground: 'fda4af' },
    ],
    colors: {
      'editor.background': '#1b1b1f',
      'editor.foreground': '#e4e4e7',
      'editorLineNumber.foreground': '#52525b',
      'editorLineNumber.activeForeground': '#a1a1aa',
      'editor.selectionBackground': '#3b2f5e',
      'editor.lineHighlightBackground': '#232329',
      'editorCursor.foreground': '#c4b5fd',
      'editorGutter.background': '#1b1b1f',
      'editorIndentGuide.background1': '#2a2a31',
      'editorIndentGuide.activeBackground1': '#3f3f46',
      'editorWidget.background': '#202024',
      'editorWidget.border': '#2e2e35',
      'editorSuggestWidget.background': '#202024',
      'editorSuggestWidget.selectedBackground': '#2e2840',
      'editorHoverWidget.background': '#202024',
      'editorBracketMatch.background': '#3b2f5e66',
      'editorBracketMatch.border': '#7c5cff66',
    },
  })

  const extraLib = { content: INITIAL_WORKFLOW_DSL_DTS, filePath: WORKFLOW_DTS_FILE_PATH }
  lastDts = INITIAL_WORKFLOW_DSL_DTS
  const js = monaco.languages.typescript.javascriptDefaults
  js.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    allowJs: true,
    checkJs: false,
    lib: ['es2023'],
  })
  js.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntacticValidation: true,
    noSuggestionDiagnostics: true,
  })
  js.setExtraLibs([extraLib])

  const ts = monaco.languages.typescript.typescriptDefaults
  ts.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: 100,
    allowImportingTsExtensions: true,
    noEmit: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
    strictFunctionTypes: false,
    lib: ['es2023', 'dom'],
  } as Parameters<typeof ts.setCompilerOptions>[0])
  ts.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntacticValidation: false,
    noSuggestionDiagnostics: true,
  })
  // Libs are published once a workspace becomes active (setActiveWorkspace), since
  // every lib URI is namespaced by the active workspaceId (§2.4).
  ts.setExtraLibs([{ content: NODE_SHIM_DTS, filePath: NODE_SHIM_FILE_PATH }])
  toolMonaco = monaco

  // Work WITH Monaco, not around it: its TS worker already reports an unresolved
  // npm import as a "cannot find module" (2307) marker. React to that — fetch the
  // declaration graph for exactly the package it couldn't resolve and inject it.
  monaco.editor.onDidChangeMarkers((resources: readonly Uri[]) => {
    if (!activeWorkspaceId) return
    const prefix = `/${activeWorkspaceId}/tools/`
    for (const resource of resources) {
      if (!resource.path.startsWith(prefix)) continue
      const model = monaco.editor.getModel(resource)
      if (!model) continue
      const specs: string[] = []
      for (const mk of monaco.editor.getModelMarkers({ resource })) {
        const code = typeof mk.code === 'object' && mk.code ? mk.code.value : mk.code
        if (String(code) !== '2307' && !/cannot find module/i.test(mk.message)) continue
        const fromRange = model.getValueInRange({
          startLineNumber: mk.startLineNumber,
          startColumn: mk.startColumn,
          endLineNumber: mk.endLineNumber,
          endColumn: mk.endColumn,
        })
        const spec = (SPEC_RE.exec(fromRange) ?? SPEC_RE.exec(mk.message))?.[1]
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
        specs.push(spec)
      }
      if (specs.length) void ensurePackages(activeWorkspaceId, specs)
    }
  })
}

/**
 * The always-present libs for tool buffers, namespaced by the ACTIVE workspace:
 * a virtual `node_modules/agentprism` package (its `package.json` exports
 * `./capability` → `./capability.ts`, whose content is the real capability source
 * so `defineCapability` is typed) and the (ws-independent) node:* shim. A tool
 * buffer's model URI is `file:///<wsId>/tools/<name>.ts`, so Monaco's Bundler
 * resolution walks up to `file:///<wsId>/node_modules/agentprism` exactly like it
 * resolves `zod/v4`.
 */
function agentprismPkgJson(wsId: string): { content: string; filePath: string } {
  return {
    filePath: `file:///${wsId}/node_modules/agentprism/package.json`,
    content: JSON.stringify({
      name: 'agentprism',
      version: '0.0.0',
      type: 'module',
      exports: { './capability': './capability.ts' },
    }),
  }
}
function baseToolLibs(wsId: string): { content: string; filePath: string }[] {
  return [
    agentprismPkgJson(wsId),
    { content: capabilitySource, filePath: `file:///${wsId}/node_modules/agentprism/capability.ts` },
    { content: NODE_SHIM_DTS, filePath: NODE_SHIM_FILE_PATH },
  ]
}

// --- Per-workspace tool-file intellisense manager ---------------------------
// Bridges each workspace's node_modules to Monaco's single worker. Only the
// ACTIVE workspace's libs are published; the inactive workspace's tool models are
// disposed on switch (§2.4). Every lib URI is namespaced by its workspaceId.

const SPEC_RE = /['"]([^'"]+)['"]/

let toolMonaco: Monaco | null = null
let activeWorkspaceId: string | null = null
const wsSources = new Map<string, { filePath: string; content: string }[]>()
const wsOpenPath = new Map<string, string | undefined>()
const wsPackages = new Map<string, Map<string, string>>() // wsId -> (virtual filePath -> content)
const wsAttempted = new Map<string, Set<string>>()

function publishToolLibs(): void {
  if (!toolMonaco || !activeWorkspaceId) return
  const wsId = activeWorkspaceId
  const pkgs = wsPackages.get(wsId) ?? new Map<string, string>()
  const pkg = [...pkgs].map(([filePath, content]) => ({ filePath, content }))
  const pkgPaths = new Set(pkgs.keys())
  const openPath = wsOpenPath.get(wsId)
  // The open file is a live editor MODEL at its URI; adding it as an extra lib too
  // would double-declare its symbols, so exclude it (and anything a package occupies).
  const sources = (wsSources.get(wsId) ?? []).filter(
    (l) => l.filePath !== openPath && !pkgPaths.has(l.filePath),
  )
  toolMonaco.languages.typescript.typescriptDefaults.setExtraLibs([...baseToolLibs(wsId), ...sources, ...pkg])
}

/**
 * Load a workspace's tool source files into the editor's virtual fs (so sibling
 * imports resolve), and mark which file is open (excluded — it is a live model).
 * Republishes only when `wsId` is the active workspace.
 */
export async function refreshToolSources(monaco: Monaco, wsId: string, openPath: string | undefined): Promise<void> {
  toolMonaco = monaco
  activeWorkspaceId ??= wsId
  wsOpenPath.set(wsId, openPath)
  try {
    wsSources.set(wsId, (await fetchToolSources(wsId)).libs)
  } catch {
    /* keep prior sources; the base capability + node:* libs still apply */
  }
  if (wsId === activeWorkspaceId) publishToolLibs()
}

/** Fetch + inject the .d.ts graph for the npm specifiers Monaco couldn't resolve. */
async function ensurePackages(wsId: string, specifiers: string[]): Promise<void> {
  const attempted = wsAttempted.get(wsId) ?? new Set<string>()
  wsAttempted.set(wsId, attempted)
  const fresh = [...new Set(specifiers)].filter((s) => !attempted.has(s))
  if (fresh.length === 0) return
  fresh.forEach((s) => attempted.add(s))
  try {
    const pkgs = wsPackages.get(wsId) ?? new Map<string, string>()
    wsPackages.set(wsId, pkgs)
    let added = false
    for (const l of (await fetchToolTypes(wsId, fresh)).libs) {
      if (!pkgs.has(l.filePath)) {
        pkgs.set(l.filePath, l.content)
        added = true
      }
    }
    if (added && wsId === activeWorkspaceId) publishToolLibs()
  } catch {
    /* leave it attempted so we don't loop; the marker stays until the next change */
  }
}

/**
 * Make `wsId` the active workspace for the TS service (§2.4): republish ONLY its
 * libs and dispose the PREVIOUS workspace's tool models so all live models join one
 * single-project worker for the active workspace. Invoked from the WorkflowEditor's
 * activeWorkspaceId-subscribed effect, AFTER the store has repointed the buffer
 * mirror (so the disposed prior-ws models are never the freshly-mirrored buffer).
 */
export function setActiveWorkspace(monaco: Monaco, wsId: string): void {
  const prior = activeWorkspaceId
  toolMonaco = monaco
  activeWorkspaceId = wsId
  monaco.languages.typescript.typescriptDefaults.setExtraLibs([])
  publishToolLibs()
  if (prior && prior !== wsId) {
    const stale = `/${prior}/tools/`
    for (const m of monaco.editor.getModels()) {
      if (m.uri.path.startsWith(stale)) m.dispose()
    }
  }
}

/**
 * Re-inject the DSL ambient .d.ts after it is regenerated (connected-agents list,
 * default agent, or — now — the ACTIVE workspace's capability/prompt catalogs).
 * Workflows are the ONLY buffers on the JavaScript defaults, so the DSL globals
 * live there alone; the TypeScript defaults belong to tool modules and carry the
 * per-workspace capability + node:* libs instead.
 */
export function updateWorkflowDts(monaco: Monaco, dts: string): void {
  if (dts === lastDts) return
  lastDts = dts
  const extraLib = { content: dts, filePath: WORKFLOW_DTS_FILE_PATH }
  monaco.languages.typescript.javascriptDefaults.setExtraLibs([extraLib])
}
