-- ============================================================
-- 040_filter_contacts_by_tags_tenant_scope.sql
-- P2.1 Lote 0.1 — explicit tenant scope on the existing
-- public.filter_contacts_by_tags() RPC.
--
-- Why this change
--
--   As built in 025, filter_contacts_by_tags() relies solely on RLS
--   (SECURITY INVOKER + is_account_member / can_access_account) to
--   scope results. For a *member* that is correct: RLS permits exactly
--   their own account. But for a *platform operator* authorized for
--   several tenants, RLS returns the UNION of every supervised tenant
--   (the same cross-tenant leak P1b.2 fixed for the inbox). The Contacts
--   page under /act/[accountId] must show ONLY the active tenant.
--
--   This migration adds an OPTIONAL p_account_id argument. When omitted
--   (the entire existing member call path) behavior is byte-for-byte
--   preserved: RLS alone scopes to the caller's account. When supplied,
--   the query adds an explicit contacts.account_id = p_account_id filter
--   on top of RLS, so the operator's result is narrowed to the active
--   tenant. The realtime/URL never authorizes — can_access_account() in
--   RLS is the gate; the explicit filter is defense-in-depth that also
--   produces the correct single-tenant count and page.
--
-- What is preserved (contract invariants)
--
--   * SECURITY INVOKER — the function runs as the caller; no privilege
--     bypass. RLS on contacts / contact_tags remains the security
--     boundary (unchanged).
--   * SET search_path = public.
--   * Signature + behavior when p_account_id IS NULL: identical to 025.
--   * Ordering (created_at DESC, id), LIMIT/OFFSET pagination, the
--     name/phone/email search, and the full-match total_count are all
--     untouched.
--   * No INSERT/UPDATE/DELETE policy is modified; 038 is not altered.
--
-- Idempotent — safe to run multiple times. NOTE: because the parameter
-- list changes (a new optional p_account_id is added), this is NOT a
-- drop-in CREATE OR REPLACE of the 025 signature — Postgres would keep
-- both as separate overloads and a single-arg call (p_tag_ids only)
-- would become ambiguous. We therefore DROP the old 4-arg signature
-- before (re)creating the new 5-arg one. Members calling with only
-- p_tag_ids still resolve to the single remaining overload via defaults.
--
-- Parameter order: p_account_id is appended LAST, after every 025
-- parameter, rather than inserted in the middle. The sole production
-- call site (Contacts page) invokes this RPC with named parameters
-- (PostgREST resolves .rpc() JSON-object bodies by name, not position),
-- so position never mattered for that caller — but appending at the end
-- is the safer convention regardless: it keeps the 025 parameter order
-- byte-for-byte stable for any positional caller (raw SQL, another
-- function, a future script) that predates this migration, instead of
-- silently shifting p_search/p_limit/p_offset one slot to the right.
-- ============================================================

DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_account_id UUID DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    -- Distinct contacts having ANY of the selected tags (OR),
    -- narrowed by the same name/phone/email search as the list.
    -- P2.1 Lote 0.1: when p_account_id is supplied, scope explicitly
    -- to that tenant on top of RLS (operator multi-tenant path). When
    -- NULL (member path / default) this condition is a no-op, so the
    -- 025 behavior is preserved exactly.
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (p_account_id IS NULL OR c.account_id = p_account_id)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    -- count(*) OVER() is evaluated before LIMIT, so it is the full
    -- match total regardless of the page being returned.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, UUID) TO authenticated;
