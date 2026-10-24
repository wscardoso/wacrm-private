/**
 * Retry of a database call that is safe to repeat, for failures that can succeed on
 * a second try.
 *
 * Why it exists: some providers never redeliver a webhook the receiver refused (the
 * UAZAPI FREE worker was observed not to retry a 500 within two minutes), so a
 * transient database error on the one call that makes an inbound message durable
 * would lose the message. The call is idempotent (persist_inbound_message_with_turn
 * dedups on the provider message id), so repeating it a couple of times inside the
 * request costs milliseconds and removes most of that loss.
 *
 * What counts as transient (SQLSTATE class): 08 connection exception, 40
 * serialization failure / deadlock, 53 insufficient resources, 57P01-57P03 server
 * shutdown / crash recovery / cannot connect now. No code at all means the call never
 * produced a database answer (network or runtime failure). Anything else (constraint,
 * data, permission, raised exception) is deterministic and is not retried.
 */

const TRANSIENT_SQLSTATE = /^(08|40|53|57P0[123])/

export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'string' || code === '') return true
  return TRANSIENT_SQLSTATE.test(code)
}

/** Waits before retry 1, 2, ...; also the maximum number of retries. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [150, 400]

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: {
    delaysMs?: readonly number[]
    sleep?: (ms: number) => Promise<void>
    label?: string
  } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= delays.length || !isTransientDbError(err)) throw err
      // Code only: the message of a database error is not guaranteed PII-free.
      const code = (err as { code?: unknown })?.code
      console.warn(
        '[inbound] transient failure in %s (code=%s), retry %d/%d',
        opts.label ?? 'db call',
        typeof code === 'string' && code ? code : 'none',
        attempt + 1,
        delays.length,
      )
      await sleep(delays[attempt]!)
    }
  }
}
