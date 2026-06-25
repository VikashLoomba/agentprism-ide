// src/features/editor/HandlebarsPreview.tsx
import { useEffect, useMemo, useState } from 'react'
import { Eye, AlertTriangle } from 'lucide-react'
import type { Json } from '@shared/capability'
import { parsePrompt, seedSampleData } from '@shared/prompt-frontmatter'
import { createPromptEnv, registerPartial, compilePrompt } from '@shared/prompt-env'
import { useStore } from '@/store/useStore'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/**
 * Live preview: the open `.hbs` template body + editable sample JSON -> rendered
 * string. Uses the SAME createPromptEnv() factory the server uses and registers
 * the FULL partial bodies from the catalog, so the preview is byte-identical to
 * production render.
 *
 * R4: the env (built + full-body partials registered) is memoized on the catalog
 * `prompts`; the compiled template is memoized on `body` (compiled ONCE via
 * compilePrompt with PROMPT_COMPILE_OPTIONS). A `sampleText` keystroke only
 * re-runs the precompiled delegate — it never rebuilds the env, re-registers
 * partials, or recompiles the template.
 */
export function HandlebarsPreview() {
  const source = useStore((s) => s.source) // the open .hbs text
  const prompts = useStore((s) => s.prompts) // PromptCatalogEntry[]

  const { params, body, error: fmError } = useMemo(() => parsePrompt(source), [source])

  // Seed the editable sample JSON from the declared params whenever the param
  // set changes (example ?? default ?? type-derived placeholder).
  const [sampleText, setSampleText] = useState('')
  useEffect(() => {
    setSampleText(JSON.stringify(seedSampleData(params), null, 2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params)])

  // R4: env built + full-body partials registered ONCE per catalog change.
  const env = useMemo(() => {
    const e = createPromptEnv()
    for (const entry of prompts) {
      if (entry.body) registerPartial(e, entry.name, entry.body) // FULL bodies — render parity
    }
    return e
  }, [prompts])

  // R4: compile the open template body ONCE per body change (compile errors land
  // here, surfaced inline). Returns the bound render delegate or a compile error.
  const compiled = useMemo<{ render: ((data: Json) => string) | null; error: string | null }>(() => {
    try {
      return { render: compilePrompt(env, body), error: null }
    } catch (err) {
      return { render: null, error: err instanceof Error ? err.message : String(err) }
    }
  }, [env, body])

  // Render runs on every `sampleText` keystroke against the PRECOMPILED template.
  const { output, error: renderError } = useMemo(() => {
    if (!compiled.render) return { output: '', error: null as string | null }
    let data: Json
    try {
      data = JSON.parse(sampleText || '{}') as Json
    } catch (err) {
      return { output: '', error: err instanceof Error ? err.message : String(err) }
    }
    try {
      return { output: compiled.render(data), error: null as string | null }
    } catch (err) {
      return { output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }, [compiled, sampleText])

  const error = fmError ?? compiled.error ?? renderError

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[12px] text-foreground/90">
        <Eye className="size-3.5 text-primary" /> Preview
        <span className="ml-auto text-[10px] text-muted-foreground">rendered identically to production</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            sample data <span className="text-muted-foreground/60">(JSON, seeded from declared params)</span>
          </Label>
          <Textarea
            value={sampleText}
            onChange={(e) => setSampleText(e.target.value)}
            placeholder="{}"
            className="min-h-[80px] resize-none font-mono text-[12px]"
            spellCheck={false}
          />
        </div>

        {error && (
          <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span className="font-mono leading-snug break-all">{error}</span>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <Label className="mb-1 text-[11px] text-muted-foreground">output</Label>
          <pre
            className={cn(
              'min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-muted/30 px-2.5 py-2',
              'font-mono text-[12px] leading-snug whitespace-pre-wrap break-words',
              error && 'opacity-50',
            )}
          >
            {output}
          </pre>
        </div>
      </div>
    </div>
  )
}
