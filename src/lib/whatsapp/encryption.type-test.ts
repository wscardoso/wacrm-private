/**
 * IMP-CRYPTO-001 RC1.3 §7.1 "BC required, no signature ambiguity" (a) —
 * type-level test: encryptWithBindingContext/decryptWithBindingContext
 * called with only one argument must fail to compile.
 *
 * `bindingContext: string` has no optional/undefined variant (§3.3, §4.1)
 * — the guarantee is a compile-time property, so it is checked here with
 * `@ts-expect-error` rather than at runtime. This file is never executed
 * (no vitest `describe`/`it`); it is exercised exclusively by `tsc --noEmit`
 * (§7.6, run on every commit). If a future change makes the omitted-argument
 * call below compile, the unused `@ts-expect-error` directive itself
 * becomes a compile error, failing the build — that is the assertion.
 */
import { encryptWithBindingContext, decryptWithBindingContext } from './encryption'

// @ts-expect-error — bindingContext is required; omitting it must not compile.
encryptWithBindingContext('data')

// @ts-expect-error — bindingContext is required; omitting it must not compile.
decryptWithBindingContext('token')

// @ts-expect-error — bindingContext must be a string, not undefined.
encryptWithBindingContext('data', undefined)

// @ts-expect-error — bindingContext must be a string, not undefined.
decryptWithBindingContext('token', undefined)

// Positive control — confirms the two negative assertions above are
// actually exercising a type error and not merely a stale/broken import.
encryptWithBindingContext('data', 'whatsapp_config:account-id')
decryptWithBindingContext('token', 'whatsapp_config:account-id')
