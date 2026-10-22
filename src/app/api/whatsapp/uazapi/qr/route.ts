import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'
import { UazapiProvider } from '@/lib/whatsapp/providers/uazapi'
import { resolveUazapiTarget } from '@/lib/whatsapp/providers/uazapi-target'

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
    const asText = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

    const admin = supabaseAdmin()
    const { data: config } = await admin
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'uazapi')
      .maybeSingle()

    // The stored token is only ever paired with the stored base_url; a request
    // that names another server must bring its own token.
    const target = resolveUazapiTarget(
      {
        baseUrl: asText(body.baseUrl),
        instanceId: asText(body.instanceId),
        token: asText(body.token),
      },
      config
        ? {
            base_url: config.base_url ?? null,
            instance_id: config.instance_id ?? null,
            access_token: config.access_token ?? null,
          }
        : null,
      () =>
        decryptWithBindingContext(config!.access_token, whatsappConfigBindingContext(accountId)),
    )

    if (!target.ok) {
      if (target.code === 'token_required_for_new_host') {
        return NextResponse.json(
          { error: 'Informe o token da instância ao alterar o servidor.' },
          { status: 400 },
        )
      }
      if (target.code === 'invalid_base_url') {
        return NextResponse.json({ error: 'URL do servidor inválida.' }, { status: 400 })
      }
      return NextResponse.json(
        { error: 'Configuração incompleta. Forneça Server URL, Nome da Instância e Token.' },
        { status: 400 },
      )
    }

    const provider = new UazapiProvider({
      baseUrl: target.baseUrl,
      instanceId: target.instanceId,
      token: target.token,
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
