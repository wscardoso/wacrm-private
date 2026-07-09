/**
 * Account-scoped Supabase client wrapper.
 *
 * Forces all database queries to be automatically scoped by account_id,
 * preventing data-leak vulnerabilities from forgotten `.eq('account_id', ...)` checks.
 *
 * Usage:
 *   const accountDb = createAccountScopedClient(accountId)
 *   // from() now auto-appends .eq('account_id', accountId)
 *   await accountDb.from('messages').select('*')
 *   // → WHERE account_id = <accountId>
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export interface AccountScopedClient {
  /**
   * Scoped version of db.from() that auto-appends .eq('account_id', accountId)
   */
  from<T extends string>(table: T): ReturnType<SupabaseClient['from']>

  /**
   * Scoped version of db.rpc() that auto-appends p_account_id parameter
   * Note: RPC functions should accept p_account_id as a parameter and validate it.
   */
  rpc<T = any>(
    fn: string,
    args?: Record<string, unknown>,
    options?: any,
  ): Promise<{ data: T; error: any }>

  /**
   * Access the underlying admin client for operations that can't be auto-scoped
   * (use sparingly — only for operations that explicitly handle tenancy)
   */
  unsafe_raw(): SupabaseClient
}

export function createAccountScopedClient(accountId: string): AccountScopedClient {
  const db = supabaseAdmin()

  return {
    from(table: string) {
      return db.from(table).eq('account_id', accountId)
    },

    async rpc(fn: string, args?: Record<string, unknown>, options?: any) {
      const params = { ...args, p_account_id: accountId }
      return db.rpc(fn, params, options)
    },

    unsafe_raw() {
      return db
    },
  }
}

/**
 * Type guard — checks if a client is account-scoped (vs raw admin client).
 * Use to enforce safe patterns in middleware/helpers.
 */
export function isAccountScoped(client: any): client is AccountScopedClient {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof client.from === 'function' &&
    typeof client.unsafe_raw === 'function'
  )
}
