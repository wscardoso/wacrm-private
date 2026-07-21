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

export async function createWorkspaceAction(
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  return createPlatformWorkspace({
    name: input.name,
    cnpj: input.cnpj ?? null,
    ownerEmail: input.ownerEmail,
  });
}
