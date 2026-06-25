import { useEffect, useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { useStore } from '@/store/useStore'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Mid-run human-in-the-loop input prompt. Mirrors PermissionDialog but drives
 * off s.input / respondInput. Closing the dialog (Esc / overlay) cancels the
 * request, exactly like a permission turn. Three kinds:
 *  - 'confirm' → Yes/No (value: boolean)
 *  - 'select'  → one button per { id, label } option (value: id)
 *  - 'input'   → free-text Input + submit (value: string)
 */
export function InputDialog() {
  const input = useStore((s) => s.input)
  const respond = useStore((s) => s.respondInput)
  const [value, setValue] = useState('')

  // Seed/reset the text field whenever a new 'input' request arrives.
  useEffect(() => {
    if (input?.kind === 'input') {
      setValue(input.default != null ? String(input.default) : '')
    }
  }, [input])

  return (
    <Dialog
      open={!!input}
      onOpenChange={(open) => {
        if (!open) respond({ kind: 'cancelled' })
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleQuestion className="size-4 text-info" />
            Input requested
          </DialogTitle>
          <DialogDescription className="font-medium text-foreground">
            {input?.prompt}
          </DialogDescription>
        </DialogHeader>

        {input?.kind === 'confirm' && (
          <div className="flex flex-col gap-2">
            <Button onClick={() => respond({ kind: 'value', value: true })}>Yes</Button>
            <Button variant="outline" onClick={() => respond({ kind: 'value', value: false })}>
              No
            </Button>
            <Button variant="ghost" onClick={() => respond({ kind: 'cancelled' })}>
              Cancel
            </Button>
          </div>
        )}

        {input?.kind === 'select' && (
          <div className="flex flex-col gap-2">
            {input.options?.map((o) => (
              <Button
                key={o.id}
                variant="outline"
                onClick={() => respond({ kind: 'value', value: o.id })}
              >
                {o.label}
              </Button>
            ))}
            <Button variant="ghost" onClick={() => respond({ kind: 'cancelled' })}>
              Cancel
            </Button>
          </div>
        )}

        {input?.kind === 'input' && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              respond({ kind: 'value', value })
            }}
          >
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="font-mono text-[12px]"
            />
            <div className="flex gap-2">
              <Button type="submit" className="flex-1">
                Submit
              </Button>
              <Button type="button" variant="ghost" onClick={() => respond({ kind: 'cancelled' })}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
