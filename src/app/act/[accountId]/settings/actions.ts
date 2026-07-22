"use server";

// ============================================================
// E5b — Server Action transport adapter for platform-side workspace
// identity updates.
//
// Thin shim: forwards the accountId (from the URL, re-validated by the
// RPC itself — never trusted as authorization) plus whichever identity
// fields the settings form actually submitted, and returns the typed
// UpdateWorkspaceIdentityResult verbatim. It does NOT re-implement
// validation, authentication, or authorization — all of that lives in
// updateWorkspaceIdentity() and the SECURITY DEFINER RPC (054), which
// remain the single source of truth. Mirrors the shape of
// src/app/act/actions.ts (createWorkspaceAction).
// ============================================================

import {
  updateWorkspaceIdentity,
  type UpdateWorkspaceIdentityInput,
  type UpdateWorkspaceIdentityResult,
} from "@/lib/workspaces/update-workspace-identity";

/**
 * `fields` uses the same partial-update convention as the RPC/route: a
 * key OMITTED from the object leaves that column unchanged; a key
 * present with value `null` clears it.
 */
export async function updateWorkspaceIdentityAction(
  accountId: string,
  fields: Omit<UpdateWorkspaceIdentityInput, "accountId">,
): Promise<UpdateWorkspaceIdentityResult> {
  return updateWorkspaceIdentity({ accountId, ...fields });
}
