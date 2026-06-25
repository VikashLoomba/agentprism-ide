import { useEffect, useRef } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useStore } from '@/store/useStore'
import { configureMonaco, updateWorkflowDts, MONACO_THEME } from '@/lib/monaco-setup'

export function WorkflowEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const bpCollection = useRef<editor.IEditorDecorationsCollection | null>(null)
  const pauseCollection = useRef<editor.IEditorDecorationsCollection | null>(null)

  const source = useStore((s) => s.source)
  const validation = useStore((s) => s.validation)
  const workflowDts = useStore((s) => s.workflowDts)
  const breakpoints = useStore((s) => s.breakpoints)
  const pauseLine = useStore((s) => s.run?.pause?.line)
  const toggleBreakpoint = useStore((s) => s.toggleBreakpoint)
  const setSource = useStore((s) => s.setSource)

  function updateMarkers() {
    const ed = editorRef.current
    const mon = monacoRef.current
    const model = ed?.getModel()
    if (!ed || !mon || !model) return
    mon.editor.setModelMarkers(
      model,
      'agentprism',
      validation.diagnostics.map((d) => ({
        startLineNumber: d.startLine,
        startColumn: d.startColumn,
        endLineNumber: d.endLine,
        endColumn: d.endColumn,
        message: d.message,
        severity: d.severity === 'error' ? mon.MarkerSeverity.Error : mon.MarkerSeverity.Warning,
      })),
    )
  }

  function updateBreakpoints() {
    const mon = monacoRef.current
    if (!bpCollection.current || !mon) return
    bpCollection.current.set(
      breakpoints.map((line) => ({
        range: new mon.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'bp-glyph',
          glyphMarginHoverMessage: { value: 'Breakpoint — pauses after the agent() on this line resolves' },
        },
      })),
    )
  }

  function updatePause() {
    const ed = editorRef.current
    const mon = monacoRef.current
    if (!ed || !mon || !pauseCollection.current) return
    if (pauseLine) {
      pauseCollection.current.set([
        {
          range: new mon.Range(pauseLine, 1, pauseLine, 1),
          options: { isWholeLine: true, className: 'paused-line', glyphMarginClassName: 'paused-glyph' },
        },
      ])
      ed.revealLineInCenterIfOutsideViewport(pauseLine)
    } else {
      pauseCollection.current.clear()
    }
  }

  const onMount: OnMount = (ed, mon) => {
    editorRef.current = ed
    monacoRef.current = mon
    bpCollection.current = ed.createDecorationsCollection()
    pauseCollection.current = ed.createDecorationsCollection()
    ed.onMouseDown((e) => {
      if (e.target.type === mon.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        toggleBreakpoint(e.target.position.lineNumber)
      }
    })
    updateWorkflowDts(mon, workflowDts)
    updateMarkers()
    updateBreakpoints()
    updatePause()
  }

  useEffect(() => {
    const mon = monacoRef.current
    if (mon) updateWorkflowDts(mon, workflowDts)
  }, [workflowDts])
  useEffect(updateMarkers, [validation])
  useEffect(updateBreakpoints, [breakpoints])
  useEffect(updatePause, [pauseLine])

  return (
    <Editor
      language="javascript"
      theme={MONACO_THEME}
      value={source}
      beforeMount={(monaco) => configureMonaco(monaco)}
      onMount={onMount}
      onChange={(value) => setSource(value ?? '')}
      options={{
        glyphMargin: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontLigatures: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderLineHighlight: 'all',
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 12, bottom: 12 },
        lineNumbersMinChars: 3,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        overviewRulerLanes: 0,
      }}
    />
  )
}
