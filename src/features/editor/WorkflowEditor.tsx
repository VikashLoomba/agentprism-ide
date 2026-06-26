import { useEffect, useRef } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useStore } from '@/store/useStore'
import {
  configureMonaco,
  updateWorkflowDts,
  refreshToolSources,
  setActiveWorkspace as setMonacoActiveWorkspace,
  MONACO_THEME,
} from '@/lib/monaco-setup'

export function WorkflowEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const bpCollection = useRef<editor.IEditorDecorationsCollection | null>(null)
  const pauseCollection = useRef<editor.IEditorDecorationsCollection | null>(null)

  const source = useStore((s) => s.source)
  const openKind = useStore((s) => s.openKind)
  const fileName = useStore((s) => s.fileName)
  const validation = useStore((s) => s.validation)
  const workflowDts = useStore((s) => s.workflowDts)
  const breakpoints = useStore((s) => s.breakpoints)
  const pauseLine = useStore((s) => s.run?.pause?.line)
  const toggleBreakpoint = useStore((s) => s.toggleBreakpoint)
  const setSource = useStore((s) => s.setSource)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const prevWorkspaceId = useRef<string | null>(null)

  // A non-workflow file (.hbs prompt template or .ts tool module) is not a
  // workflow: acorn markers, breakpoint glyphs, pause decorations, and the
  // workflow .d.ts are all meaningless here. Because @monaco-editor/react reuses
  // ONE model across the language flip, we must ACTIVELY CLEAR any stale workflow
  // markers/decorations on entering a non-workflow file (R3) — early-returning
  // alone would leave the prior workflow's squiggles, breakpoint glyphs, and
  // pause line painted over the new content.
  function clearWorkflowAnnotations() {
    const ed = editorRef.current
    const mon = monacoRef.current
    const model = ed?.getModel()
    if (mon && model) mon.editor.setModelMarkers(model, 'agentprism', [])
    bpCollection.current?.set([])
    pauseCollection.current?.clear()
  }

  function updateMarkers() {
    const ed = editorRef.current
    const mon = monacoRef.current
    const model = ed?.getModel()
    if (!ed || !mon || !model) return
    if (openKind !== 'workflow') {
      mon.editor.setModelMarkers(model, 'agentprism', [])
      return
    }
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
    if (openKind !== 'workflow') {
      bpCollection.current.set([])
      return
    }
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
    if (openKind !== 'workflow') {
      pauseCollection.current.clear()
      return
    }
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
    if (openKind !== 'workflow') clearWorkflowAnnotations()
    updateWorkflowDts(mon, openKind !== 'workflow' ? '' : workflowDts)
    updateMarkers()
    updateBreakpoints()
    updatePause()
    // Activate the current workspace's TS libs as soon as the worker exists (the
    // activeWorkspaceId effect may have run before this onMount set the monaco ref).
    if (activeWorkspaceId) {
      setMonacoActiveWorkspace(mon, activeWorkspaceId)
      prevWorkspaceId.current = activeWorkspaceId
    }
    // If a tool file is the first buffer (mounted before the effect's monaco ref
    // was set), load its sibling/source libs here.
    if (openKind === 'tool' && fileName)
      void refreshToolSources(mon, activeWorkspaceId, `file:///${activeWorkspaceId}/tools/${fileName}`)
  }

  // On the workflow<->prompt flip, clear stale workflow annotations first (R3).
  useEffect(() => {
    if (openKind !== 'workflow') clearWorkflowAnnotations()
    updateMarkers()
    updateBreakpoints()
    updatePause()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKind])
  useEffect(() => {
    const mon = monacoRef.current
    // Workflow .d.ts is meaningless for prompt/tool files; clear it for them.
    if (mon) updateWorkflowDts(mon, openKind !== 'workflow' ? '' : workflowDts)
  }, [workflowDts, openKind])
  useEffect(updateMarkers, [validation, openKind])
  useEffect(updateBreakpoints, [breakpoints, openKind])
  useEffect(updatePause, [pauseLine, openKind])

  // Tool-file intellisense: load the tool source files into the editor's virtual fs
  // so sibling imports resolve (the runtime already loads them via `await import()`).
  // npm package types are acquired reactively by the marker listener in
  // configureMonaco — no buffer scanning here.
  useEffect(() => {
    const mon = monacoRef.current
    if (!mon || openKind !== 'tool' || !fileName) return
    void refreshToolSources(mon, activeWorkspaceId, `file:///${activeWorkspaceId}/tools/${fileName}`)
  }, [openKind, fileName, activeWorkspaceId])

  // WorkflowEditor OWNS the Monaco-side workspace switch (the store has no monaco
  // ref). On activeWorkspaceId change — AFTER the store's state-only switch has
  // repointed the buffer/catalog mirrors — swap the TS extra-libs to the new
  // workspace and dispose the PREVIOUS workspace's tool models (§2.4 / WU-14).
  useEffect(() => {
    const mon = monacoRef.current
    if (!mon || !activeWorkspaceId) return
    if (prevWorkspaceId.current === activeWorkspaceId) return
    prevWorkspaceId.current = activeWorkspaceId
    setMonacoActiveWorkspace(mon, activeWorkspaceId)
  }, [activeWorkspaceId])

  // A tool .ts buffer gets a real file:// model URI so the editor's TS service can
  // resolve its `agentprism/capability` import against the injected virtual cap
  // package (full intellisense, no phantom "cannot find module"). Workflow/prompt
  // buffers stay on the default single reused model — preserving the R3 stale-
  // annotation clearing that relies on one model across the language flip.
  const modelPath =
    openKind === 'tool' && fileName ? `file:///${activeWorkspaceId}/tools/${fileName}` : undefined

  return (
    <Editor
      path={modelPath}
      language={openKind === 'prompt' ? 'handlebars' : openKind === 'tool' ? 'typescript' : 'javascript'}
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
