import { useState } from 'react'
import {
  Cpu,
  FolderOpen,
  Bug,
  ShieldQuestion,
  KeyRound,
  Plug,
  ChevronDown,
  Check,
  AlertTriangle,
} from 'lucide-react'
import type { AcpAgentId } from '@shared/agents'
import type { CapabilityCatalogEntry } from '@shared/protocol'
import type { WorkflowInputParam } from '@shared/dsl'
import type { ParamType } from '@shared/param'
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
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { MethodConfig } from './MethodConfig'

/** Bare name of a `meta.capabilities` ref, dropping any `name@tier`/`./tools`-style qualifier. */
function bareCapName(ref: string): string {
  const at = ref.indexOf('@')
  return (at === -1 ? ref : ref.slice(0, at)).trim()
}

/** The catalog entries actually referenced by the workflow, project-tier preferred (shadowing). */
function usedCapabilities(
  declared: string[],
  catalog: CapabilityCatalogEntry[],
): Array<CapabilityCatalogEntry & { shadowsUser: boolean }> {
  const out: Array<CapabilityCatalogEntry & { shadowsUser: boolean }> = []
  for (const ref of declared) {
    const name = bareCapName(ref)
    const matches = catalog.filter((c) => c.name === name)
    if (matches.length === 0) continue
    const project = matches.find((c) => c.tier === 'project')
    const chosen = project ?? matches[0]
    const shadowsUser = chosen.tier === 'project' && matches.some((c) => c.tier === 'user')
    out.push({ ...chosen, shadowsUser })
  }
  return out
}

/**
 * Read-only per-secret required/present status for the used capabilities.
 * NEVER an Input — plaintext secret values never reach the client.
 */
function SecretsPanel() {
  const declared = useStore((s) => s.validation.meta?.capabilities)
  const catalog = useStore((s) => s.capabilities)
  const used = usedCapabilities(declared ?? [], catalog ?? [])
  const rows = used.filter((c) => c.secrets.length > 0)
  if (rows.length === 0) return null

  return (
    <div className="space-y-2 rounded-md border border-border/60 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[12px] text-foreground/90">
        <KeyRound className="size-3.5 text-warning" /> Secrets
        <span className="ml-auto text-[10px] text-muted-foreground">required by used tools · status only</span>
      </div>
      <div className="space-y-2">
        {rows.map((cap) => (
          <div key={`${cap.tier}:${cap.name}`} className="space-y-1">
            <span className="font-mono text-[11px] font-semibold text-primary/90">{cap.name}</span>
            <div className="space-y-1 pl-1">
              {cap.secrets.map((secret) => {
                const present = cap.secretStatus?.[secret]?.present ?? false
                return (
                  <div key={secret} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">{secret}</span>
                    {present ? (
                      <Badge variant="outline" className="gap-1 border-success/40 text-success">
                        <Check className="size-3" /> present
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 border-warning/40 text-warning">
                        <AlertTriangle className="size-3" /> required
                      </Badge>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Collapsible read-only view of the capabilities this workflow declares (name, tier, shadow note). */
function CapabilitiesPanel() {
  const [open, setOpen] = useState(false)
  const declared = useStore((s) => s.validation.meta?.capabilities)
  const catalog = useStore((s) => s.capabilities)
  const used = usedCapabilities(declared ?? [], catalog ?? [])
  if (used.length === 0) return null

  return (
    <div className="rounded-md border border-border/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-foreground/90 hover:text-foreground"
      >
        <Plug className="size-3.5 text-primary" /> Capabilities
        <span className="rounded bg-primary/20 px-1 text-[9px] tabular-nums text-primary">{used.length}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">shared tools this run can touch</span>
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/50 px-2.5 py-2.5">
          {used.map((cap) => (
            <div key={`${cap.tier}:${cap.name}`} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[12px] font-semibold text-primary/90">{cap.name}</span>
                <Badge variant="outline" className="text-[9px]">
                  {cap.tier}
                </Badge>
              </div>
              {cap.methods.length > 0 && (
                <p className="font-mono text-[10px] leading-snug text-muted-foreground/70">
                  {cap.methods.join(' · ')}
                </p>
              )}
              {cap.shadowsUser && (
                <p className="text-[10px] leading-snug text-info">project tool, shadowing Shared tools</p>
              )}
              {cap.loadError && (
                <p className="text-[10px] leading-snug text-destructive">{cap.loadError}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Render a stored array value as one-value-per-line text for the Textarea. */
function arrayToLines(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => String(v)).join('\n') : ''
}

/** Parse one-value-per-line text back into the strictly-typed array the store
 *  holds (so validateInputs gates on real types). Blank lines are dropped. */
function linesToArray(text: string, type: ParamType): unknown[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (type === 'number[]') return lines.map((l) => Number(l))
  if (type === 'boolean[]') return lines.map((l) => l === 'true')
  return lines
}

/** One control for a declared `meta.inputs` param, bound to `inputValues`. */
function InputField({ param }: { param: WorkflowInputParam }) {
  const value = useStore((s) => s.inputValues[param.name])
  const setInputValue = useStore((s) => s.setInputValue)
  const isArray = param.type.endsWith('[]')

  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground/90">{param.name}</span>
        {param.required && <span className="text-warning">*</span>}
        <span className="text-[10px] text-muted-foreground/60">{param.type}</span>
      </Label>
      {param.description && (
        <p className="text-[10px] leading-snug text-muted-foreground/70">{param.description}</p>
      )}
      {param.type === 'boolean' ? (
        <Switch
          checked={value === true}
          onCheckedChange={(b) => setInputValue(param.name, b)}
        />
      ) : param.type === 'number' ? (
        <Input
          type="number"
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) =>
            setInputValue(param.name, e.target.value === '' ? undefined : Number(e.target.value))
          }
          className="h-8 font-mono text-[12px]"
        />
      ) : isArray ? (
        <Textarea
          value={arrayToLines(value)}
          onChange={(e) => setInputValue(param.name, linesToArray(e.target.value, param.type))}
          placeholder="one value per line"
          className="min-h-[44px] resize-none font-mono text-[12px]"
          spellCheck={false}
        />
      ) : (
        <Input
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => setInputValue(param.name, e.target.value)}
          className="h-8 font-mono text-[12px]"
        />
      )}
    </div>
  )
}

/**
 * When the workflow declares `meta.inputs`, render a generated typed form (the
 * form IS `args`) and tuck the raw JSON textarea behind an "advanced" toggle.
 * When it declares none, render today's raw args textarea exactly.
 */
function InputsSection() {
  const inputs = useStore((s) => s.validation.meta?.inputs)
  const argsText = useStore((s) => s.argsText)
  const setArgsText = useStore((s) => s.setArgsText)
  const [advanced, setAdvanced] = useState(false)

  if (!inputs || inputs.length === 0) {
    return (
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
    )
  }

  return (
    <div className="space-y-2.5">
      <Label className="text-[11px] text-muted-foreground">
        Inputs <span className="text-muted-foreground/60">(typed args for this workflow)</span>
      </Label>
      {inputs.map((param) => (
        <InputField key={param.name} param={param} />
      ))}
      <button
        onClick={() => setAdvanced((a) => !a)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn('size-3 transition-transform', !advanced && '-rotate-90')} />
        Advanced (raw args JSON)
      </button>
      {advanced && (
        <Textarea
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder='{ "target": "src/" }'
          className="min-h-[44px] resize-none font-mono text-[12px]"
          spellCheck={false}
        />
      )}
    </div>
  )
}

export function RunConfig() {
  const agents = useStore((s) => s.agents)
  const selectedAgent = useStore((s) => s.selectedAgent)
  const selectedMode = useStore((s) => s.selectedMode)
  const cwd = useStore((s) => s.cwd)
  const defaultCwd = useStore((s) => s.defaultCwd)
  const stepMode = useStore((s) => s.stepMode)
  const manualApprovals = useStore((s) => s.manualApprovals)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const setSelectedMode = useStore((s) => s.setSelectedMode)
  const setCwd = useStore((s) => s.setCwd)
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

      <InputsSection />

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

      <SecretsPanel />

      <CapabilitiesPanel />

      <MethodConfig />
    </div>
  )
}
