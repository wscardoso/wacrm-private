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