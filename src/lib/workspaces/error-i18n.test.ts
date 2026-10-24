import { describe, expect, it } from "vitest";

import en from "../../../messages/en.json";
import ptBR from "../../../messages/pt-BR.json";
import { WORKSPACE_ERROR_KEYS, workspaceErrorKey } from "./error-i18n";

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("workspaceErrorKey", () => {
  it.each([
    ["Workspace name is required.", "name_required"],
    ["Invalid CNPJ.", "cnpj_invalid"],
    ["Invalid CNPJ", "cnpj_invalid"],
    ["No user found with this email.", "owner_not_found"],
    ["A workspace with this CNPJ already exists.", "cnpj_conflict_create"],
    ["This CNPJ is already registered to another account.", "cnpj_conflict_update"],
    ["You are not authorized to manage this workspace.", "not_authorized_workspace"],
    ["Failed to update workspace identity.", "update_failed"],
    ["Account name must be 120 characters or fewer", "field_too_long"],
    ["'commercial_email' has an invalid format", "field_invalid_format"],
    ["'legal_name' cannot be an empty string — send null to clear it", "field_cannot_be_empty"],
  ])("maps %j to %s", (message, key) => {
    expect(workspaceErrorKey(message)).toBe(key);
  });

  it("returns null for a message it does not know so the caller can show the server text", () => {
    expect(workspaceErrorKey("something an RPC raised verbatim")).toBeNull();
  });
});

describe("act messages", () => {
  it("defines every workspace error key in both locales", () => {
    for (const messages of [en, ptBR]) {
      const defined = Object.keys((messages as { act: { workspace_errors: Record<string, string> } }).act.workspace_errors);
      for (const key of WORKSPACE_ERROR_KEYS) expect(defined).toContain(key);
    }
  });

  it("keeps the `act` namespace identical across en and pt-BR", () => {
    const enKeys = flatten((en as { act: Record<string, unknown> }).act).sort();
    const ptKeys = flatten((ptBR as { act: Record<string, unknown> }).act).sort();
    expect(ptKeys).toEqual(enKeys);
  });
});
