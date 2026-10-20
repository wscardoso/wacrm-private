-- READ-ONLY. Active send_webhook steps that safeFetch will refuse (static rules only).
-- Output is masked on purpose: scheme, host and port only. It never selects the path,
-- query string (webhook URLs often carry secrets there), headers or body_template.
WITH hooks AS (
  SELECT a.account_id, a.id AS automation_id, s.id AS step_id,
         btrim(coalesce(s.step_config->>'url', '')) AS u,
         (s.step_config ? 'headers' AND s.step_config->'headers' <> '{}'::jsonb) AS has_custom_headers
  FROM automation_steps s
  JOIN automations a ON a.id = s.automation_id
  WHERE s.step_type = 'send_webhook' AND a.is_active
), parsed AS (
  SELECT *,
    lower(substring(u from '^([A-Za-z][A-Za-z0-9+.-]*):')) AS scheme,
    lower(substring(u from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)')) AS host,
    substring(u from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?(?:\[[^\]]+\]|[^/?#:]+):([0-9]+)') AS port,
    (u ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@') AS has_userinfo
  FROM hooks
), classified AS (
  SELECT *,
    CASE
      WHEN u = '' THEN 'empty_url'
      WHEN scheme IS DISTINCT FROM 'https' THEN 'not_https'
      WHEN has_userinfo THEN 'userinfo_in_url'
      WHEN port IS NOT NULL AND port <> '443' THEN 'port_not_443'
      WHEN host IS NULL THEN 'unparseable'
      WHEN host LIKE '[%' OR host ~ '^[0-9.]+$' OR host ~ '^0x[0-9a-f]+$' THEN 'ip_literal'
      WHEN host = 'localhost' OR host LIKE '%.localhost' OR position('.' IN host) = 0 THEN 'internal_or_single_label_host'
    END AS reason
  FROM parsed
)
SELECT account_id, automation_id, step_id, reason, scheme, host, port, has_custom_headers
FROM classified
WHERE reason IS NOT NULL
ORDER BY account_id, automation_id;
-- Not detectable in SQL: a public-looking host that resolves to a private address, and
-- endpoints that answer with a 3xx. Those need a DNS/HTTP probe (out of scope here).
