import { describe, expect, it } from "vitest";
import { isValidCnpj, normalizeCnpj } from "../src/lib/workspaces/create-workspace";

interface WorkspaceDef {
  name: string;
  cnpj: string;
  ownerName: string;
  ownerEmail: string;
}

const WORKSPACES: WorkspaceDef[] = [
  {
    name: "Oral Unic Contagem",
    cnpj: "42.689.093/0001-53",
    ownerName: "Izabela Caroline Resende",
    ownerEmail: "administrativo@oraluniccontagem.com.br",
  },
  {
    name: "Oral Unic Almirante Tamandaré",
    cnpj: "43.615.570/0001-07",
    ownerName: "Carla Elize Wauczinski",
    ownerEmail: "administrativo@oralunicalmirantetamandare.com.br",
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

describe("Workspace definitions", () => {
  it("has exactly 2 workspaces", () => {
    expect(WORKSPACES).toHaveLength(2);
  });

  it.each(WORKSPACES)("$name has a valid CNPJ", (ws) => {
    expect(isValidCnpj(ws.cnpj)).toBe(true);
  });

  it.each(WORKSPACES)("$name has a valid owner email", (ws) => {
    expect(EMAIL_RE.test(ws.ownerEmail)).toBe(true);
  });

  it.each(WORKSPACES)("$name has a non-empty name", (ws) => {
    expect(ws.name.trim()).not.toHaveLength(0);
  });

  it.each(WORKSPACES)("$name has a non-empty owner name", (ws) => {
    expect(ws.ownerName.trim()).not.toHaveLength(0);
  });
});

describe("CNPJ normalization for RPC", () => {
  it("strips mask from Oral Unic Contagem CNPJ", () => {
    expect(normalizeCnpj(WORKSPACES[0].cnpj)).toBe("42689093000153");
  });

  it("strips mask from Oral Unic Almirante Tamandaré CNPJ", () => {
    expect(normalizeCnpj(WORKSPACES[1].cnpj)).toBe("43615570000107");
  });
});
