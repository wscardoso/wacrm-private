import { describe, it, expect } from 'vitest'
import { decryptWithBindingContext } from '../whatsapp/encryption'
import fixtures from './__fixtures__/canonical-envelopes.json'

// IMP-CRYPTO-001 RC1.3 §7.1 "Canonical read regression on frozen fixtures" /
// §7.2 "Fix-forward compatibility" / §12.2.
//
// This corpus was produced once, immediately after the whatsapp_config and
// ad_account_credentials domain cutovers (Phase 3.1/3.2), against the
// ENCRYPTION_KEY fixed in vitest.config.ts. It must remain decryptable by
// every future version of envelope.ts/keyring.ts/encryption.ts — this is
// the automated backstop for the read-path fix-forward rule (§12.2): a
// patch that cannot decrypt an entry here has broken already-written
// production data and must not merge.
//
// Do NOT regenerate these ciphertexts to "fix" a failing test. A failure
// here means the patch is the defect, not the fixture.
describe('canonical envelope fixtures — frozen read regression', () => {
  for (const fixture of fixtures) {
    it(`decrypts fixture "${fixture.name}" unchanged`, () => {
      expect(
        decryptWithBindingContext(fixture.ciphertext, fixture.bindingContext),
      ).toBe(fixture.plaintext)
    })
  }

  it('rejects a fixture decrypted against the wrong Binding Context (AAD tamper-evidence unchanged)', () => {
    const [first, second] = fixtures
    expect(() =>
      decryptWithBindingContext(first.ciphertext, second.bindingContext),
    ).toThrow()
  })
})
