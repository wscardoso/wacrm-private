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

import { supabaseAdmin } from '@/lib/flows/admin-client'

type AdminClient = ReturnType<typeof supabaseAdmin>

export interface AccountScopedClient {
  from(table: string): ReturnType<AdminClient['from']>
  rpc(
    fn: string,
    args?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): ReturnType<AdminClient['rpc']>
  unsafe_raw(): AdminClient
}

export function createAccountScopedClient(accountId: string): AccountScopedClient {
  const db = supabaseAdmin()

  return {
    from(table: string) {
      return db.from(table).eq('account_id', accountId)
    },

    async rpc(fn: string, args?: Record<string, unknown>, options?: Record<string, unknown>) {
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
export function isAccountScoped(client: unknown): client is AccountScopedClient {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as Record<string, unknown>).from === 'function' &&
    typeof (client as Record<string, unknown>).unsafe_raw === 'function'
  )
}
