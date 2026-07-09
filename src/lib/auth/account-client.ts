import { supabaseAdmin } from '@/lib/flows/admin-client'

export interface AccountScopedClient {
  from(table: string): unknown
  rpc(fn: string, args?: Record<string, unknown>, options?: Record<string, unknown>): unknown
  unsafe_raw(): ReturnType<typeof supabaseAdmin>
}

export function createAccountScopedClient(accountId: string): AccountScopedClient {
  const db = supabaseAdmin()

  return {
    from(table: string) {
      return (db.from(table) as any).eq('account_id', accountId)
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

export function isAccountScoped(client: unknown): client is AccountScopedClient {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as Record<string, unknown>).from === 'function' &&
    typeof (client as Record<string, unknown>).unsafe_raw === 'function'
  )
}