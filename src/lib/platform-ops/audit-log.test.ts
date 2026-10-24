import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AuditLogError, fetchAuditPage } from "./audit-log";

function row(id: number) {
  return {
    id,
    created_at: "2026-10-24T12:00:00Z",
    action: "update_workspace_identity",
    actor_user_id: "u1",
    actor_email: "op@example.test",
    actor_is_operator: true,
    target_user_id: null,
    target_user_email: null,
    metadata: { fields_changed: ["name"] },
  };
}

function fakeClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

describe("fetchAuditPage", () => {
  it("asks the RPC for pageSize + 1 rows and reports no next page when it gets fewer", async () => {
    const { client, rpc } = fakeClient({ data: [row(3), row(2)], error: null });

    const page = await fetchAuditPage(client, "acc-1", null, 5);

    expect(rpc).toHaveBeenCalledWith("list_platform_audit_log", { p_account_id: "acc-1", p_limit: 6, p_before_id: null });
    expect(page.entries.map((e) => e.id)).toEqual(["3", "2"]);
    expect(page.nextCursor).toBeNull();
  });

  it("drops the sentinel row and exposes the last shown id as the next cursor", async () => {
    const { client } = fakeClient({ data: [row(9), row(8), row(7)], error: null });

    const page = await fetchAuditPage(client, "acc-1", null, 2);

    expect(page.entries.map((e) => e.id)).toEqual(["9", "8"]);
    expect(page.nextCursor).toBe("8");
  });

  it("passes the cursor through as p_before_id", async () => {
    const { client, rpc } = fakeClient({ data: [], error: null });

    await fetchAuditPage(client, "acc-1", "8", 2);

    expect(rpc).toHaveBeenCalledWith("list_platform_audit_log", { p_account_id: "acc-1", p_limit: 3, p_before_id: "8" });
  });

  it("maps 42501 to an unauthorized AuditLogError and anything else to unexpected", async () => {
    const denied = await fetchAuditPage(fakeClient({ data: null, error: { code: "42501", message: "nope" } }).client, "a").catch((e) => e);
    expect(denied).toBeInstanceOf(AuditLogError);
    expect(denied).toMatchObject({ code: "unauthorized" });

    const broken = await fetchAuditPage(fakeClient({ data: null, error: { code: "XX000", message: "boom" } }).client, "a").catch((e) => e);
    expect(broken).toMatchObject({ code: "unexpected", message: "boom" });
  });

  it("keeps ids as strings so large bigints never lose precision", async () => {
    const { client } = fakeClient({ data: [{ ...row(1), id: "9007199254740993" }], error: null });

    const page = await fetchAuditPage(client, "acc-1");

    expect(page.entries[0].id).toBe("9007199254740993");
  });
});
