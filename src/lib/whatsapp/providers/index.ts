/**
 * D3.b — Ponto de despacho único e nomeado.
 *
 * `getProvider` é a única autoridade do sistema para a correspondência entre
 * conexão e adaptador de provider. Nenhum módulo instancia adaptador
 * diretamente. Adicionar um provider significa registrá-lo aqui — e nada mais.
 *
 * @see ADR-MSG-001 D3.b
 * @see DLB-001 §7
 */

import { MetaProvider } from './meta'
import { UazapiProvider } from './uazapi'
import { ProviderUnsupportedError } from './types'

export { MetaProvider, UazapiProvider, ProviderUnsupportedError }
export type {
  WhatsAppProvider,
  SendResult,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendReactionArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  InboundMessage,
  ExternalIdentity,
  ProviderCapabilities,
  SendOutcomeClass,
} from './types'

export type ProviderConfig =
  | { provider: 'meta'; phoneNumberId: string; accessToken: string; verifyToken: string }
  | { provider: 'uazapi'; baseUrl: string; instanceId: string; accessToken: string }

export function getProvider(config: ProviderConfig) {
  switch (config.provider) {
    case 'meta':
      return new MetaProvider({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.verifyToken,
      })
    case 'uazapi':
      return new UazapiProvider({
        baseUrl: config.baseUrl,
        instanceId: config.instanceId,
        token: config.accessToken,
      })
    default: {
      const p = (config as { provider: string }).provider
      throw new ProviderUnsupportedError(p)
    }
  }
}

/**
 * The columns of a `whatsapp_config` row that decide which adapter handles
 * the connection. Every call site that builds a provider from a stored row
 * goes through `providerConfigFromRow`, so the row → adapter mapping lives
 * next to `getProvider` instead of being repeated as a ternary chain.
 */
export interface ProviderConfigRow {
  provider?: string | null
  instance_id?: string | null
  base_url?: string | null
  phone_number_id?: string | null
}

/**
 * Maps a stored `whatsapp_config` row (access token already decrypted) to a
 * `ProviderConfig`. Selection is EXPLICIT: only `meta` (or a missing value,
 * the column default) and `uazapi` are supported. Any other value — including
 * the discontinued `zapi` still present in rows saved before its removal —
 * throws `ProviderUnsupportedError`. It must never fall through to Meta: that
 * would run a non-Meta credential against the Meta API.
 */
export function providerConfigFromRow(row: ProviderConfigRow, accessToken: string): ProviderConfig {
  switch (row.provider ?? 'meta') {
    case 'meta':
      return {
        provider: 'meta',
        phoneNumberId: row.phone_number_id as string,
        accessToken,
        verifyToken: '',
      }
    case 'uazapi':
      return {
        provider: 'uazapi',
        baseUrl: row.base_url as string,
        instanceId: row.instance_id as string,
        accessToken,
      }
    default:
      throw new ProviderUnsupportedError(String(row.provider))
  }
}

/**
 * Message templates (and therefore broadcasts, which are template fan-outs)
 * exist only on the official Meta API. The uazapi adapter has no template
 * concept and would deliver the template NAME as plain text, so every
 * template-sending entry point must refuse a non-Meta connection BEFORE it
 * creates or sends anything. `/send` has always done so (with its own, longer
 * wording); `/broadcast` and the automations `send_template` step share this
 * rule and this message.
 */
export function providerSupportsTemplates(row: Pick<ProviderConfigRow, 'provider'>): boolean {
  return (row.provider ?? 'meta') === 'meta'
}

export const TEMPLATES_META_ONLY_MESSAGE =
  'Template messages are only available with the official Meta WhatsApp Business API.'
