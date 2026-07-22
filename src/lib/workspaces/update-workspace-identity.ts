// ============================================================
// Server-side platform-operator identity UPDATE flow (E5b).
//
// This is the application layer between the /act/[accountId]/settings
// UI and the privileged
// update_platform_workspace_identity(p_account_id, p_updates) RPC
// (migration 054). Mirrors the shape of createPlatformWorkspace
// (create-workspace.ts) deliberately:
//
//   * validates application-level input with the SAME validators the
//     member-side PATCH /api/account route uses
//     (@/lib/workspaces/identity-validation) — one set of rules, not a
//     second hand-written copy (contract §5);
//   * requires an authenticated session (fail fast before the RPC);
//   * NEVER accepts actor identity from the caller — the RPC stamps
//     auth.uid() itself, and re-derives tenant authorization from
//     is_platform_operator_for(p_account_id) independently of anything
//     this layer does (the RPC's own check is THE gate, not this file);
//   * calls ONLY the RPC — no direct DML, no service-role client, no
//     duplicated authorization logic;
//   * translates RPC / Postgres errors into a typed, UI-safe result.
//
// Partial-update semantics (§7.5): a field OMITTED from `input` leaves
// that column unchanged; a field explicitly passed as `null` clears it.
// This module represents "omitted" the same way the member route reads
// its JSON body — via key presence — by accepting an object whose keys
// may or may not be present, then building the RPC's `p_updates` JSONB
// payload only from the keys actually supplied.
// ============================================================

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import {
  MAX_LEGAL_NAME_LEN,
  PHONE_RE,
  EMAIL_RE,
  validateName,
  validateNullableText,
  validateCnpj,
} from "./identity-validation";

// ------------------------------------------------------------
// Result contract
// ------------------------------------------------------------

export type UpdateWorkspaceIdentityErrorCode =
  | "validation"
  | "unauthorized"
  | "conflict"
  | "unexpected";

export interface UpdateWorkspaceIdentityError {
  code: UpdateWorkspaceIdentityErrorCode;
  message: string;
  field?: "name" | "legal_name" | "commercial_phone" | "commercial_email" | "cnpj";
}

export interface WorkspaceIdentityRow {
  id: string;
  name: string;
  legal_name: string | null;
  commercial_phone: string | null;
  commercial_email: string | null;
  cnpj: string | null;
  updated_at: string;
}

export type UpdateWorkspaceIdentityResult =
  | { success: true; account: WorkspaceIdentityRow }
  | { success: false; error: UpdateWorkspaceIdentityError };

/**
 * Partial-update input. A key OMITTED from this object leaves the
 * column unchanged; a key present with value `null` clears it (except
 * `name`, which is NOT NULL at the schema level — see identity-
 * validation.ts's validateName). Same semantics as PatchBody in
 * /api/account/route.ts.
 */
export interface UpdateWorkspaceIdentityInput {
  accountId: string;
  name?: unknown;
  legal_name?: unknown;
  commercial_phone?: unknown;
  commercial_email?: unknown;
  cnpj?: unknown;
}

// ------------------------------------------------------------
// RPC error translation — UI-safe, never leaks SQL/stack details.
// ------------------------------------------------------------

function translateRpcError(error: PostgrestError): UpdateWorkspaceIdentityError {
  switch (error.code) {
    case "42501":
      // Not authenticated, not an operator, or not authorized for this
      // specific tenant — the RPC deliberately does not distinguish
      // these from the caller's perspective (same posture as 042/043).
      return {
        code: "unauthorized",
        message: "You are not authorized to manage this workspace.",
      };
    case "23505":
      return {
        code: "conflict",
        field: "cnpj",
        message: "This CNPJ is already registered to another account.",
      };
    case "23514":
      // A CHECK constraint (053/041) rejected a value — should be rare
      // given the app-layer validation below, but the DB is the
      // authoritative gate (contract §5).
      return {
        code: "validation",
        message: "One or more fields failed validation.",
      };
    case "22023":
      return {
        code: "validation",
        message: error.message || "Invalid workspace data.",
      };
    default:
      console.error("[updateWorkspaceIdentity] unexpected RPC error:", error);
      return {
        code: "unexpected",
        message: "Failed to update workspace identity.",
      };
  }
}

// ------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------

/**
 * Update a supervised tenant's commercial identity as the authenticated
 * platform operator. Authorization is delegated entirely to the RPC
 * (is_platform_operator_for(p_account_id) + SECURITY DEFINER) — this
 * layer only fails fast on missing authentication, validates/normalizes
 * input with the same rules the member-side route uses, and returns a
 * typed result.
 */
export async function updateWorkspaceIdentity(
  input: UpdateWorkspaceIdentityInput,
  callerSupabase?: SupabaseClient,
): Promise<UpdateWorkspaceIdentityResult> {
  const updates: Record<string, string | null> = {};

  if ("name" in input) {
    const result = validateName(input.name);
    if ("message" in result) {
      return { success: false, error: { code: "validation", field: "name", message: result.message } };
    }
    updates.name = result.value;
  }

  if ("legal_name" in input) {
    const result = validateNullableText(input.legal_name, "legal_name", { maxLen: MAX_LEGAL_NAME_LEN });
    if ("message" in result) {
      return { success: false, error: { code: "validation", field: "legal_name", message: result.message } };
    }
    updates.legal_name = result.value;
  }

  if ("commercial_phone" in input) {
    const result = validateNullableText(input.commercial_phone, "commercial_phone", {
      maxLen: 30,
      format: PHONE_RE,
      formatMessage: "'commercial_phone' has an invalid format",
    });
    if ("message" in result) {
      return { success: false, error: { code: "validation", field: "commercial_phone", message: result.message } };
    }
    updates.commercial_phone = result.value;
  }

  if ("commercial_email" in input) {
    const result = validateNullableText(input.commercial_email, "commercial_email", {
      maxLen: 254,
      format: EMAIL_RE,
      formatMessage: "'commercial_email' has an invalid format",
    });
    if ("message" in result) {
      return { success: false, error: { code: "validation", field: "commercial_email", message: result.message } };
    }
    updates.commercial_email = result.value;
  }

  if ("cnpj" in input) {
    const result = validateCnpj(input.cnpj);
    if ("message" in result) {
      return { success: false, error: { code: "validation", field: "cnpj", message: result.message } };
    }
    updates.cnpj = result.value;
  }

  if (Object.keys(updates).length === 0) {
    return {
      success: false,
      error: { code: "validation", message: "No recognized fields in request body" },
    };
  }

  const supabase = callerSupabase ?? (await createClient());

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      success: false,
      error: { code: "unauthorized", message: "You must be signed in to manage a workspace." },
    };
  }

  const { data, error } = await supabase.rpc("update_platform_workspace_identity", {
    p_account_id: input.accountId,
    p_updates: updates,
  });

  if (error) {
    return { success: false, error: translateRpcError(error) };
  }

  if (!data || typeof data !== "object") {
    console.error("[updateWorkspaceIdentity] RPC returned no account row:", data);
    return { success: false, error: { code: "unexpected", message: "Failed to update workspace identity." } };
  }

  return { success: true, account: data as WorkspaceIdentityRow };
}
