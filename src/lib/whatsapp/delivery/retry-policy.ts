/**
 * Retry policy — ARO-001 v3 §13 (Backoff) e §14 (TTL).
 *
 * Duas políticas deliberadamente separadas, cada uma sem conhecimento
 * da outra, mais a regra de composição que §13 fixa entre elas:
 *
 * Valores operacionais (ARO-001 §11 — ajustáveis sem reabrir contrato):
 *   DEFAULT_TTL_MS        72 horas (3 dias)
 *   MAX_ATTEMPT_COUNT      10 tentativas
 *   ORPHAN_THRESHOLD_MS     5 minutos (idade mínima de uma sending órfã)
 * 
 *
 * - `computeBackoff` — apenas a curva (§13). Não sabe de TTL nem de
 *   teto de tentativas.
 * - `isExpired` — apenas a idade da intenção (§14). Não sabe de
 *   `attempt_count` nem de backoff.
 * - `nextAttemptOrExpire` — a composição normativa que §13 exige:
 *   "o backoff nunca agenda uma tentativa além do horizonte de TTL.
 *   Se a próxima tentativa cairia depois do TTL, a intenção vai à DLQ
 *   em vez de ser reagendada." Teto de tentativas e TTL são "cortes
 *   independentes" (§14) — nenhuma das duas funções abaixo decide o
 *   teto; isso permanece com o chamador (ARO-001 §11).
 *
 * Este módulo não persiste nada, não enfileira, não decide o teto de
 * tentativas e não conhece o retry ledger — são funções puras.
 */

/** ARO-001 §13 — parâmetros da curva. Valores concretos são operação, não contrato. */
export interface BackoffConfig {
  /** Intervalo base, em ms, antes do primeiro backoff exponencial. */
  baseMs: number
  /** Teto por passo — o intervalo não cresce indefinidamente (§13). */
  maxStepMs: number
  /** Fração de jitter aleatório aplicada sobre o intervalo calculado (0–1). */
  jitterRatio: number
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseMs: 30_000,
  maxStepMs: 30 * 60_000,
  jitterRatio: 0.2,
}

/**
 * ARO-001 §13 — curva exponencial com jitter, teto por passo.
 * Não sabe de TTL: apenas "quanto tempo a partir de agora", dado o
 * número de tentativas já feitas.
 */
export function computeBackoff(
  attemptCount: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
): number {
  const exponential = config.baseMs * Math.pow(2, Math.max(0, attemptCount))
  const capped = Math.min(exponential, config.maxStepMs)
  const jitter = capped * config.jitterRatio * Math.random()
  return Math.round(capped + jitter)
}

/**
 * ARO-001 §14 — horizonte máximo de vida, medido a partir da criação
 * da intenção. Não sabe de `attempt_count`: apenas idade.
 */
export function isExpired(createdAt: Date, ttlMs: number, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() >= ttlMs
}

/** Resultado da composição — nunca ambos ao mesmo tempo. */
export type NextAttemptDecision =
  | { kind: 'scheduled'; nextAttemptAt: Date }
  | { kind: 'expired' }

/**
 * ARO-001 §13 — regra de composição explícita: o backoff nunca agenda
 * além do TTL. Se a próxima tentativa calculada cairia depois do
 * horizonte de TTL, o resultado é "expirado" — a intenção vai à DLQ
 * (§14), não é reagendada.
 *
 * Teto de tentativas (ARO-001 §11) é corte independente e não é
 * avaliado aqui — é responsabilidade do chamador, exatamente como
 * §14 declara que teto e TTL não se misturam.
 */
export function nextAttemptOrExpire(
  attemptCount: number,
  createdAt: Date,
  ttlMs: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  now: Date = new Date(),
): NextAttemptDecision {
  if (isExpired(createdAt, ttlMs, now)) {
    return { kind: 'expired' }
  }

  const backoffMs = computeBackoff(attemptCount, config)
  const nextAttemptAt = new Date(now.getTime() + backoffMs)

  if (nextAttemptAt.getTime() - createdAt.getTime() >= ttlMs) {
    return { kind: 'expired' }
  }

  return { kind: 'scheduled', nextAttemptAt }
}

/** ARO-001 §14 — valor operacional default (72 h). */
export const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000

/** ARO-001 §11 — teto de tentativas. */
export const MAX_ATTEMPT_COUNT = 10

/** ARO-001 §16 — limiar de idade para considerar uma sending órfã (5 min). */
export const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000
