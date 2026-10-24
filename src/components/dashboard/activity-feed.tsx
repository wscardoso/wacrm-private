"use client"

import Link from 'next/link'
import { useState } from 'react'
import {
  MessageSquare,
  UserPlus,
  Briefcase,
  Radio,
  Zap,
  Inbox,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { EmptyState, ErrorState } from './empty-state'
import { Skeleton } from './skeleton'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
  error?: boolean
  onRetry?: () => void
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

interface KindTheme {
  icon: ComponentType<{ className?: string }>
  /** Tailwind classes for the round icon badge + label color. */
  badge: string
}

const KIND_THEME: Record<ActivityKind, KindTheme> = {
  // Conversation-side events carry the accent; outbound machinery
  // (broadcasts, automations) stays neutral so the feed reads calm.
  message: { icon: MessageSquare, badge: 'bg-primary-soft text-primary' },
  contact: { icon: UserPlus, badge: 'bg-primary-soft text-primary' },
  deal: { icon: Briefcase, badge: 'bg-primary-soft text-primary' },
  broadcast: { icon: Radio, badge: 'bg-muted text-muted-foreground' },
  automation: { icon: Zap, badge: 'bg-muted text-muted-foreground' },
}

export function ActivityFeed({ items, loading, error, onRetry }: ActivityFeedProps) {
  // Start at 5 — a quick scan of the most recent events without
  // dominating vertical real estate. User expands explicitly via the
  // footer control when they want deeper history.
  const [pageSize, setPageSize] = useState<PageSize>(5)
  const t = useTranslations('dashboard')
  const locale = useLocale()

  const totalLoaded = items?.length ?? 0
  const visible = items?.slice(0, pageSize) ?? []
  // A size option is "useful" if picking it would reveal rows the
  // smaller option doesn't already show. With PAGE_SIZES=[5,10,20,50]:
  // "10" is useful only once we've loaded ≥6 items, "20" once ≥11, etc.
  // The smallest option is always enabled.
  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <section className="rounded-xl border border-border bg-card shadow-xs">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('recent_activity')}</h2>
        <Link
          href="/inbox"
          className="rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary-soft"
        >
          {t('view_all')} →
        </Link>
      </header>

      {loading ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : error || !items ? (
        <div className="p-5">
          <ErrorState onRetry={() => onRetry?.()} />
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Inbox}
            title={t('no_activity')}
            hint={t('no_activity_hint')}
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {visible.map((it) => {
              const theme = KIND_THEME[it.kind]
              const Icon = theme.icon
              const row = (
                <div className="flex items-center gap-3 px-5 py-3">
                  <span
                    className={cn(
                      'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full',
                      theme.badge,
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {activityText(it, t)}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                    {relativeTime(it.at, locale)}
                  </span>
                </div>
              )
              return (
                <li key={it.id} className="transition-colors hover:bg-muted/40">
                  {it.href ? (
                    <Link href={it.href} className="block">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              )
            })}
          </ul>
          <footer className="flex items-center justify-between border-t border-border px-5 py-3 text-xs">
            <span className="text-muted-foreground tabular-nums">
              {t('showing', {
                shown: visible.length,
                total: `${totalLoaded}${totalLoaded === 50 ? '+' : ''}`,
              })}
            </span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground">{t('show')}</span>
              {PAGE_SIZES.map((size, i) => {
                const disabled = !isSizeUseful(size, i)
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setPageSize(size)}
                    disabled={disabled}
                    className={cn(
                      'rounded-md px-2 py-1 font-medium tabular-nums transition-colors',
                      pageSize === size
                        ? 'bg-primary-soft text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                    )}
                  >
                    {size}
                  </button>
                )
              })}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

type DashboardT = ReturnType<typeof useTranslations<'dashboard'>>

/** Localized feed line. Items carry a message key + values; values
 *  shaped `{ tKey }` are themselves translated (fallback labels,
 *  broadcast status). Unknown status keys fall back to the raw value
 *  rather than surfacing a missing-key string. */
function activityText(it: ActivityItem, t: DashboardT): string {
  if (!it.message) return it.text
  const values: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(it.message.values)) {
    values[k] =
      typeof v === 'object'
        ? t.has(v.tKey)
          ? t(v.tKey)
          : v.tKey.replace(/^broadcast_status_/, '')
        : v
  }
  return t.has(it.message.key) ? t(it.message.key, values) : it.text
}

function relativeTime(iso: string, locale: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  if (diffSec < 60) return rtf.format(-Math.max(1, diffSec), 'second')
  if (diffSec < 3600) return rtf.format(-Math.floor(diffSec / 60), 'minute')
  if (diffSec < 86400) return rtf.format(-Math.floor(diffSec / 3600), 'hour')
  if (diffSec < 2_592_000) return rtf.format(-Math.floor(diffSec / 86400), 'day')
  return new Date(iso).toLocaleDateString(locale)
}
