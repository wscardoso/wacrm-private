import { MetaProvider } from './meta'
import { ProviderUnsupportedError } from './types'
export { MetaProvider, ProviderUnsupportedError }
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

export function getProvider(config: { provider: string; phoneNumberId: string; accessToken: string; verifyToken: string }) {
  if (config.provider === 'meta') {
    return new MetaProvider({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      verifyToken: config.verifyToken,
    })
  }
  throw new ProviderUnsupportedError(config.provider)
}