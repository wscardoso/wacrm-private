import { describe, expect, it, vi } from "vitest";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import {
  createPlatformWorkspace,
  isValidCnpj,
  isValidCnpjDigits,
  normalizeCnpj,
} from "./create-workspace";

// Two independently-valid CNPJs (verified against the mod-11 algorithm).
const VALID_CNPJ_DIGITS = "11222333000181";
const VALID_CNPJ_MASKED = "11.222.333/0001-81";
const VALID_CNPJ_DIGITS_2 = "11444777000161";

// ------------------------------------------------------------
// Fake Supabase client
// ------------------------------------------------------------

interface FakeOpts {
  user?: { id: string } | null;
  rpc?: { data: unknown; error: PostgrestError | null };
}

function pgError(code: string, message = "boom"): PostgrestError {
  return { code, message, details: "", hint: "", name: "PostgrestError" } as PostgrestError;
}

function fakeClient(opts: FakeOpts) {
  const rpc = vi.fn().mockResolvedValue(
    opts.rpc ?? { data: null, error: null },
  );
  const getUser = vi.fn().mockResolvedValue({
    data: { user: opts.user === undefined ? { id: "admin-1" } : opts.user },
    error: null,
  });
  const client = { auth: { getUser }, rpc } as unknown as SupabaseClient;
  return { client, rpc, getUser };
}

// ------------------------------------------------------------
// Pure CNPJ helpers
// ------------------------------------------------------------

describe("normalizeCnpj", () => {
  it("strips mask characters to bare digits", () => {
    expect(normalizeCnpj(VALID_CNPJ_MASKED)).toBe(VALID_CNPJ_DIGITS);
  });

  it("is a no-op on already-normalized digits", () => {
    expect(normalizeCnpj(VALID_CNPJ_DIGITS)).toBe(VALID_CNPJ_DIGITS);
  });
});

describe("isValidCnpj / isValidCnpjDigits", () => {
  it("accepts a valid CNPJ with mask", () => {
    expect(isValidCnpj(VALID_CNPJ_MASKED)).toBe(true);
  });

  it("accepts a valid CNPJ without mask", () => {
    expect(isValidCnpj(VALID_CNPJ_DIGITS)).toBe(true);
    expect(isValidCnpjDigits(VALID_CNPJ_DIGITS)).toBe(true);
  });

  it("rejects a wrong-length / malformed string", () => {
    expect(isValidCnpjDigits("123")).toBe(false);
    expect(isValidCnpjDigits("1122233300018")).toBe(false); // 13 digits
    expect(isValidCnpj("not-a-cnpj")).toBe(false);
  });

  it("rejects invalid check digits", () => {
    expect(isValidCnpjDigits("11222333000180")).toBe(false);
  });

  it("rejects an all-same-digit sequence that passes checksum shape", () => {
    expect(isValidCnpjDigits("00000000000000")).toBe(false);
    expect(isValidCnpjDigits("11111111111111")).toBe(false);
  });
});

// ------------------------------------------------------------
// createPlatformWorkspace
// ------------------------------------------------------------

describe("createPlatformWorkspace", () => {
  // Expected RPC args helper — ownerEmail maps to p_owner_email.
  function rpcArgs(
    overrides: { p_name?: string; p_cnpj?: string | null; p_owner_email?: string | null } = {},
  ) {
    return {
      p_name: "Acme",
      p_cnpj: null,
      p_owner_email: OWNER_EMAIL,
      ...overrides,
    };
  }

  const OWNER_EMAIL = "izabela@oralunic.com.br";

  it("provisions with a valid masked CNPJ and returns the account id", async () => {
    const { client, rpc } = fakeClient({
      rpc: { data: "acc-123", error: null },
    });

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: VALID_CNPJ_MASKED, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result).toEqual({ success: true, accountId: "acc-123" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "create_platform_workspace",
      rpcArgs({ p_cnpj: VALID_CNPJ_DIGITS, p_owner_email: OWNER_EMAIL }),
    );
  });

  it("provisions with a valid unmasked CNPJ", async () => {
    const { client, rpc } = fakeClient({
      rpc: { data: "acc-456", error: null },
    });

    const result = await createPlatformWorkspace(
      { name: "Beta", cnpj: VALID_CNPJ_DIGITS_2, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result).toEqual({ success: true, accountId: "acc-456" });
    expect(rpc).toHaveBeenCalledWith("create_platform_workspace", {
      p_name: "Beta",
      p_cnpj: VALID_CNPJ_DIGITS_2,
      p_owner_email: OWNER_EMAIL,
    });
  });

  it("normalizes CNPJ before calling the RPC (mask stripped)", async () => {
    const { client, rpc } = fakeClient({ rpc: { data: "acc-1", error: null } });

    await createPlatformWorkspace(
      { name: "Gamma", cnpj: VALID_CNPJ_MASKED, ownerEmail: OWNER_EMAIL },
      client,
    );

    const [, args] = rpc.mock.calls[0];
    expect(args.p_cnpj).toBe(VALID_CNPJ_DIGITS);
    expect(args.p_cnpj).not.toContain(".");
  });

  it("trims surrounding whitespace from the name", async () => {
    const { client, rpc } = fakeClient({ rpc: { data: "acc-1", error: null } });

    await createPlatformWorkspace(
      { name: "  Acme Co  ", cnpj: VALID_CNPJ_DIGITS, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(rpc).toHaveBeenCalledWith("create_platform_workspace", {
      p_name: "Acme Co",
      p_cnpj: VALID_CNPJ_DIGITS,
      p_owner_email: OWNER_EMAIL,
    });
  });

  it("allows an omitted CNPJ (optional at the DB level) → passes null", async () => {
    const { client, rpc } = fakeClient({ rpc: { data: "acc-1", error: null } });

    const result = await createPlatformWorkspace({ name: "No Cnpj", ownerEmail: OWNER_EMAIL }, client);

    expect(result).toEqual({ success: true, accountId: "acc-1" });
    expect(rpc).toHaveBeenCalledWith("create_platform_workspace", {
      p_name: "No Cnpj",
      p_cnpj: null,
      p_owner_email: OWNER_EMAIL,
    });
  });

  it("rejects an empty name without calling the RPC", async () => {
    const { client, rpc } = fakeClient({});

    const result = await createPlatformWorkspace(
      { name: "   ", cnpj: VALID_CNPJ_DIGITS, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result).toEqual({
      success: false,
      error: { code: "validation", field: "name", message: expect.any(String) },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid CNPJ format without calling the RPC", async () => {
    const { client, rpc } = fakeClient({});

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: "123", ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("validation");
      expect(result.error.field).toBe("cnpj");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an invalid check-digit CNPJ without calling the RPC", async () => {
    const { client, rpc } = fakeClient({});

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: "11222333000180", ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe("cnpj");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an all-same-digit CNPJ sequence without calling the RPC", async () => {
    const { client, rpc } = fakeClient({});

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: "00000000000000", ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe("cnpj");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns unauthorized when there is no authenticated user", async () => {
    const { client, rpc } = fakeClient({ user: null });

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: VALID_CNPJ_DIGITS, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("unauthorized");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("translates a 42501 RPC error to an unauthorized domain error", async () => {
    const { client } = fakeClient({
      rpc: { data: null, error: pgError("42501", "This action requires an active platform admin") },
    });

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: VALID_CNPJ_DIGITS, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("unauthorized");
  });

  it("translates a 23505 unique violation to a CNPJ conflict error", async () => {
    const { client } = fakeClient({
      rpc: {
        data: null,
        error: pgError("23505", 'duplicate key value violates unique constraint "idx_accounts_cnpj_unique"'),
      },
    });

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: VALID_CNPJ_DIGITS, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("conflict");
      expect(result.error.field).toBe("cnpj");
      // Must not leak the SQL constraint text to the UI.
      expect(result.error.message).not.toContain("idx_accounts_cnpj_unique");
      expect(result.error.message).not.toContain("duplicate key");
    }
  });

  it("does not leak SQL / stack details on an unexpected RPC error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({
      rpc: {
        data: null,
        error: pgError("XX000", 'internal: relation "accounts" pg_stack trace ...'),
      },
    });

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: VALID_CNPJ_DIGITS, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("unexpected");
      expect(result.error.message).toBe("Failed to create workspace.");
      expect(result.error.message).not.toContain("pg_stack");
      expect(result.error.message).not.toContain("accounts");
    }
    spy.mockRestore();
  });

  it("treats a missing account id from the RPC as an unexpected error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ rpc: { data: null, error: null } });

    const result = await createPlatformWorkspace(
      { name: "Acme", cnpj: VALID_CNPJ_DIGITS, ownerEmail: OWNER_EMAIL },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("unexpected");
    spy.mockRestore();
  });

  it("forwards email as p_owner_email; drops attacker-supplied user_id / actor fields", async () => {
    const { client, rpc } = fakeClient({ rpc: { data: "acc-1", error: null } });

    await createPlatformWorkspace(
      {
        name: "Acme",
        cnpj: VALID_CNPJ_DIGITS,
        ownerEmail: OWNER_EMAIL,
        // Attacker-controlled extras must be ignored by the contract.
        ...({ owner_user_id: "attacker", actor_user_id: "attacker", user_id: "x" } as object),
      },
      client,
    );

    const [, args] = rpc.mock.calls[0];
    // Only the three recognised fields reach the RPC; attacker extras are dropped.
    expect(Object.keys(args).sort()).toEqual(["p_cnpj", "p_name", "p_owner_email"]);
    expect(args.p_owner_email).toBe(OWNER_EMAIL);
  });

  it("forwards a valid ownerEmail to the RPC as p_owner_email", async () => {
    const { client, rpc } = fakeClient({ rpc: { data: "acc-1", error: null } });

    await createPlatformWorkspace(
      { name: "Oral Unic", ownerEmail: OWNER_EMAIL },
      client,
    );

    const [, args] = rpc.mock.calls[0];
    expect(args.p_owner_email).toBe(OWNER_EMAIL);
  });

  it("translates a 'No user found' RPC error to a validation error on ownerEmail", async () => {
    const { client } = fakeClient({
      rpc: {
        data: null,
        error: pgError("22023", 'No user found with email nonexistent@test.com'),
      },
    });

    const result = await createPlatformWorkspace(
      { name: "Acme", ownerEmail: "nonexistent@test.com" },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("validation");
      expect(result.error.field).toBe("ownerEmail");
      expect(result.error.message).toBe("No user found with this email.");
    }
  });

  it("rejects an obviously-invalid owner email format without calling the RPC", async () => {
    const { client, rpc } = fakeClient({});

    const result = await createPlatformWorkspace(
      { name: "Acme", ownerEmail: "not-an-email" },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("validation");
      expect(result.error.field).toBe("ownerEmail");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an empty owner email without calling the RPC", async () => {
    const { client, rpc } = fakeClient({});

    const result = await createPlatformWorkspace(
      { name: "Acme", ownerEmail: "" },
      client,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("validation");
      expect(result.error.field).toBe("ownerEmail");
      expect(result.error.message).toBe("Owner email is required.");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
