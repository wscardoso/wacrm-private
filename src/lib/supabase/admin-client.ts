import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Lazy, process-wide service-role Supabase client.
 *
 * Use this wherever RLS must be bypassed (webhook processing,
 * cross-account lookups, engine work). Never expose this client
 * to browser code or pass it to untrusted callers.
 *
 * Single-instance VPS: one shared client per process is fine.
 * Multi-instance / serverless: the singleton still works — each
 * process keeps its own copy, which is correct because the client
 * is stateless (no local cache, no open socket that survives a
 * cold-start boundary).
 */
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
