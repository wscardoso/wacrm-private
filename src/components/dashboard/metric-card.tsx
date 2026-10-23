import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle }: MetricCardProps) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="flex items-center justify-between gap-3">
        {/* Eyebrow label — small caps in the accent, the same rhythm
            the brand reports use above every figure. */}
        <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          {title}
        </p>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-4 text-[30px] leading-none font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-3 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'bg-primary-soft text-primary'
      : sign < 0
      ? 'bg-destructive/10 text-destructive'
      : 'bg-muted text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className="mt-3">
      <span
        className={cn(
          'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
          tone,
        )}
      >
        <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate tabular-nums">{label}</span>
      </span>
    </div>
  )
}
