import { useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ChevronDown, Settings2 } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RunConfig } from './RunConfig'
import { PauseInspector } from './PauseInspector'
import { RunTree } from './RunTree'
import { ResultPanel } from './ResultPanel'
import { LogConsole } from './LogConsole'
import { cn } from '@/lib/utils'

export function RunPanel() {
  const run = useStore((s) => s.run)
  const [configOpen, setConfigOpen] = useState(true)
  const [tab, setTab] = useState('run')
  const finished = !!run?.finishedAt

  useEffect(() => {
    if (finished && run?.result !== undefined) setTab('result')
  }, [finished, run?.result])

  return (
    <PanelGroup direction="vertical">
      <Panel defaultSize={62} minSize={28}>
        <div className="flex h-full flex-col bg-sidebar/40">
          <button
            onClick={() => setConfigOpen((o) => !o)}
            className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="size-3.5" /> Run configuration
            <ChevronDown className={cn('ml-auto size-3.5 transition-transform', !configOpen && '-rotate-90')} />
          </button>
          {configOpen && (
            <div className="max-h-[55%] shrink-0 overflow-y-auto border-b border-border/50">
              <RunConfig />
            </div>
          )}
          <PauseInspector />
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-3 mt-2 h-8 shrink-0 self-start">
              <TabsTrigger value="run" className="text-xs">
                Run
              </TabsTrigger>
              <TabsTrigger value="result" className="text-xs">
                Result
              </TabsTrigger>
            </TabsList>
            <TabsContent value="run" className="mt-0 min-h-0 flex-1">
              {run ? (
                <RunTree run={run} />
              ) : (
                <p className="px-3 py-10 text-center text-xs text-muted-foreground">
                  Press <b>Run</b> to execute the workflow. Phases and agents will appear here.
                </p>
              )}
            </TabsContent>
            <TabsContent value="result" className="mt-0 min-h-0 flex-1">
              <ResultPanel />
            </TabsContent>
          </Tabs>
        </div>
      </Panel>
      <PanelResizeHandle className="h-px bg-border transition-colors data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary/60" />
      <Panel defaultSize={38} minSize={10}>
        <LogConsole />
      </Panel>
    </PanelGroup>
  )
}
