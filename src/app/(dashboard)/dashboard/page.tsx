"use client"

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
} from 'lucide-react'

import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { MetricCard } from '@/components/dashboard/metric-card'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { ErrorState } from '@/components/dashboard/empty-state'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

type RangeDays = 7 | 30 | 90

export default function DashboardPage() {
  const t = useTranslations("dashboard")
  const { defaultCurrency } = useAuth()
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [metricsError, setMetricsError] = useState(false)

  const [range, setRange] = useState<RangeDays>(30)
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesErrors, setSeriesErrors] = useState<Record<RangeDays, boolean>>({
    7: false,
    30: false,
    90: false,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)
  const [pipelineError, setPipelineError] = useState(false)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)
  const [responseTimeError, setResponseTimeError] = useState(false)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)
  const [activityError, setActivityError] = useState(false)

  // Each of the five widgets below fetches, retries, and fails
  // independently — a broken RPC on one (the exact 42804-class bug
  // fixed in list_platform_operators, F-UI-01) must surface as that
  // widget's own error state, never as a silent "no data yet" that's
  // indistinguishable from a genuinely empty account.

  const fetchMetrics = useCallback(() => {
    setMetricsLoading(true)
    setMetricsError(false)
    const db = createClient()
    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => {
        console.error('[dashboard] metrics failed:', err)
        setMetricsError(true)
      })
      .finally(() => setMetricsLoading(false))
  }, [])

  const fetchSeries = useCallback((r: RangeDays) => {
    setSeriesLoading(true)
    setSeriesErrors((prev) => ({ ...prev, [r]: false }))
    const db = createClient()
    void loadConversationsSeries(db, r)
      .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
      .catch((err) => {
        console.error('[dashboard] series failed:', err)
        setSeriesErrors((prev) => ({ ...prev, [r]: true }))
      })
      .finally(() => setSeriesLoading(false))
  }, [])

  const fetchPipeline = useCallback(() => {
    setPipelineLoading(true)
    setPipelineError(false)
    const db = createClient()
    void loadPipelineDonut(db)
      .then((p) => setPipeline(p))
      .catch((err) => {
        console.error('[dashboard] pipeline failed:', err)
        setPipelineError(true)
      })
      .finally(() => setPipelineLoading(false))
  }, [])

  const fetchResponseTime = useCallback(() => {
    setResponseTimeLoading(true)
    setResponseTimeError(false)
    const db = createClient()
    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => {
        console.error('[dashboard] response time failed:', err)
        setResponseTimeError(true)
      })
      .finally(() => setResponseTimeLoading(false))
  }, [])

  const fetchActivity = useCallback(() => {
    setActivityLoading(true)
    setActivityError(false)
    const db = createClient()
    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => {
        console.error('[dashboard] activity failed:', err)
        setActivityError(true)
      })
      .finally(() => setActivityLoading(false))
  }, [])

  const loadAll = useCallback(() => {
    // Kick everything off in parallel — each widget shows its own
    // skeleton/error independently, so a slow or failing query never
    // holds up the others.
    fetchMetrics()
    fetchSeries(30)
    fetchPipeline()
    fetchResponseTime()
    fetchActivity()
  }, [fetchMetrics, fetchSeries, fetchPipeline, fetchResponseTime, fetchActivity])

  useEffect(() => {
    // Mount-time fetch. The synchronous loading/error resets inside
    // loadAll's fetch* callbacks are a no-op here (initial state is
    // already loading=true/error=false) — they only matter for the
    // retry buttons, which call the same callbacks outside an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll()
  }, [loadAll])

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      fetchSeries(r)
    },
    [series, fetchSeries],
  )

  function deltaLabel(delta: number, suffix: string): string {
    if (delta === 0) return t("no_change", { suffix })
    const sign = delta > 0 ? '+' : ''
    return `${sign}${delta.toLocaleString()} ${suffix}`
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("description")}
        </p>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricsLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : metricsError || !metrics ? (
          <div className="col-span-full">
            <ErrorState onRetry={fetchMetrics} />
          </div>
        ) : (
          <>
            <MetricCard
              title={t("active_conversations")}
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(metrics.activeConversations.previous, t("delta_new_today")),
              }}
            />
            <MetricCard
              title={t("new_contacts_today")}
              value={metrics.newContactsToday.current.toLocaleString()}
              icon={UserPlus}
              delta={{
                sign:
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                label: deltaLabel(
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                  t("delta_vs_yesterday"),
                ),
              }}
            />
            <MetricCard
              title={t("open_deals_value")}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t("open_deals", { count: metrics.openDealsCount })}
            />
            <MetricCard
              title={t("messages_sent_today")}
              value={metrics.messagesSentToday.current.toLocaleString()}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  t("delta_vs_yesterday"),
                ),
              }}
            />
          </>
        )}
      </div>

      {/* Quick actions */}
      <QuickActions />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          <ConversationsChart
            series={series}
            errors={seriesErrors}
            loading={seriesLoading}
            range={range}
            onRangeChange={handleRangeChange}
            onRetry={() => fetchSeries(range)}
          />
        </div>
        <div className="h-full lg:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={pipelineLoading}
            error={pipelineError}
            onRetry={fetchPipeline}
            currency={defaultCurrency}
          />
        </div>
      </div>

      {/* Response time */}
      <ResponseTimeChart
        data={responseTime}
        loading={responseTimeLoading}
        error={responseTimeError}
        onRetry={fetchResponseTime}
      />

      {/* Activity feed */}
      <ActivityFeed
        items={activity}
        loading={activityLoading}
        error={activityError}
        onRetry={fetchActivity}
      />
    </div>
  )
}


