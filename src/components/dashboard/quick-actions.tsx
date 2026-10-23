"use client"

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap, ArrowUpRight } from 'lucide-react'
import type { ComponentType } from 'react'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
}

export function QuickActions() {
  const t = useTranslations("dashboard")
  const ACTIONS: Action[] = [
    { label: t("new_contact"), href: '/contacts', icon: UserPlus },
    { label: t("new_deal"), href: '/pipelines', icon: Briefcase },
    { label: t("new_broadcast"), href: '/broadcasts/new', icon: Radio },
    { label: t("new_automation"), href: '/automations/new', icon: Zap },
  ]
  return (
    <section aria-label={t("quick_actions")}>
      <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t("quick_actions")}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {ACTIONS.map((a) => {
          const Icon = a.icon
          return (
            <Link
              key={a.href}
              href={a.href}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs transition-colors hover:border-primary/40 hover:bg-primary-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <Icon className="h-4 w-4" />
              </div>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {a.label}
              </span>
              <ArrowUpRight
                className="hidden h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 sm:block"
                aria-hidden
              />
            </Link>
          )
        })}
      </div>
    </section>
  )
}
