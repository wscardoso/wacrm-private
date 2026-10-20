import { describe, expect, it } from 'vitest'
import {
  getProvider,
  providerConfigFromRow,
  MetaProvider,
  UazapiProvider,
  ProviderUnsupportedError,
  type ProviderConfig,
} from './index'

// =============================================================
// Provider selection (ADR-MSG-001 D3.b) after the Z-API removal.
//
// The row → adapter mapping must be EXPLICIT. The previous call sites used a
// `zapi ? … : uazapi ? … : meta` ternary, so simply deleting the zapi branch
// would have sent a persisted provider='zapi' row to Meta with a Z-API
// credential. These tests pin that it is rejected instead.
// =============================================================

describe('providerConfigFromRow', () => {
  it('maps a meta row (and a row without a provider value, the column default) to the Meta adapter config', () => {
    const row = { phone_number_id: '123', instance_id: null, base_url: null }
    expect(providerConfigFromRow({ ...row, provider: 'meta' }, 'tok')).toEqual({
      provider: 'meta', phoneNumberId: '123', accessToken: 'tok', verifyToken: '',
    })
    expect(providerConfigFromRow({ ...row, provider: null }, 'tok')).toMatchObject({ provider: 'meta' })
    expect(providerConfigFromRow({ ...row }, 'tok')).toMatchObject({ provider: 'meta' })
  })

  it('maps a uazapi row to the uazapi adapter config', () => {
    expect(
      providerConfigFromRow({ provider: 'uazapi', instance_id: 'inst', base_url: 'https://my.uazapi.dev', phone_number_id: 'inst' }, 'key'),
    ).toEqual({ provider: 'uazapi', baseUrl: 'https://my.uazapi.dev', instanceId: 'inst', accessToken: 'key' })
  })

  it.each(['zapi', 'evolution', '', 'META'])('rejects provider %j with ProviderUnsupportedError — never falls through to Meta', (provider) => {
    expect(() => providerConfigFromRow({ provider, instance_id: 'i', base_url: null, phone_number_id: 'i' }, 'tok')).toThrow(ProviderUnsupportedError)
  })

  it('names the rejected provider in the error', () => {
    expect(() => providerConfigFromRow({ provider: 'zapi' }, 'tok')).toThrow('Unsupported WhatsApp provider: zapi')
  })
})

describe('getProvider', () => {
  it('builds the Meta and uazapi adapters', () => {
    expect(getProvider({ provider: 'meta', phoneNumberId: '1', accessToken: 't', verifyToken: '' })).toBeInstanceOf(MetaProvider)
    expect(getProvider({ provider: 'uazapi', baseUrl: 'https://u.uazapi.dev', instanceId: 'i', accessToken: 't' })).toBeInstanceOf(UazapiProvider)
    expect(getProvider({ provider: 'meta', phoneNumberId: '1', accessToken: 't', verifyToken: '' }).kind).toBe('meta')
    expect(getProvider({ provider: 'uazapi', baseUrl: 'https://u.uazapi.dev', instanceId: 'i', accessToken: 't' }).kind).toBe('uazapi')
  })

  it('throws ProviderUnsupportedError for zapi, even when forced past the type system', () => {
    const zapi = { provider: 'zapi', instanceId: 'i', accessToken: 't' } as unknown as ProviderConfig
    expect(() => getProvider(zapi)).toThrow(ProviderUnsupportedError)
  })
})
