import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'
import { UazapiProvider } from '@/lib/whatsapp/providers/uazapi'

export async function GET(req: Request) {
  let accountId: string
  try {
    // Minimum 'agent' — all workspace members can poll connection status.
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    const { searchParams } = new URL(req.url)
    let baseUrl = searchParams.get('baseUrl') ?? undefined
    let instanceId = searchParams.get('instanceId') ?? undefined
    let token = searchParams.get('token') ?? undefined

    const admin = supabaseAdmin()
    const { data: config } = await admin
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .maybeSingle()

    if (config) {
      baseUrl = baseUrl || config.base_url
      instanceId = instanceId || config.instance_id
      if (!token && config.access_token) {
        try {
          token = decryptWithBindingContext(
            config.access_token,
            whatsappConfigBindingContext(accountId),
          )
        } catch (e) {
          console.error('[uazapi-status] failed to decrypt token:', e)
        }
      }
    }

    if (!baseUrl || !instanceId || !token) {
      return NextResponse.json(
        { connected: false, status: 'disconnected', message: 'Configuração incompleta' },
        { status: 200 },
      )
    }

    const provider = new UazapiProvider({
      baseUrl,
      instanceId,
      token,
    })

    const result = await provider.getInstanceStatus()

    if (result.connected && config && config.status !== 'connected') {
      await admin
        .from('whatsapp_config')
        .update({ status: 'connected', updated_at: new Date().toISOString() })
        .eq('id', config.id)
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[uazapi-status] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Falha ao consultar status' },
      { status: 500 },
    )
  }
}
