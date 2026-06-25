import { Plus, X } from 'lucide-react'
import type { WorkflowMeta } from '@shared/dsl'
import { useStore } from '@/store/useStore'
import { replaceMeta } from '@/lib/meta-edit'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

export function MetaPanel() {
  const source = useStore((s) => s.source)
  const validation = useStore((s) => s.validation)
  const setSource = useStore((s) => s.setSource)
  const meta = validation.meta

  function update(patch: Partial<WorkflowMeta>) {
    const base: WorkflowMeta = meta ?? { name: '', description: '' }
    const next = { ...base, ...patch }
    const newSource = replaceMeta(source, next)
    if (newSource != null) setSource(newSource)
  }

  if (!meta) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        The <code className="rounded bg-muted px-1 py-0.5 text-[11px]">meta</code> block could not be parsed. Fix the
        editor errors to edit it here.
      </div>
    )
  }

  const phases = meta.phases ?? []

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">Name</Label>
        <Input
          value={meta.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="short_snake_case"
          className="h-8 font-mono text-[13px]"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">Description</Label>
        <Textarea
          value={meta.description}
          onChange={(e) => update({ description: e.target.value })}
          placeholder="What this workflow does"
          className="min-h-[52px] resize-none text-[13px]"
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-muted-foreground">Phases</Label>
          <Button
            size="icon"
            variant="ghost"
            className="size-5"
            onClick={() => update({ phases: [...phases, { title: `Phase ${phases.length + 1}` }] })}
            title="Add phase"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="space-y-1.5">
          {phases.length === 0 && <p className="text-[11px] text-muted-foreground">No phases declared.</p>}
          {phases.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-4 text-right text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
              <Input
                value={p.title}
                onChange={(e) => {
                  const nextPhases = phases.map((ph, idx) => (idx === i ? { ...ph, title: e.target.value } : ph))
                  update({ phases: nextPhases })
                }}
                className="h-7 text-[13px]"
              />
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => update({ phases: phases.filter((_, idx) => idx !== i) })}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
