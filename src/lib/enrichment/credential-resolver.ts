import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
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

  let token: string
  try {
    token = decrypt(row.ciphertext)
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
