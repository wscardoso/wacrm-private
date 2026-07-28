import { describe, expect, it, vi } from "vitest";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import {
  assignPlatformOperatorAccount,
  grantPlatformOperator,
  listPlatformOperators,
  lookupOperatorUserIdByEmail,
  revokePlatformOperator,
  unassignPlatformOperatorAccount,
} from "./operators";

// Fake Supabase client — always injected explicitly (callerSupabase), so
// createClient()/next/headers cookies() is never invoked in this unit
// test. Mirrors src/lib/crypto/keyLifecycle.test.ts's pattern.

const USER = { id: "admin-1" };

function pgError(code: string, message = "boom"): PostgrestError {
  return { code, message, details: "", hint: "", name: "PostgrestError" } as PostgrestError;
}

function fakeClient(overrides?: {
  user?: typeof USER | null;
  rpcImpl?: (name: string, params: Record<string, unknown>) => { data: unknown; error: PostgrestError | null };
}) {
  const user = overrides?.user === undefined ? USER : overrides.user;
  const rpcImpl = overrides?.rpcImpl ?? (() => ({ data: null, error: null }));

  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => rpcImpl(name, params));
  const getUser = vi.fn(async () => ({ data: { user } }));

  return { client: { auth: { getUser }, rpc } as unknown as SupabaseClient, rpc, getUser };
}

describe("listPlatformOperators", () => {
  it("returns the operator directory on success", async () => {
    const rows = [
      {
        user_id: "op-1",
        email: "op1@forcecrm.test",
        role: "operator",
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        assigned_accounts: [],
      },
    ];
    const { client, rpc } = fakeClient({ rpcImpl: () => ({ data: rows, error: null }) });

    const result = await listPlatformOperators(client);

    expect(result).toEqual({ success: true, operators: rows });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("list_platform_operators");
  });

  it("returns unauthorized without calling the RPC when there is no session", async () => {
    const { client, rpc } = fakeClient({ user: null });

    const result = await listPlatformOperators(client);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("unauthorized");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("translates a 42501 error and PRESERVES the RPC's own message (non-admin operator)", async () => {
    const { client } = fakeClient({
      rpcImpl: () => ({ data: null, error: pgError("42501", "This action requires an active platform admin") }),
    });

    const result = await listPlatformOperators(client);

    expect(result).toEqual({
      success: false,
      error: { code: "unauthorized", message: "This action requires an active platform admin" },
    });
  });

  it("defaults data to an empty array when the RPC returns null", async () => {
    const { client } = fakeClient({ rpcImpl: () => ({ data: null, error: null }) });

    const result = await listPlatformOperators(client);

    expect(result).toEqual({ success: true, operators: [] });
  });
});

describe("lookupOperatorUserIdByEmail", () => {
  it("resolves an email to a user id", async () => {
    const { client, rpc } = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe("platform_lookup_user_id_by_email");
        expect(params).toEqual({ p_email: "candidate@forcecrm.test" });
        return { data: "user-xyz", error: null };
      },
    });

    const result = await lookupOperatorUserIdByEmail("candidate@forcecrm.test", client);

    expect(result).toEqual({ success: true, userId: "user-xyz" });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("translates 22023 (no user found) preserving the real message", async () => {
    const { client } = fakeClient({
      rpcImpl: () => ({ data: null, error: pgError("22023", "No user found with email nobody@forcecrm.test") }),
    });

    const result = await lookupOperatorUserIdByEmail("nobody@forcecrm.test", client);

    expect(result).toEqual({
      success: false,
      error: { code: "validation", message: "No user found with email nobody@forcecrm.test" },
    });
  });

  it("returns unauthorized without calling the RPC when there is no session", async () => {
    const { client, rpc } = fakeClient({ user: null });

    const result = await lookupOperatorUserIdByEmail("x@forcecrm.test", client);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("unauthorized");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("treats a non-string RPC result as unexpected", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ rpcImpl: () => ({ data: null, error: null }) });

    const result = await lookupOperatorUserIdByEmail("x@forcecrm.test", client);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("unexpected");
    spy.mockRestore();
  });
});

describe("grantPlatformOperator — 037, UNCHANGED signature", () => {
  it("forwards p_user_id/p_role and never invents an actor/timestamp field", async () => {
    const { client, rpc } = fakeClient({ rpcImpl: () => ({ data: null, error: null }) });

    const result = await grantPlatformOperator("target-user", "admin", client);

    expect(result).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("grant_platform_operator", {
      p_user_id: "target-user",
      p_role: "admin",
    });
  });

  it("preserves the RPC's self-promotion rejection message (22023)", async () => {
    const { client } = fakeClient({
      rpcImpl: () => ({ data: null, error: pgError("22023", "Cannot grant operator status to yourself") }),
    });

    const result = await grantPlatformOperator(USER.id, "operator", client);

    expect(result).toEqual({
      success: false,
      error: { code: "validation", message: "Cannot grant operator status to yourself" },
    });
  });
});

describe("revokePlatformOperator — 037, UNCHANGED signature", () => {
  it("forwards p_user_id only", async () => {
    const { client, rpc } = fakeClient({ rpcImpl: () => ({ data: null, error: null }) });

    const result = await revokePlatformOperator("target-user", client);

    expect(result).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("revoke_platform_operator", { p_user_id: "target-user" });
  });

  it("preserves the RPC's self-revocation rejection message (22023)", async () => {
    const { client } = fakeClient({
      rpcImpl: () => ({ data: null, error: pgError("22023", "Cannot revoke your own operator status") }),
    });

    const result = await revokePlatformOperator(USER.id, client);

    expect(result).toEqual({
      success: false,
      error: { code: "validation", message: "Cannot revoke your own operator status" },
    });
  });
});

describe("assignPlatformOperatorAccount — 037, UNCHANGED signature", () => {
  it("forwards p_operator_user_id/p_account_id/p_access_role", async () => {
    const { client, rpc } = fakeClient({ rpcImpl: () => ({ data: null, error: null }) });

    const result = await assignPlatformOperatorAccount("op-1", "acc-1", "viewer", client);

    expect(result).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("assign_platform_operator_account", {
      p_operator_user_id: "op-1",
      p_account_id: "acc-1",
      p_access_role: "viewer",
    });
  });
});

describe("unassignPlatformOperatorAccount — 037, UNCHANGED signature", () => {
  it("forwards p_operator_user_id/p_account_id only", async () => {
    const { client, rpc } = fakeClient({ rpcImpl: () => ({ data: null, error: null }) });

    const result = await unassignPlatformOperatorAccount("op-1", "acc-1", client);

    expect(result).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("unassign_platform_operator_account", {
      p_operator_user_id: "op-1",
      p_account_id: "acc-1",
    });
  });
});
