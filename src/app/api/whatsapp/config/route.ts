import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { ZApiProvider } from '@/lib/whatsapp/providers/zapi'
import { UazapiProvider } from '@/lib/whatsapp/providers/uazapi'
import type { WhatsAppProviderKind } from '@/types'

/**
 * Resolve the caller's account_id from their profile.
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * GET /api/whatsapp/config
 *
 * Health-checks the saved config. Returns 200 in all non-auth cases.
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status, provider, instance_id, base_url, waba_id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 },
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 },
      )
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 },
      )
    }

    const provider = (config.provider as WhatsAppProviderKind) ?? 'meta'

    // ── Non-Meta health check ──────────────────────────────────
    if (provider === 'zapi') {
      if (!config.instance_id) {
        return NextResponse.json(
          { connected: false, reason: 'no_config', message: 'Instance ID not configured.' },
          { status: 200 },
        )
      }
      try {
        let clientToken: string | undefined
        if (config.waba_id) {
          try { clientToken = decrypt(config.waba_id) } catch { /* ignore corrupted client token */ }
        }
        const zapi = new ZApiProvider({ instanceId: config.instance_id, token: accessToken, clientToken })
        const status = await zapi.checkStatus()
        if (status.connected) {
          return NextResponse.json({ connected: true })
        }
        return NextResponse.json({
          connected: false,
          reason: 'provider_disconnected',
          message:
            'Z-API instance is not connected. Open the Z-API dashboard and check the instance status.',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown Z-API error'
        return NextResponse.json({
          connected: false,
          reason: 'meta_api_error',
          message: `Z-API error: ${message}`,
        })
      }
    }

    if (provider === 'uazapi') {
      if (!config.instance_id || !config.base_url) {
        return NextResponse.json(
          {
            connected: false,
            reason: 'no_config',
            message: 'Instance or server URL not configured.',
          },
          { status: 200 },
        )
      }
      try {
        const uazapi = new UazapiProvider({
          baseUrl: config.base_url,
          instanceId: config.instance_id,
          token: accessToken,
        })
        const status = await uazapi.checkStatus()
        if (status.connected) {
          return NextResponse.json({ connected: true })
        }
        return NextResponse.json({
          connected: false,
          reason: 'provider_disconnected',
          message:
            'uazapi instance is not connected. Check the instance status in your uazapi dashboard.',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown uazapi error'
        return NextResponse.json({
          connected: false,
          reason: 'meta_api_error',
          message: `uazapi error: ${message}`,
        })
      }
    }

    // ── Meta health check ──────────────────────────────────────
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      return NextResponse.json({ connected: true, phone_info: phoneInfo })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 },
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config. Handles all providers.
 */
export async function POST(request: Request) {
  try {
    let supabase
    let accountId: string
    let userId: string
    try {
      const ctx = await requireRole('admin')
      supabase = ctx.supabase
      accountId = ctx.accountId
      userId = ctx.userId
    } catch (err) {
      return toErrorResponse(err)
    }

    const body = await request.json()
    const {
      provider = 'meta',
      // Meta fields
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      pin,
      // Non-Meta fields
      instance_id,
      base_url,
      // Z-API optional Security Token (stored in waba_id column)
      client_token,
    } = body as {
      provider?: WhatsAppProviderKind
      phone_number_id?: string
      waba_id?: string
      access_token?: string
      verify_token?: string
      pin?: string
      instance_id?: string
      base_url?: string
      client_token?: string | null
    }
    const clientTokenChanged = 'client_token' in (body as object)

    if (!access_token) {
      return NextResponse.json(
        { error: 'access_token is required' },
        { status: 400 },
      )
    }

    // ── Non-Meta providers: simple credential save ─────────────
    if (provider === 'zapi' || provider === 'uazapi') {
      if (!instance_id) {
        return NextResponse.json(
          { error: 'instance_id is required for this provider' },
          { status: 400 },
        )
      }
      if (provider === 'uazapi' && !base_url) {
        return NextResponse.json(
          { error: 'base_url is required for uazapi' },
          { status: 400 },
        )
      }

      // Z-API is an internal/testing-only provider, gated behind
      // WHATSAPP_ENABLE_ZAPI. Never blocks an account that already has a
      // zapi config — this only stops *new* configs and switches from
      // another provider *into* zapi. Checked before any encryption or
      // provider connectivity call so a disabled request fails fast.
      if (provider === 'zapi' && process.env.WHATSAPP_ENABLE_ZAPI !== 'true') {
        const { data: existingProviderRow } = await supabase
          .from('whatsapp_config')
          .select('provider')
          .eq('account_id', accountId)
          .maybeSingle()
        if (existingProviderRow?.provider !== 'zapi') {
          return NextResponse.json(
            {
              error:
                'Z-API is an experimental provider disabled on this instance. Contact support if you need access.',
            },
            { status: 403 },
          )
        }
      }

      let encryptedToken: string
      try {
        encryptedToken = encrypt(access_token)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown encryption error'
        console.error('Encryption failed:', message)
        return NextResponse.json(
          { error: 'Failed to encrypt token. Check ENCRYPTION_KEY in your environment.' },
          { status: 500 },
        )
      }

      // If the client_token wasn't sent (user didn't re-enter it), load the
      // existing one from DB so the connectivity check uses the right header.
      let resolvedClientToken: string | undefined = client_token ?? undefined
      if (!clientTokenChanged) {
        const { data: existingRow } = await supabase
          .from('whatsapp_config')
          .select('waba_id')
          .eq('account_id', accountId)
          .maybeSingle()
        if (existingRow?.waba_id) {
          try { resolvedClientToken = decrypt(existingRow.waba_id) } catch { /* ignore */ }
        }
      }

      // Verify connectivity before saving
      try {
        if (provider === 'zapi') {
          const zapi = new ZApiProvider({
            instanceId: instance_id,
            token: access_token,
            clientToken: resolvedClientToken,
          })
          const status = await zapi.checkStatus()
          if (!status.connected) {
            return NextResponse.json(
              {
                error:
                  'Z-API instance is not connected. Check the instance status in your Z-API dashboard.',
              },
              { status: 400 },
            )
          }
        } else {
          const uazapi = new UazapiProvider({
            baseUrl: base_url!,
            instanceId: instance_id,
            token: access_token,
          })
          const status = await uazapi.checkStatus()
          if (!status.connected) {
            return NextResponse.json(
              {
                error:
                  'uazapi instance is not connected. Check the instance status in your uazapi dashboard.',
              },
              { status: 400 },
            )
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return NextResponse.json(
          { error: `Provider connectivity check failed: ${message}` },
          { status: 400 },
        )
      }

      const { data: existing } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .maybeSingle()

      // For Z-API, waba_id stores the encrypted Security Token (client-token).
      // Only update it if the frontend explicitly sent the field; omitting keeps the existing value.
      let encryptedClientToken: string | null | undefined
      if (clientTokenChanged) {
        encryptedClientToken = client_token ? encrypt(client_token) : null
      }

      // Preserve existing verify_token if the field was left blank on update
      let encryptedVerifyToken: string | null | undefined
      if (verify_token) {
        encryptedVerifyToken = encrypt(verify_token)
      } else if (existing) {
        // Blank field on update → keep whatever is already stored
        encryptedVerifyToken = undefined // omit from row so Supabase doesn't overwrite
      } else {
        encryptedVerifyToken = null
      }

      const row = {
        provider,
        instance_id,
        base_url: base_url ?? null,
        // Keep phone_number_id non-null (DB constraint) with a placeholder
        phone_number_id: phone_number_id ?? instance_id,
        ...(clientTokenChanged ? { waba_id: encryptedClientToken } : {}),
        access_token: encryptedToken,
        ...(encryptedVerifyToken !== undefined ? { verify_token: encryptedVerifyToken } : {}),
        status: 'connected' as const,
        connected_at: new Date().toISOString(),
        // Not applicable for non-Meta
        registered_at: null,
        subscribed_apps_at: null,
        last_registration_error: null,
        updated_at: new Date().toISOString(),
      }

      if (existing) {
        const { error: updateError } = await supabase
          .from('whatsapp_config')
          .update(row)
          .eq('account_id', accountId)
        if (updateError) {
          console.error('Error updating whatsapp_config:', updateError)
          return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
        }
      } else {
        const { error: insertError } = await supabase
          .from('whatsapp_config')
          .insert({ account_id: accountId, user_id: userId, ...row })
        if (insertError) {
          console.error('Error inserting whatsapp_config:', insertError)
          return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
        }
      }

      return NextResponse.json({ success: true, saved: true, registered: true })
    }

    // ── Meta provider: existing full flow ─────────────────────
    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 },
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json({ error: 'PIN must be exactly 6 digits.' }, { status: 400 })
      }
    }

    // Reject if another account already claimed this number
    const { data: claimedRows, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .limit(1)
    const claimed = claimedRows?.[0] ?? null

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 },
      )
    }

    // Verify credentials with Meta
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId: phone_number_id, accessToken: access_token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
    }

    // Encrypt tokens
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 },
      )
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id')
      .eq('account_id', accountId)
      .maybeSingle()

    const sameNumber =
      existing?.phone_number_id === phone_number_id && existing?.registered_at != null

    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({ phoneNumberId: phone_number_id, accessToken: access_token, pin })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError = err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
        }
      }
    }

    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({ wabaId: waba_id, accessToken: access_token })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
      }
    }

    const baseRow = {
      provider: 'meta',
      instance_id: null,
      base_url: null,
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)
      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: userId, ...baseRow })
      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    if (registrationError) {
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 */
export async function DELETE() {
  try {
    let supabase
    let accountId: string
    try {
      const ctx = await requireRole('admin')
      supabase = ctx.supabase
      accountId = ctx.accountId
    } catch (err) {
      return toErrorResponse(err)
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
