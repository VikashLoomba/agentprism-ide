import { useState } from 'react'
import { SlidersHorizontal, ChevronDown, RotateCcw } from 'lucide-react'
import { methodsWithConfig, methodJsonSchema } from '@shared/dsl-registry'
import { useStore } from '@/store/useStore'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface JsonProp {
  type?: string
  default?: unknown
  description?: string
  minimum?: number
  maximum?: number
  items?: { type?: string }
}

const MULTILINE_KEYS = new Set(['instruction', 'rubric'])

const METHODS = methodsWithConfig()

/** A single config field, rendered from its JSON-Schema property. */
function Field({ method, name, prop }: { method: string; name: string; prop: JsonProp }) {
  const override = useStore((s) => s.methodConfig[method]?.[name])
  const scriptVal = useStore((s) => s.validation.meta?.config?.[method]?.[name])
  const setMethodConfig = useStore((s) => s.setMethodConfig)
  const clearMethodConfigField = useStore((s) => s.clearMethodConfigField)

  const value = override ?? scriptVal ?? prop.default
  const fromScript = override === undefined && scriptVal !== undefined

  const labelEl = (
    <Label className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={prop.description}>
      <span className="font-mono text-foreground/80">{name}</span>
      {fromScript && <span className="text-[9px] text-info">from script</span>}
    </Label>
  )

  if (prop.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-2">
        {labelEl}
        <Switch checked={!!value} onCheckedChange={(v) => setMethodConfig(method, name, v)} />
      </div>
    )
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    const step = prop.type === 'integer' ? 1 : 'any'
    return (
      <div className="space-y-1">
        {labelEl}
        <Input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={prop.minimum}
          max={prop.type === 'integer' && prop.maximum && prop.maximum > 1e6 ? undefined : prop.maximum}
          step={step}
          onChange={(e) => {
            const raw = e.target.value
            // Empty input clears just this field's override → reverts to script/default.
            if (raw === '') {
              clearMethodConfigField(method, name)
              return
            }
            let n = prop.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw)
            if (!Number.isNaN(n)) {
              if (prop.minimum != null) n = Math.max(prop.minimum, n)
              if (prop.maximum != null && prop.maximum <= 1e6) n = Math.min(prop.maximum, n)
              setMethodConfig(method, name, n)
            }
          }}
          className="h-7 w-full font-mono text-[12px]"
        />
      </div>
    )
  }

  if (prop.type === 'array') {
    const arr = Array.isArray(value) ? (value as unknown[]) : []
    return (
      <div className="space-y-1">
        {labelEl}
        <Input
          value={arr.map(String).join(', ')}
          placeholder="comma-separated"
          onChange={(e) => {
            const parts = e.target.value
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean)
            setMethodConfig(method, name, parts)
          }}
          className="h-7 w-full font-mono text-[12px]"
        />
      </div>
    )
  }

  // string (and any fallback)
  const strValue = value === undefined || value === null ? '' : String(value)
  return (
    <div className="space-y-1">
      {labelEl}
      {MULTILINE_KEYS.has(name) ? (
        <Textarea
          value={strValue}
          onChange={(e) => setMethodConfig(method, name, e.target.value)}
          className="min-h-[44px] resize-none font-mono text-[11px]"
          spellCheck={false}
        />
      ) : (
        <Input
          value={strValue}
          onChange={(e) => setMethodConfig(method, name, e.target.value)}
          className="h-7 w-full font-mono text-[12px]"
        />
      )}
    </div>
  )
}

/** Auto-generated form for tuning each configurable DSL method's defaults. */
export function MethodConfig() {
  const [open, setOpen] = useState(false)
  const methodConfig = useStore((s) => s.methodConfig)
  const resetMethodConfig = useStore((s) => s.resetMethodConfig)

  if (METHODS.length === 0) return null
  const overrideCount = Object.values(methodConfig).filter((v) => v && Object.keys(v).length > 0).length

  return (
    <div className="rounded-md border border-border/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-foreground/90 hover:text-foreground"
      >
        <SlidersHorizontal className="size-3.5 text-primary" /> Method defaults
        {overrideCount > 0 && (
          <span className="rounded bg-primary/20 px-1 text-[9px] tabular-nums text-primary">{overrideCount}</span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">tune verify, judgePanel, …</span>
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/50 px-2.5 py-2.5">
          {METHODS.map((m) => {
            const schema = methodJsonSchema(m.name)
            const props = (schema?.properties ?? {}) as Record<string, JsonProp>
            const hasOverride = !!methodConfig[m.name] && Object.keys(methodConfig[m.name]).length > 0
            return (
              <div key={m.name} className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[12px] font-semibold text-primary/90">{m.name}</span>
                  {hasOverride && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5 text-muted-foreground hover:text-destructive"
                      title="Reset to script / defaults"
                      onClick={() => resetMethodConfig(m.name)}
                    >
                      <RotateCcw className="size-3" />
                    </Button>
                  )}
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground/70">{m.summary}</p>
                <div className="space-y-2 pl-1">
                  {Object.entries(props).map(([key, prop]) => (
                    <Field key={key} method={m.name} name={key} prop={prop} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
