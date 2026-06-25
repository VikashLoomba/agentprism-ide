import type { Monaco } from '@monaco-editor/react'
import { INITIAL_WORKFLOW_DSL_DTS } from './workflow-dts'

const WORKFLOW_DTS_FILE_PATH = 'ts:agentprism-workflow-globals.d.ts'

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

  const ts = monaco.languages.typescript.typescriptDefaults
  ts.setExtraLibs([extraLib])
}

/**
 * Re-inject the DSL ambient .d.ts after it is regenerated (e.g. when the
 * connected-agents list loads or the default agent changes, which reshapes the
 * discriminated `AgentOptions` config union). Setting an extra lib with the same
 * `filePath` replaces the prior lib and the TS worker re-resolves; completions
 * are pull-based so the suggest widget picks up the new shape on its next query.
 * Red squiggles come from the acorn validator (semantic validation is OFF), so
 * there are no TS-service markers to refresh here.
 */
export function updateWorkflowDts(monaco: Monaco, dts: string): void {
  if (dts === lastDts) return
  lastDts = dts
  const extraLib = { content: dts, filePath: WORKFLOW_DTS_FILE_PATH }
  monaco.languages.typescript.javascriptDefaults.setExtraLibs([extraLib])
  monaco.languages.typescript.typescriptDefaults.setExtraLibs([extraLib])
}
