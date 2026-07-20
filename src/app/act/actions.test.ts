import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateWorkspaceResult } from "@/lib/workspaces/create-workspace";

// Mock the Lote 2 layer BEFORE importing the action. This keeps the test
// hermetic (the real module statically imports next/headers via the server
// Supabase client, which must never load in a node test) and lets us assert
// exactly what the transport adapter forwards.
const createPlatformWorkspace = vi.fn<
  (input: { name: string; cnpj?: string | null }) => Promise<CreateWorkspaceResult>
>();

vi.mock("@/lib/workspaces/create-workspace", () => ({
  createPlatformWorkspace: (input: { name: string; cnpj?: string | null }) =>
    createPlatformWorkspace(input),
}));

import { createWorkspaceAction } from "./actions";

beforeEach(() => {
  createPlatformWorkspace.mockReset();
});

describe("createWorkspaceAction", () => {
  it("forwards { name, cnpj } exactly to the Lote 2 layer", async () => {
    createPlatformWorkspace.mockResolvedValue({ success: true, accountId: "acc-1" });

    await createWorkspaceAction({ name: "Acme", cnpj: "11.222.333/0001-81" });

    expect(createPlatformWorkspace).toHaveBeenCalledExactlyOnceWith({
      name: "Acme",
      cnpj: "11.222.333/0001-81",
    });
  });

  it("normalizes an omitted CNPJ to null", async () => {
    createPlatformWorkspace.mockResolvedValue({ success: true, accountId: "acc-1" });

    await createWorkspaceAction({ name: "Acme" });

    expect(createPlatformWorkspace).toHaveBeenCalledWith({
      name: "Acme",
      cnpj: null,
    });
  });

  it("normalizes a null CNPJ to null (passes through)", async () => {
    createPlatformWorkspace.mockResolvedValue({ success: true, accountId: "acc-1" });

    await createWorkspaceAction({ name: "Acme", cnpj: null });

    expect(createPlatformWorkspace).toHaveBeenCalledWith({
      name: "Acme",
      cnpj: null,
    });
  });

  it("preserves a success result verbatim", async () => {
    const result: CreateWorkspaceResult = { success: true, accountId: "acc-42" };
    createPlatformWorkspace.mockResolvedValue(result);

    await expect(
      createWorkspaceAction({ name: "Acme", cnpj: "11222333000181" }),
    ).resolves.toEqual(result);
  });

  it.each([
    ["validation", { code: "validation", field: "cnpj", message: "Invalid CNPJ." }],
    ["unauthorized", { code: "unauthorized", message: "This action requires an active platform admin." }],
    ["conflict", { code: "conflict", field: "cnpj", message: "A workspace with this CNPJ already exists." }],
    ["unexpected", { code: "unexpected", message: "Failed to create workspace." }],
  ] as const)("preserves the %s error result verbatim", async (_label, error) => {
    const result: CreateWorkspaceResult = { success: false, error };
    createPlatformWorkspace.mockResolvedValue(result);

    await expect(
      createWorkspaceAction({ name: "Acme" }),
    ).resolves.toEqual(result);
  });

  it("never forwards caller-supplied identity fields", async () => {
    createPlatformWorkspace.mockResolvedValue({ success: true, accountId: "acc-1" });

    await createWorkspaceAction({
      name: "Acme",
      cnpj: "11222333000181",
      // Attacker-controlled extras must be dropped by the adapter.
      ...({ owner_user_id: "attacker", actor_user_id: "attacker", user_id: "x" } as object),
    });

    const [arg] = createPlatformWorkspace.mock.calls[0];
    expect(Object.keys(arg).sort()).toEqual(["cnpj", "name"]);
  });
});
