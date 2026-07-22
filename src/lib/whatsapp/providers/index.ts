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
import { ZApiProvider } from './zapi'
import { UazapiProvider } from './uazapi'
import { ProviderUnsupportedError } from './types'

export { MetaProvider, ZApiProvider, UazapiProvider, ProviderUnsupportedError }
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
  | { provider: 'zapi'; instanceId: string; accessToken: string; clientToken?: string }
  | { provider: 'uazapi'; baseUrl: string; instanceId: string; accessToken: string }

export function getProvider(config: ProviderConfig) {
  switch (config.provider) {
    case 'meta':
      return new MetaProvider({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.verifyToken,
      })
    case 'zapi':
      return new ZApiProvider({
        instanceId: config.instanceId,
        token: config.accessToken,
        clientToken: config.clientToken,
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