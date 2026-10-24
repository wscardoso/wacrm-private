// Maps the (English) messages produced by the workspace libs
// (create-workspace.ts, update-workspace-identity.ts, identity-validation.ts)
// onto message keys under `act.workspace_errors`, so the /act UI can show
// them in the operator's language without changing the libs' contracts
// (their tests assert the English strings).
//
// A message this table does not know — for example a text raised verbatim
// by an RPC — maps to null and the caller falls back to showing the
// server's own message. src/lib/workspaces/error-i18n.test.ts checks that
// every key exists in both locale files.

const EXACT: Record<string, string> = {
  "Workspace name is required.": "name_required",
  "Invalid CNPJ.": "cnpj_invalid",
  "Invalid CNPJ": "cnpj_invalid",
  "Owner email is required.": "owner_email_required",
  "Invalid owner email format.": "owner_email_invalid",
  "No user found with this email.": "owner_not_found",
  "This user already owns a workspace with data. Use another email or check the existing workspace.":
    "owner_has_data",
  "A workspace with this CNPJ already exists.": "cnpj_conflict_create",
  "This CNPJ is already registered to another account.": "cnpj_conflict_update",
  "This action requires an active platform admin.": "requires_admin",
  "You are not authorized to manage this workspace.": "not_authorized_workspace",
  "You must be signed in to create a workspace.": "signed_in_required",
  "You must be signed in to manage a workspace.": "signed_in_required",
  "Invalid workspace data.": "invalid_workspace_data",
  "One or more fields failed validation.": "fields_failed_validation",
  "Failed to create workspace.": "create_failed",
  "Failed to update workspace identity.": "update_failed",
  "No recognized fields in request body": "no_fields",
  "Account name cannot be empty": "name_required",
};

export const WORKSPACE_ERROR_KEYS: readonly string[] = Array.from(new Set(Object.values(EXACT))).concat([
  "field_too_long",
  "field_invalid_format",
  "field_cannot_be_empty",
]);

/** Returns the key under `act.workspace_errors` for a known message, else null. */
export function workspaceErrorKey(message: string): string | null {
  const exact = EXACT[message];
  if (exact) return exact;
  if (/characters or fewer$/.test(message)) return "field_too_long";
  if (/has an invalid format$/.test(message)) return "field_invalid_format";
  if (/cannot be an empty string/.test(message)) return "field_cannot_be_empty";
  return null;
}
