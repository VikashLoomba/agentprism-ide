import { ShieldQuestion } from 'lucide-react'
import { useStore } from '@/store/useStore'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function PermissionDialog() {
  const permission = useStore((s) => s.permission)
  const respond = useStore((s) => s.respondPermission)

  return (
    <Dialog
      open={!!permission}
      onOpenChange={(open) => {
        if (!open) respond({ kind: 'cancelled' })
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestion className="size-4 text-info" />
            Permission requested
          </DialogTitle>
          <DialogDescription>
            {permission?.agentLabel ? <b>{permission.agentLabel}</b> : 'An agent'} wants to run:{' '}
            <span className="font-medium text-foreground">{permission?.toolTitle}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {permission?.options.map((o) => (
            <Button
              key={o.optionId}
              variant={o.kind?.startsWith('allow') ? 'default' : 'outline'}
              onClick={() => respond({ kind: 'selected', optionId: o.optionId })}
            >
              {o.name}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => respond({ kind: 'cancelled' })}>
            Cancel turn
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
