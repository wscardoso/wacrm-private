import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decryptWithBindingContext } from '@/lib/whatsapp/encryption'
import type { CredentialData } from './types'

export interface ResolvedCredential {
  token: string
  status: string
  expiresAt: string | null
}

export class CredentialResolutionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'CredentialResolutionError'
  }
}

export async function resolveCredential(
  accountId: string,
): Promise<ResolvedCredential> {
  const admin = supabaseAdmin()

  const { data, error } = await admin.rpc('get_ad_account_credential', {
    p_account_id: accountId,
  })

  if (error) {
    throw new CredentialResolutionError(
      `Failed to read credential: ${error.message}`,
      'credential_db_error',
    )
  }

  const row = data as unknown as CredentialData | null

  if (!row || !row.ciphertext) {
    throw new CredentialResolutionError(
      'No credential configured for this account',
      'credential_not_found',
    )
  }

  if (row.status !== 'active') {
    throw new CredentialResolutionError(
      `Credential is ${row.status}`,
      row.status === 'expired' ? 'credential_expired' : 'credential_revoked',
    )
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    throw new CredentialResolutionError(
      'Credential token has expired',
      'credential_expired',
    )
  }

  // Binding Context per IMP-CRYPTO-001 RC1.3 §3.4/§3.5: ad_account:{accountId}.
  // ad_account_credentials is keyed 1:1 by account_id (PRIMARY KEY, migration
  // 055), so accountId is both the row's identity and the domain's BC value —
  // no INSERT-timing concern here (this path is decrypt-only, per the RPC's
  // own contract: "the enrichment job decrypts app-tier, never persists").
  let token: string
  try {
    token = decryptWithBindingContext(row.ciphertext, `ad_account:${accountId}`)
  } catch {
    throw new CredentialResolutionError(
      'Failed to decrypt credential',
      'credential_decrypt_error',
    )
  }

  return {
    token,
    status: row.status,
    expiresAt: row.expires_at,
  }
}
