import { AlertTriangle, BarChart3 } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared empty-state panel for charts that can't render meaningfully
 * without a minimum amount of data. Kept minimal and uniform so the
 * three empty states on the dashboard don't each feel like a
 * different widget.
 */
export function EmptyState({
  title = 'Not enough data yet',
  hint,
  icon: Icon = BarChart3,
  className,
  action,
}: {
  title?: string
  hint?: string
  icon?: ComponentType<{ className?: string }>
  className?: string
  /** Optional retry button (or any action) rendered below the hint —
   *  used by the error variant of this panel so a failed fetch isn't
   *  a dead end indistinguishable from a genuinely empty result. */
  action?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  )
}

/**
 * Widget-level fetch failure — used in place of EmptyState's default
 * "no data" copy so a real error (RLS glitch, bad RPC, network blip)
 * can't be misread as "this account genuinely has nothing here yet".
 * Every dashboard widget's failed-fetch branch renders this instead
 * of silently falling through to the empty-state copy.
 */
export function ErrorState({ onRetry, className }: { onRetry: () => void; className?: string }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Couldn't load this"
      hint="Something went wrong fetching this data."
      className={className}
      action={
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          Try again
        </button>
      }
    />
  )
}
