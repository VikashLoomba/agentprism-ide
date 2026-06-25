import type { Monaco } from '@monaco-editor/react'
// Registers the bundled Handlebars language (id 'handlebars', ext '.hbs') so .hbs
// files highlight (mustache delimiters + the embedded html grammar). Without this
// side-effect import, .hbs falls back to plaintext — the single most likely
// "no highlighting" bug for the prompt-template live editor.
import 'monaco-editor/esm/vs/basic-languages/handlebars/handlebars.contribution'
// The real source of shared/capability.ts, injected into the TS service as a
// virtual file so a tool module's `import { defineCapability } from
// '../shared/capability.ts'` resolves to its actual types (full intellisense)
// instead of squiggling as an unresolved module.
import capabilitySource from '@shared/capability.ts?raw'
import { INITIAL_WORKFLOW_DSL_DTS } from './workflow-dts'

const WORKFLOW_DTS_FILE_PATH = 'ts:agentprism-workflow-globals.d.ts'
// Virtual path the cap lib lives at. A tool buffer gets the model URI
// file:///tools/<name>.ts (see WorkflowEditor), so its relative
// `../shared/capability.ts` import resolves exactly here.
const CAPABILITY_LIB_PATH = 'file:///shared/capability.ts'
const NODE_SHIM_FILE_PATH = 'ts:agentprism-node-shim.d.ts'
// Tool modules may `import { execFile } from 'node:child_process'` etc. Rather
// than ship all of @types/node into the browser editor, declare node:* as a
// shorthand ambient module (no body) — that resolves EVERY import from it,
// including named ones, to `any`, so those imports don't squiggle as unresolved.
const NODE_SHIM_DTS = `declare module 'node:*';\n`

let configured = false
// Tracks the currently-injected DSL .d.ts so re-injection is skipped when the
// generated string is unchanged (the union only varies with the connected
// agents / default agent, which change rarely).
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
      // Handlebars/mustache (.hbs) delimiters + expressions, themed to match the
      // dark palette. The grammar emits these scopes via the bundled contribution.
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
  // Our acorn-based validator owns diagnostics; silence the TS service noise
  // (top-level await/return) while keeping intellisense from the extra lib.
  js.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntacticValidation: true,
    noSuggestionDiagnostics: true,
  })
  js.setExtraLibs([extraLib])

  // Tool/capability modules (tools/<name>.ts) open as real TypeScript. Unlike the
  // workflow .js buffer — whose diagnostics the acorn validator owns — we WANT the
  // TS service live here so `defineCapability(...)` is fully typed and checked.
  // For `import { defineCapability } from '../shared/capability.ts'` to resolve
  // (rather than throw a phantom "cannot find module") we need: Bundler module
  // resolution + allowImportingTsExtensions to accept the explicit `.ts`
  // extension (load-bearing for the real Node loader). Monaco bundles TS 5.9,
  // which supports both; only its hand-maintained monaco.d.ts enum is stale,
  // hence the cast (ModuleResolutionKind.Bundler === 100). The cap-source +
  // node:* shim libs supply the types so nothing squiggles as unresolved.
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
    // Effect authors narrow `args` to a concrete shape (args: { key: string }),
    // which is intentionally MORE specific than EffectFn's Json parameter. Bivariant
    // parameter checking lets that assign cleanly; the precise external signature is
    // carried by each capability's own `dts`, so nothing real is lost here.
    strict: false,
    strictFunctionTypes: false,
    lib: ['es2023', 'dom'],
  } as Parameters<typeof ts.setCompilerOptions>[0])
  ts.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntacticValidation: false,
    noSuggestionDiagnostics: true,
  })
  ts.setExtraLibs([
    { content: capabilitySource, filePath: CAPABILITY_LIB_PATH },
    { content: NODE_SHIM_DTS, filePath: NODE_SHIM_FILE_PATH },
  ])
}

/**
 * Re-inject the DSL ambient .d.ts after it is regenerated (e.g. when the
 * connected-agents list loads or the default agent changes, which reshapes the
 * discriminated `AgentOptions` config union). Setting an extra lib with the same
 * `filePath` replaces the prior lib and the TS worker re-resolves; completions
 * are pull-based so the suggest widget picks up the new shape on its next query.
 * Red squiggles come from the acorn validator (semantic validation is OFF), so
 * there are no TS-service markers to refresh here.
 *
 * Workflows are the ONLY buffers on the JavaScript defaults, so the DSL globals
 * live there alone. The TypeScript defaults belong to tool modules and carry the
 * capability + node:* libs instead — they must NOT be overwritten here, or a tool
 * buffer would lose its `defineCapability` types (and gain phantom workflow
 * globals it shouldn't see).
 */
export function updateWorkflowDts(monaco: Monaco, dts: string): void {
  if (dts === lastDts) return
  lastDts = dts
  const extraLib = { content: dts, filePath: WORKFLOW_DTS_FILE_PATH }
  monaco.languages.typescript.javascriptDefaults.setExtraLibs([extraLib])
}
