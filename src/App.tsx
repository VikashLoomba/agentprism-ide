import { useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useStore } from '@/store/useStore'
import { Header } from '@/features/layout/Header'
import { FileSidebar } from '@/features/files/FileSidebar'
import { MetaPanel } from '@/features/meta/MetaPanel'
import { WorkflowEditor } from '@/features/editor/WorkflowEditor'
import { EditorStatusBar } from '@/features/editor/EditorStatusBar'
import { RunPanel } from '@/features/run/RunPanel'
import { PermissionDialog } from '@/features/run/PermissionDialog'

const HRESIZE =
  'w-px bg-border transition-colors data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary/60'
const VRESIZE =
  'h-px bg-border transition-colors data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary/60'

export default function App() {
  const init = useStore((s) => s.init)
  useEffect(() => {
    init()
  }, [init])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <Header />
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* Left: files + meta */}
        <Panel defaultSize={19} minSize={13} maxSize={32}>
          <PanelGroup direction="vertical" className="border-r border-border bg-sidebar">
            <Panel defaultSize={45} minSize={15}>
              <FileSidebar />
            </Panel>
            <PanelResizeHandle className={VRESIZE} />
            <Panel defaultSize={55} minSize={20}>
              <div className="flex h-full flex-col">
                <div className="shrink-0 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Meta
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <MetaPanel />
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className={HRESIZE} />

        {/* Center: editor */}
        <Panel defaultSize={45} minSize={25}>
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <WorkflowEditor />
            </div>
            <EditorStatusBar />
          </div>
        </Panel>

        <PanelResizeHandle className={HRESIZE} />

        {/* Right: run */}
        <Panel defaultSize={36} minSize={22}>
          <RunPanel />
        </Panel>
      </PanelGroup>

      <PermissionDialog />
    </div>
  )
}
