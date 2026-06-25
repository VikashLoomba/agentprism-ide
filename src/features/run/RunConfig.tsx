import { Cpu, FolderOpen, Bug, ShieldQuestion } from 'lucide-react'
import type { AcpAgentId } from '@shared/agents'
import { useStore } from '@/store/useStore'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { MethodConfig } from './MethodConfig'

export function RunConfig() {
  const agents = useStore((s) => s.agents)
  const selectedAgent = useStore((s) => s.selectedAgent)
  const selectedMode = useStore((s) => s.selectedMode)
  const cwd = useStore((s) => s.cwd)
  const defaultCwd = useStore((s) => s.defaultCwd)
  const argsText = useStore((s) => s.argsText)
  const stepMode = useStore((s) => s.stepMode)
  const manualApprovals = useStore((s) => s.manualApprovals)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const setSelectedMode = useStore((s) => s.setSelectedMode)
  const setCwd = useStore((s) => s.setCwd)
  const setArgsText = useStore((s) => s.setArgsText)
  const setStepMode = useStore((s) => s.setStepMode)
  const setManualApprovals = useStore((s) => s.setManualApprovals)
  const liveModes = useStore((s) => s.run?.modes)
  const modes =
    liveModes ??
    agents.find((a) => a.id === selectedAgent)?.defaultModes ?? { currentModeId: 'default', availableModes: [] }
  const live = !!liveModes

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Cpu className="size-3" /> Default agent
            <span className="text-[10px] text-muted-foreground/60">used when agent() omits agent</span>
          </Label>
          <Select value={selectedAgent} onValueChange={(v) => setSelectedAgent(v as AcpAgentId)}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {!a.installed ? ' · npx' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            Mode <span className="text-[10px] text-muted-foreground/60">default agent&apos;s mode</span>
            {live && <span className="text-[9px] text-success">live</span>}
          </Label>
          <Select value={selectedMode} onValueChange={setSelectedMode}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modes.availableModes.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <FolderOpen className="size-3" /> Working directory
        </Label>
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder={defaultCwd}
          className="h-8 font-mono text-[12px]"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">
          args <span className="text-muted-foreground/60">(JSON, exposed to the script)</span>
        </Label>
        <Textarea
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder='{ "target": "src/" }'
          className="min-h-[44px] resize-none font-mono text-[12px]"
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-1.5">
        <Label htmlFor="stepmode" className="flex items-center gap-1.5 text-[12px]">
          <Bug className="size-3.5 text-warning" /> Step mode
          <span className="text-[10px] text-muted-foreground">pause at every agent</span>
        </Label>
        <Switch id="stepmode" checked={stepMode} onCheckedChange={setStepMode} />
      </div>

      <div className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-1.5">
        <Label htmlFor="manual" className="flex items-center gap-1.5 text-[12px]">
          <ShieldQuestion className="size-3.5 text-info" /> Manual approvals
          <span className="text-[10px] text-muted-foreground">confirm each tool</span>
        </Label>
        <Switch id="manual" checked={manualApprovals} onCheckedChange={setManualApprovals} />
      </div>

      <MethodConfig />
    </div>
  )
}
