# SKILL.md — wacrm

> Self-hostable CRM template for WhatsApp Business — fork it, brand it, host it.

---

## Objective

Provide a production-ready, self-hosted CRM layer on top of WhatsApp Business (Meta Cloud API). Teams get a shared inbox, contact management, sales pipelines, broadcast campaigns, and a no-code automation builder — all in a single Next.js application backed by Supabase.

The template is intentionally a starting point, not a locked product. Fork it, remove what you don't need, add what your team does.

---

## Inputs

| Input | Source | Description |
|---|---|---|
| Inbound WhatsApp messages | Meta Cloud API webhook (`POST /api/webhook`) | Text, media, interactive replies from contacts |
| Agent actions | Next.js UI | Reply, assign, tag, note, close conversation |
| Contact data | CSV import or manual entry | Name, phone, custom fields |
| Broadcast template | UI | Meta-approved message template + recipient list |
| Automation trigger | Rule engine | Keyword match, inbound message, schedule, new contact |

---

## Outputs

| Output | Destination | Description |
|---|---|---|
| WhatsApp messages | Meta Cloud API (`POST /messages`) | Agent replies and broadcast deliveries |
| CRM records | Supabase (Postgres) | Contacts, conversations, deals, notes, tags |
| Webhook events | External URLs (user-configured) | Automation webhook actions to third-party services |
| Real-time UI updates | Browser (Supabase Realtime) | Live inbox, dashboard metrics, activity feed |
| API responses | `/api/v1` (REST) | Programmatic access for external integrations |

---

## Tools

- **Supabase** — Postgres database, Auth, Storage, Realtime, Row Level Security
- **WhatsApp Business API** — Meta Cloud API (official), webhook ingestion and message delivery
- **Next.js 16** — App Router, Server Actions, API Routes, ISR
- **Docker** — containerised deployment (optional; Hostinger managed Node.js is the recommended path)
- **GitHub Actions** — CI pipeline (typecheck + build on every PR)

---

## Dependencies

### Runtime
```
next, react, react-dom              — App framework
@supabase/supabase-js, @supabase/ssr — Database + Auth client
@xyflow/react, @dagrejs/dagre       — Visual automation builder
@dnd-kit/core, @dnd-kit/sortable    — Drag-and-drop pipeline board
recharts                            — Dashboard charts
lucide-react                        — Icon set
date-fns                            — Date formatting
opus-recorder                       — In-browser audio recording
class-variance-authority, clsx, tailwind-merge — Styling utilities
sonner                              — Toast notifications
shadcn                              — Component library base
```

### Dev
```
typescript, @types/node, @types/react, @types/react-dom
tailwindcss, @tailwindcss/postcss, tw-animate-css
eslint, eslint-config-next
prettier, prettier-plugin-tailwindcss
vitest                              — Unit test runner
```

---

## Security Primitives

- **AES-256-GCM** — WhatsApp token encryption at rest (`src/lib/encryption.ts`)
- **HMAC-SHA256** — Webhook signature verification for all Meta payloads (`src/lib/webhook-signature.ts`)
- **RLS on every table** — Supabase Row Level Security; all queries are account-scoped
- **CSP + rate limiting** — Applied at the Next.js middleware layer
- **Scoped API keys** — `/api/v1` access tokens are revocable and permission-scoped

---

## Workflow

```
1. RECEIVE
   Meta sends POST /api/webhook
   → HMAC signature verified
   → Payload parsed (message / status / error)

2. STORE
   Conversation upserted in Supabase
   Contact created or matched by phone
   Message record inserted

3. NOTIFY
   Supabase Realtime broadcasts to connected agents
   Inbox updates live without polling

4. RESPOND
   Agent types reply in shared inbox UI
   OR automation rule fires (keyword / schedule / webhook)
   → POST /messages to Meta Cloud API
   → Status tracked (sent → delivered → read)

5. PIPELINE
   Agent drags conversation to deal stage
   Deal linked to contact and conversation history

6. BROADCAST
   Marketing creates campaign with Meta-approved template
   Recipients selected from contact list
   Delivery + read rates tracked per recipient
```

---

## Multi-tenant Notes

Each installation is **account-scoped** — one Supabase project, one WhatsApp Business number, one team. For multi-tenant deployments (multiple clients on one codebase), add a `tenant_id` column to all tables and enforce it via RLS policies. The existing RLS pattern in `supabase/migrations/` is the correct template to extend.

---

## Deployment

Recommended: **Hostinger Managed Node.js** — connect fork, set env vars in hPanel, push to `main`.

Alternative: any Node.js host (Vercel, Railway, self-hosted VPS). Docker support included.

Required env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `META_APP_SECRET`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`.

Full setup: [wacrm.tech/docs](https://wacrm.tech/docs)

---

## Extending This Template

| Use case | Where to start |
|---|---|
| Add a custom field to contacts | `supabase/migrations/` + `src/app/(dashboard)/contacts/` |
| Add an automation action type | `src/lib/automations/` + automation builder UI |
| Swap WhatsApp provider (e.g. Zapi) | `src/lib/whatsapp/` — replace the Meta API adapter |
| Add a new pipeline stage | `src/app/(dashboard)/pipelines/` |
| Expose a new public API endpoint | `src/app/api/v1/` |

---

## Score Improvement Targets (SkillForge)

| Dimension | Before | Target | Action |
|---|---|---|---|
| Documentação | 6.0 | 8.5 | ✅ Add this SKILL.md |
| Testes | 1.0 | 7.0 | Add unit tests for `encryption.ts` + `webhook-signature.ts` |
| Reuso | 5.0 | 7.0 | Add GitHub topics: `whatsapp`, `crm`, `nextjs`, `supabase`, `self-hosted` |
| Arquitetura | 5.0 | 6.5 | Document module boundaries in `docs/architecture.md` |
| Tração | 0.0 | 0.0 | Not a priority (internal use) |

---

*SKILL.md — wscardoso/wacrm fork*
*Generated with SkillForge assistance — 30/jun/2026*
