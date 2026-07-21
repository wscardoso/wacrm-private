// ============================================================
// Server-side Workspace provisioning flow (P2.2 / P2.3-B).
//
// This is the application layer that sits between the UI and the
// privileged `create_platform_workspace(p_name, p_cnpj, p_owner_email)`
// RPC (migration 043). It:
//
//   * validates application-level input (name + CNPJ + owner email)
//     deterministically;
//   * requires an authenticated session;
//   * NEVER accepts user_id / actor_user_id from the caller — the RPC
//     stamps the actor from auth.uid() itself; owner_email is the ONLY
//     identity-adjacent field and it is resolved server-side inside
//     the SECURITY DEFINER RPC;
//   * calls ONLY the RPC (no direct DML, no service-role client, no
//     duplicated authorization logic — the RPC's SECURITY DEFINER +
//     active-admin check remains THE gate);
//   * translates RPC / Postgres errors into a typed, UI-safe result
//     that never leaks SQL text or stack traces.
//
// Mirrors the thin-wrapper convention of
// src/lib/auth/platform-accounts.ts: server-only (createClient imports
// next/headers) but accepts an injected SupabaseClient so the flow is
// unit-testable without a live session.
// ============================================================

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

// ------------------------------------------------------------
// Result contract (discriminated union — mirrors ContactDetailResult)
// ------------------------------------------------------------

export type CreateWorkspaceErrorCode =
  | "validation"
  | "unauthorized"
  | "conflict"
  | "unexpected";

export interface CreateWorkspaceError {
  code: CreateWorkspaceErrorCode;
  message: string;
  /** Which input field caused a validation/conflict error, when applicable. */
  field?: "name" | "cnpj" | "ownerEmail";
}

export type CreateWorkspaceResult =
  | { success: true; accountId: string }
  | { success: false; error: CreateWorkspaceError };

export interface CreateWorkspaceInput {
  name: string;
  /** Optional. Accepts masked or unmasked; validated + normalized here. */
  cnpj?: string | null;
  /**
   * Owner's email. REQUIRED — the product model mandates that a client
   * workspace is born WITH a human Owner. The RPC looks up the user in
   * auth.users and sets them as the Workspace Owner; this layer never
   * sees or forwards a raw user_id. The RPC itself rejects NULL/empty
   * p_owner_email with an explicit error — no orphan workspace is ever
   * created through this code path.
   */
  ownerEmail: string;
}

// ------------------------------------------------------------
// CNPJ validation — pure, deterministic, no external dependency.
// ------------------------------------------------------------

/** Strip every non-digit character, yielding a bare digit string. */
export function normalizeCnpj(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

/**
 * Full CNPJ validation on already-normalized (digits-only) input:
 *   - exactly 14 digits;
 *   - rejects a repeated single digit (e.g. "00000000000000"),
 *     which passes the checksum but is never a real CNPJ;
 *   - validates both check digits via the standard mod-11 algorithm.
 */
export function isValidCnpjDigits(digits: string): boolean {
  if (!/^\d{14}$/.test(digits)) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const checkDigit = (base: string): number => {
    // Weights run 2..9 cyclically from the RIGHTMOST base digit.
    let sum = 0;
    let weight = 2;
    for (let i = base.length - 1; i >= 0; i--) {
      sum += Number(base[i]) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const d1 = checkDigit(digits.slice(0, 12));
  if (d1 !== Number(digits[12])) return false;

  const d2 = checkDigit(digits.slice(0, 13));
  if (d2 !== Number(digits[13])) return false;

  return true;
}

/** Convenience: normalize then validate any raw (masked or not) input. */
export function isValidCnpj(raw: string): boolean {
  return isValidCnpjDigits(normalizeCnpj(raw));
}

// ------------------------------------------------------------
// Input validation → normalized RPC arguments
// ------------------------------------------------------------

interface NormalizedInput {
  name: string;
  /** null when the caller omitted the CNPJ (it is optional at the DB level). */
  cnpj: string | null;
  /** Always a non-empty validated email — the product model requires an Owner. */
  ownerEmail: string;
}

/** Bare-minimum email shape check — the RPC does the authoritative
 * existence check against auth.users. This prevents obviously-wrong
 * strings from round-tripping. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateInput(
  input: CreateWorkspaceInput,
): { ok: true; value: NormalizedInput } | { ok: false; error: CreateWorkspaceError } {
  const name = (input.name ?? "").trim();
  if (name === "") {
    return {
      ok: false,
      error: {
        code: "validation",
        field: "name",
        message: "Workspace name is required.",
      },
    };
  }

  // CNPJ is optional (accounts.cnpj is nullable). Only validate when the
  // caller actually supplied a non-empty value.
  const rawCnpj = input.cnpj == null ? "" : String(input.cnpj).trim();
  let cnpj: string | null = null;
  if (rawCnpj !== "") {
    const digits = normalizeCnpj(rawCnpj);
    if (!isValidCnpjDigits(digits)) {
      return {
        ok: false,
        error: {
          code: "validation",
          field: "cnpj",
          message: "Invalid CNPJ.",
        },
      };
    }
    cnpj = digits;
  }

  // Owner email is REQUIRED — a client workspace cannot be born orphan.
  const ownerEmail = String(input.ownerEmail ?? "").trim();
  if (ownerEmail === "") {
    return {
      ok: false,
      error: {
        code: "validation",
        field: "ownerEmail",
        message: "Owner email is required.",
      },
    };
  }
  if (!EMAIL_RE.test(ownerEmail)) {
    return {
      ok: false,
      error: {
        code: "validation",
        field: "ownerEmail",
        message: "Invalid owner email format.",
      },
    };
  }

  return { ok: true, value: { name, cnpj, ownerEmail } };
}

// ------------------------------------------------------------
// RPC error translation — UI-safe, never leaks SQL/stack details.
// ------------------------------------------------------------

function translateRpcError(error: PostgrestError): CreateWorkspaceError {
  switch (error.code) {
    case "42501":
      // Not authenticated OR not an active platform admin — from the
      // caller's perspective both are simply "not allowed".
      return {
        code: "unauthorized",
        message: "This action requires an active platform admin.",
      };
    case "23505":
      // Unique violation — the only user-reachable one here is the
      // partial unique index on accounts.cnpj (migration 041).
      return {
        code: "conflict",
        field: "cnpj",
        message: "A workspace with this CNPJ already exists.",
      };
    case "22023":
      // The RPC raises 22023 for both "No user found with email %" (owner
      // lookup) and "Invalid CNPJ format" (structural check). CNPJ is
      // pre-validated at this layer, so a 22023 at runtime is almost
      // certainly a missing user — surface that specifically.
      if (error.message?.startsWith("No user found")) {
        return {
          code: "validation",
          field: "ownerEmail",
          message: "No user found with this email.",
        };
      }
      return {
        code: "validation",
        message: "Invalid workspace data.",
      };
    default:
      console.error("[createPlatformWorkspace] unexpected RPC error:", error);
      return {
        code: "unexpected",
        message: "Failed to create workspace.",
      };
  }
}

// ------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------

/**
 * Provision a new Workspace as the authenticated Superadmin.
 *
 * Authorization is delegated entirely to the RPC (active platform admin
 * check + SECURITY DEFINER). This layer only fails fast on missing
 * authentication, normalizes/validates input, and returns a typed
 * result.
 *
 * The RPC looks up the owner email in auth.users and sets the user as the
 * Workspace Owner — the workspace is born WITH a human Owner (the product
 * model forbids orphan client workspaces).
 *
 * @param input          Workspace name, optional CNPJ (masked or not),
 *                       and required owner email.
 * @param callerSupabase Optional injected client (tests / advanced callers);
 *                       defaults to the request-scoped server client.
 */
export async function createPlatformWorkspace(
  input: CreateWorkspaceInput,
  callerSupabase?: SupabaseClient,
): Promise<CreateWorkspaceResult> {
  const validated = validateInput(input);
  if (!validated.ok) {
    return { success: false, error: validated.error };
  }

  const supabase = callerSupabase ?? (await createClient());

  // Fail fast on unauthenticated callers (cleaner than a round trip),
  // but do NOT re-implement the admin authorization — that stays in the
  // RPC, which is the single source of truth.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      success: false,
      error: {
        code: "unauthorized",
        message: "You must be signed in to create a workspace.",
      },
    };
  }

  const { data, error } = await supabase.rpc("create_platform_workspace", {
    p_name: validated.value.name,
    p_cnpj: validated.value.cnpj,
    p_owner_email: validated.value.ownerEmail,
  });

  if (error) {
    return { success: false, error: translateRpcError(error) };
  }

  if (typeof data !== "string" || data === "") {
    console.error(
      "[createPlatformWorkspace] RPC returned no account id:",
      data,
    );
    return {
      success: false,
      error: {
        code: "unexpected",
        message: "Failed to create workspace.",
      },
    };
  }

  return { success: true, accountId: data };
}
