// ============================================================
// Shared identity-field validation — E5 (§5, §7).
//
// The Feature Contract's normative model is that BOTH writers (member
// PATCH /api/account, E5a; platform RPC update_platform_workspace_identity,
// E5b) write the SAME accounts columns under the SAME database CHECK
// constraints (053), so they cannot diverge at the authoritative layer.
// This module is the analogous guarantee at the application layer: one
// set of validators, imported by both call sites, instead of two
// hand-written copies that could drift in accepted formats or error
// wording. The DB CHECK constraints remain the final gate either way —
// this is defense-in-depth for clean 4xx responses, not the source of
// truth.
// ============================================================

import { normalizeCnpj, isValidCnpjDigits } from "./create-workspace";

export const MAX_NAME_LEN = 80;
export const MAX_LEGAL_NAME_LEN = 160;
// Mirrors accounts_commercial_phone_format (053).
export const PHONE_RE = /^[0-9+()\-\s]{6,30}$/;
// Mirrors accounts_commercial_email_format (053) — same shape as the
// existing EMAIL_RE in src/lib/workspaces/create-workspace.ts.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A field's validated outcome: the value to write (string, or `null`
 *  for the nullable identity fields to clear it). */
export type ValidatedValue<T> = { value: T };

export interface ValidationError {
  field: string;
  message: string;
}

export function validateName(raw: unknown): ValidatedValue<string> | ValidationError {
  if (typeof raw !== "string") {
    return { field: "name", message: "'name' must be a string" };
  }
  const name = raw.trim();
  if (name.length === 0) {
    return { field: "name", message: "Account name cannot be empty" };
  }
  if (name.length > MAX_NAME_LEN) {
    return {
      field: "name",
      message: `Account name must be ${MAX_NAME_LEN} characters or fewer`,
    };
  }
  return { value: name };
}

/** Shared shape for the three E5a nullable identity fields: string
 *  (validated + trimmed) or explicit `null` to clear. */
export function validateNullableText(
  raw: unknown,
  field: string,
  opts: { maxLen: number; format?: RegExp; formatMessage?: string },
): ValidatedValue<string | null> | ValidationError {
  if (raw === null) {
    return { value: null };
  }
  if (typeof raw !== "string") {
    return { field, message: `'${field}' must be a string or null` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // §7.1/§7.5: an explicitly-empty string is not how you clear a
    // field — that ambiguity is exactly what the CHECK constraints
    // reject at the DB layer. Surface it here as a clean 400 instead
    // of a raw constraint-violation error, and tell the caller the
    // correct way to clear the field.
    return {
      field,
      message: `'${field}' cannot be an empty string — send null to clear it`,
    };
  }
  if (trimmed.length > opts.maxLen) {
    return {
      field,
      message: `'${field}' must be ${opts.maxLen} characters or fewer`,
    };
  }
  if (opts.format && !opts.format.test(trimmed)) {
    return { field, message: opts.formatMessage ?? `'${field}' has an invalid format` };
  }
  return { value: trimmed };
}

export function validateCnpj(raw: unknown): ValidatedValue<string | null> | ValidationError {
  if (raw === null) {
    return { value: null };
  }
  if (typeof raw !== "string") {
    return { field: "cnpj", message: "'cnpj' must be a string or null" };
  }
  // Accepts masked or unmasked input, same as workspace creation —
  // reuses the existing normalizer rather than re-deriving one.
  const digits = normalizeCnpj(raw);
  if (!isValidCnpjDigits(digits)) {
    return { field: "cnpj", message: "Invalid CNPJ" };
  }
  return { value: digits };
}
