-- ============================================================
-- 035_inbound_idempotency_rpcs.sql — C4: idempotent insert RPCs
--
-- Replaces the application-level `.upsert({ onConflict })` calls in both
-- inbound pipelines with server-side RPCs that use an explicit
--   ON CONFLICT (...) WHERE <partial predicate> DO NOTHING
-- RETURNING id
--
-- Why an RPC instead of supabase-js upsert: supabase-js translates
-- `ignoreDuplicates: true` + `onConflict: 'col'` into
--   ON CONFLICT (col) DO NOTHING
-- WITHOUT the partial-index predicate. Against a PARTIAL unique index
-- that yields Postgres error 42P10 ("ON CONFLICT DO NOTHING" requires
-- a unique index with matching conflict columns). Supplying the WHERE
-- clause explicitly — which only a raw SQL function can do — resolves it.
--
-- `insert_inbound_message` is intentionally minimal: it ONLY persists the
-- inbound message idempotently and returns the new row id (or NULL on
-- redelivery). It does NOT touch unread_count, conversation metadata,
-- broadcast flags, attribution, flows, or automations — those remain
-- gated in the application by whether an id was returned.
--
-- `insert_lead_attribution` replaces the same anti-pattern in
-- src/lib/whatsapp/attribution.ts for the `lead_attributions`
-- `origin_message_id` partial unique index.
-- ============================================================

-- ------------------------------------------------------------
-- insert_inbound_message
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_inbound_message(
  p_conversation_id UUID,
  p_sender_type TEXT,
  p_content_type TEXT,
  p_content_text TEXT,
  p_media_url TEXT,
  p_message_id TEXT,
  p_status TEXT,
  p_created_at TIMESTAMPTZ,
  p_reply_to_message_id UUID,
  p_interactive_reply_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO messages (
    conversation_id,
    sender_type,
    content_type,
    content_text,
    media_url,
    message_id,
    status,
    created_at,
    reply_to_message_id,
    interactive_reply_id
  )
  VALUES (
    p_conversation_id,
    p_sender_type,
    p_content_type,
    p_content_text,
    p_media_url,
    p_message_id,
    p_status,
    p_created_at,
    p_reply_to_message_id,
    p_interactive_reply_id
  )
  ON CONFLICT (conversation_id, message_id)
    WHERE sender_type = 'customer'
      AND message_id IS NOT NULL
      AND message_id <> ''
  DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id; -- NULL when the row already existed (redelivery)
END $$;

REVOKE ALL ON FUNCTION insert_inbound_message(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION insert_inbound_message(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION insert_inbound_message(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT
) FROM authenticated;
GRANT EXECUTE ON FUNCTION insert_inbound_message(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT
) TO service_role;

-- ------------------------------------------------------------
-- insert_lead_attribution
--   Idempotent on origin_message_id (partial unique index from 033).
--   Returns the new row id, or NULL on redelivery (conflict).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_lead_attribution(
  p_account_id UUID,
  p_contact_id UUID,
  p_conversation_id UUID,
  p_source_channel TEXT,
  p_origin_message_id TEXT,
  p_ad_source_id TEXT,
  p_ad_source_type TEXT,
  p_ad_source_url TEXT,
  p_ad_headline TEXT,
  p_ad_body TEXT,
  p_ad_media_type TEXT,
  p_ad_media_url TEXT,
  p_ctwa_clid TEXT,
  p_fbclid TEXT,
  p_gclid TEXT,
  p_utm JSONB,
  p_campaign_id TEXT,
  p_campaign_name TEXT,
  p_adset_id TEXT,
  p_adset_name TEXT,
  p_ad_id TEXT,
  p_ad_name TEXT,
  p_placement TEXT,
  p_raw JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO lead_attributions (
    account_id,
    contact_id,
    conversation_id,
    source_channel,
    origin_message_id,
    ad_source_id,
    ad_source_type,
    ad_source_url,
    ad_headline,
    ad_body,
    ad_media_type,
    ad_media_url,
    ctwa_clid,
    fbclid,
    gclid,
    utm,
    campaign_id,
    campaign_name,
    adset_id,
    adset_name,
    ad_id,
    ad_name,
    placement,
    raw
  )
  VALUES (
    p_account_id,
    p_contact_id,
    p_conversation_id,
    p_source_channel,
    p_origin_message_id,
    p_ad_source_id,
    p_ad_source_type,
    p_ad_source_url,
    p_ad_headline,
    p_ad_body,
    p_ad_media_type,
    p_ad_media_url,
    p_ctwa_clid,
    p_fbclid,
    p_gclid,
    p_utm,
    p_campaign_id,
    p_campaign_name,
    p_adset_id,
    p_adset_name,
    p_ad_id,
    p_ad_name,
    p_placement,
    p_raw
  )
  ON CONFLICT (origin_message_id)
    WHERE origin_message_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id; -- NULL on redelivery / duplicate origin_message_id
END $$;

REVOKE ALL ON FUNCTION insert_lead_attribution(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION insert_lead_attribution(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION insert_lead_attribution(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION insert_lead_attribution(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, JSONB
) TO service_role;
