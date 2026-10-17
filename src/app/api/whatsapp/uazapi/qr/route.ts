import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'
import { UazapiProvider } from '@/lib/whatsapp/providers/uazapi'

export async function POST(req: Request) {
  let accountId: string
  try {
    const ctx = await requireRole('admin')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    const body = await req.json().catch(() => ({}))
    let baseUrl = body.baseUrl as string | undefined
    let instanceId = body.instanceId as string | undefined
    let token = body.token as string | undefined

    // If not provided in body, load from saved whatsapp_config
    if (!baseUrl || !instanceId || !token) {
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
            console.error('[uazapi-qr] failed to decrypt token:', e)
          }
        }
      }
    }

    if (!baseUrl || !instanceId || !token) {
      return NextResponse.json(
        { error: 'Configuração incompleta. Forneça Server URL, Nome da Instância e Token.' },
        { status: 400 },
      )
    }

    const provider = new UazapiProvider({
      baseUrl,
      instanceId,
      token,
    })

    const result = await provider.connectAndGetQrCode(body.phone)

    return NextResponse.json(result)
  } catch (err) {
    console.error('[uazapi-qr] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Falha ao obter QR code' },
      { status: 500 },
    )
  }
}
