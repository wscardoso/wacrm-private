"use server";

// ============================================================
// P2.2 / P2.3-B — Server Action transport adapter for Workspace
// provisioning.
//
// This exists SOLELY to bridge the client `CreateWorkspaceDialog`
// (a Client Component) to the server-only Lote 2 layer, which cannot
// be imported into a client bundle because it statically pulls in
// next/headers via the server Supabase client.
//
// It is a thin shim: it forwards name + cnpj + ownerEmail and returns
// the typed CreateWorkspaceResult verbatim. It does NOT re-implement
// validation, authentication, authorization, or error handling — all
// of that lives in createPlatformWorkspace() (Lote 2) and the
// SECURITY DEFINER RPC (Lote 1), which remain the single source of
// truth. No caller identity / raw user_id is accepted here; the RPC
// stamps the actor from auth.uid() and resolves owner_email to a UUID
// server-side inside the SECURITY DEFINER boundary.
// ============================================================

import {
  createPlatformWorkspace,
  type CreateWorkspaceInput,
  type CreateWorkspaceResult,
} from "@/lib/workspaces/create-workspace";
import {
  assignPlatformOperatorAccount,
  grantPlatformOperator,
  listPlatformOperators,
  lookupOperatorUserIdByEmail,
  revokePlatformOperator,
  unassignPlatformOperatorAccount,
  type ListOperatorsResult,
  type OperatorActionResult,
  type PlatformAccessRoleValue,
  type PlatformOperatorRoleValue,
} from "@/lib/platform-ops/operators";

export async function createWorkspaceAction(
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  return createPlatformWorkspace({
    name: input.name,
    cnpj: input.cnpj ?? null,
    ownerEmail: input.ownerEmail,
  });
}

// ============================================================
// E9 / Fase 2 — Equipe tab Server Actions. Same shim pattern as
// createWorkspaceAction above: forward to src/lib/platform-ops/operators.ts
// (server-only, imports next/headers) so Client Components never import
// that module directly. No validation/authorization is re-implemented
// here — every RPC call inside operators.ts remains the single source
// of truth.
// ============================================================

export async function listOperatorsAction(): Promise<ListOperatorsResult> {
  return listPlatformOperators();
}

/**
 * Invite an operator by e-mail: resolves the e-mail to an existing
 * user (platform_lookup_user_id_by_email, 061), then grants operator
 * status (grant_platform_operator, 037 — UNCHANGED signature). The
 * target user must already have an account; this never creates one.
 */
export async function inviteOperatorAction(input: {
  email: string;
  role: PlatformOperatorRoleValue;
}): Promise<OperatorActionResult> {
  const lookup = await lookupOperatorUserIdByEmail(input.email);
  if (!lookup.success) {
    return { success: false, error: lookup.error };
  }
  return grantPlatformOperator(lookup.userId, input.role);
}

export async function revokeOperatorAction(input: {
  userId: string;
}): Promise<OperatorActionResult> {
  return revokePlatformOperator(input.userId);
}

export async function assignTenantAction(input: {
  operatorUserId: string;
  accountId: string;
  accessRole: PlatformAccessRoleValue;
}): Promise<OperatorActionResult> {
  return assignPlatformOperatorAccount(input.operatorUserId, input.accountId, input.accessRole);
}

export async function unassignTenantAction(input: {
  operatorUserId: string;
  accountId: string;
}): Promise<OperatorActionResult> {
  return unassignPlatformOperatorAccount(input.operatorUserId, input.accountId);
}
