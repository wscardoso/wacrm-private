-- ============================================================
-- 033_lead_attribution.sql — Click-to-WhatsApp lead attribution (P0)
--
-- Implements ADR-ATTR-001 §3 / §8. Captures the native Meta `referral`
-- object (Click-to-WhatsApp ads) on the first inbound message of a
-- conversation and persists it as a canonical attribution record.
--
-- Design (see ADR-ATTR-001 for full context)
--
--   - `lead_attributions` is the canonical destination for BOTH
--     capture sources: Fonte A (native Meta `referral`, this
--     migration) and Fonte B (tracked links, future migration).
--     `source_channel` distinguishes them.
--   - Granularity is per-CONVERSATION (multi-touch): each conversation
--     points at the attribution that opened it via
--     `conversations.attribution_id`.
--   - `contacts.first_attribution_id` is the first-touch, written
--     once and never overwritten — enforced at the application layer
--     (webhook only sets it when NULL), not by a DB trigger, to keep
--     this migration additive and low-risk.
--   - Enrichment (campaign/adset/ad names, placement, creative) is
--     deliberately nullable here — filled in asynchronously by a
--     later Marketing API job (P1). The webhook never blocks on it.
--
-- Visibility
--
--   Any account member may read their account's attributions
--   (`is_account_member`). No client INSERT/UPDATE/DELETE policy
--   exists — all writes come from the Meta webhook via
--   `supabaseAdmin()` (service role, bypasses RLS), matching the
--   pattern used by `member_presence` (migration 024).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- LEAD_ATTRIBUTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_attributions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE CASCADE,

  source_channel    TEXT NOT NULL CHECK (source_channel IN (
                       'ctwa_meta', 'tracked_link', 'organic', 'unknown'
                     )),

  -- The wamid of the inbound message that carried this referral —
  -- the idempotency key for Fonte A (see unique index below).
  -- `ctwa_clid` is NOT used for that purpose: Meta doesn't guarantee
  -- it on every referral shape (e.g. organic posts / some ad units
  -- can omit it), and Postgres unique indexes never treat two NULLs
  -- as colliding — a replayed webhook with a NULL ctwa_clid would
  -- have inserted a duplicate row every time.
  origin_message_id TEXT,

  -- Raw capture — Fonte A (referral) or Fonte B (click), whichever
  -- source_channel applies.
  ad_source_id      TEXT,
  ad_source_type    TEXT,
  ad_source_url     TEXT,
  ad_headline       TEXT,
  ad_body           TEXT,
  ad_media_type     TEXT,
  ad_media_url      TEXT,
  ctwa_clid         TEXT,
  fbclid            TEXT,
  gclid             TEXT,
  utm               JSONB,

  -- Enriched via Marketing API — P1, async, nullable until filled.
  campaign_id       TEXT,
  campaign_name     TEXT,
  adset_id          TEXT,
  adset_name        TEXT,
  ad_id             TEXT,
  ad_name           TEXT,
  placement         TEXT,
  enriched_at       TIMESTAMPTZ,

  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_attr_conversation
  ON lead_attributions(conversation_id);

CREATE INDEX IF NOT EXISTS idx_lead_attr_contact
  ON lead_attributions(contact_id);

CREATE INDEX IF NOT EXISTS idx_lead_attr_account_created
  ON lead_attributions(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_attr_ctwa
  ON lead_attributions(ctwa_clid) WHERE ctwa_clid IS NOT NULL;

-- Idempotency key for Fonte A: one attribution row per inbound
-- message. A replayed webhook delivery (Meta retries on timeout, or
-- redelivery after a 5xx) carries the same wamid, so
-- `INSERT ... ON CONFLICT (origin_message_id) DO NOTHING` makes
-- reprocessing a no-op instead of creating a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_attr_origin_message_unique
  ON lead_attributions(origin_message_id)
  WHERE origin_message_id IS NOT NULL;

ALTER TABLE lead_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_attributions_select ON lead_attributions;
CREATE POLICY lead_attributions_select ON lead_attributions FOR SELECT
  USING (is_account_member(account_id));

-- ============================================================
-- CONTACTS — first-touch (immutable once set)
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS first_attribution_id UUID
    REFERENCES lead_attributions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_source_channel TEXT;

-- ============================================================
-- CONVERSATIONS — pointer to the attribution that opened it
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS attribution_id UUID
    REFERENCES lead_attributions(id) ON DELETE SET NULL;
