"use client"

import { Clock } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState, ErrorState } from './empty-state'
import { Skeleton } from './skeleton'

interface ResponseTimeChartProps {
  data: ResponseTimeSummary | null
  loading: boolean
  /** Minutes. Surfaced as a "target" pill in the header. The
   *  hand-rolled SVG version drew this as a horizontal dashed
   *  line on the chart; Tremor BarChart doesn't expose Recharts
   *  primitives, so we promote it to the header for now. A
   *  follow-up can introduce an overlay or extend the vendored
   *  BarChart with a `referenceLines` prop. */
  thresholdMinutes?: number
  error?: boolean
  onRetry?: () => void
}

// Single category, single colour — the data is "average minutes
// per weekday". Tremor expects categories as the second tuple in
// the row object, so we shape the buckets into
// `{ day: 'seg', 'Média (min)': 4.2 }` rows below. The category name
// doubles as the tooltip label, so it comes from the translations.

// 2024-01-01 was a Monday — a fixed anchor for locale weekday names in
// the buckets' Monday-first order.
function weekdayLabel(index: number, locale: string): string {
  return new Date(2024, 0, 1 + index).toLocaleDateString(locale, { weekday: 'short' })
}

export function ResponseTimeChart({
  data,
  loading,
  thresholdMinutes = 5,
  error,
  onRetry,
}: ResponseTimeChartProps) {
  const t = useTranslations('dashboard')
  const locale = useLocale()
  const CATEGORY = t('response_avg_minutes')
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false

  // Map buckets → Tremor rows. Null `avgMinutes` (no samples)
  // collapses to 0; the chart will render an empty slot for it.
  // We attach `samples` on the row so a future customTooltip can
  // surface "no samples" copy without losing the data shape.
  const chartData =
    data?.buckets.map((b, i) => ({
      day: weekdayLabel(i, locale),
      [CATEGORY]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? []

  return (
    <section className="rounded-xl border border-border bg-card shadow-xs">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t('response_title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('response_desc')}
          </p>
        </div>
        <div className="flex items-center gap-3 text-right text-xs">
          {thresholdMinutes > 0 && (
            <span className="rounded-full border border-highlight/50 bg-highlight/15 px-2 py-0.5 font-medium text-foreground tabular-nums">
              {t('response_target', { minutes: thresholdMinutes })}
            </span>
          )}
          {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) && (
            <div>
              <div className="text-muted-foreground">
                {t('this_week')}{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {fmt(data.thisWeekAvg)}
                </span>
              </div>
              <div className="text-muted-foreground">
                {t('last_week')}{' '}
                <span className="tabular-nums">{fmt(data.lastWeekAvg)}</span>
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="p-5">
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : error || !data ? (
          <ErrorState onRetry={() => onRetry?.()} />
        ) : !hasData ? (
          <EmptyState
            icon={Clock}
            title={t('no_replies')}
            hint={t('no_replies_hint')}
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[CATEGORY]}
            // 'primary' maps to `fill-chart-1` — the active theme's
            // accent, so the bars follow the theme picker.
            colors={['primary']}
            valueFormatter={(value) => `${value.toFixed(1)}m`}
            showLegend={false}
            yAxisWidth={48}
            // Compact height so the chart sits well inside the card
            // without dominating the row alongside the donut + activity feed.
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}

function fmt(mins: number | null): string {
  if (mins == null) return '—'
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))}s`
  if (mins < 60) return `${mins.toFixed(1)}m`
  return `${(mins / 60).toFixed(1)}h`
}
