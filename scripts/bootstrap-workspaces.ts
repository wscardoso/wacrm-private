#!/usr/bin/env node
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "..", ".env.local");
const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BOOTSTRAP_OPERATOR_EMAIL",
  "BOOTSTRAP_OPERATOR_PASSWORD",
] as const;

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

function normalizeCnpj(raw: string): string {
  return raw.replace(/\D/g, "");
}

function status(msg: string): void {
  process.stderr.write(`[bootstrap] ${msg}\n`);
}

function fatal(msg: string): never {
  process.stderr.write(`[bootstrap] ABORT: ${msg}\n`);
  process.exit(1);
}

function loadEnvLocal(): void {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`.env.local not found at ${ENV_PATH}`);
  }
  const text = fs.readFileSync(ENV_PATH, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) fatal(`${key} is required in .env.local`);
  return val;
}

async function ensureAuthUser(
  admin: SupabaseClient,
  email: string,
  fullName: string,
): Promise<{ created: boolean }> {
  const { error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) {
    if (
      error.message?.includes("already exists") ||
      error.message?.includes("already registered")
    ) {
      return { created: false };
    }
    fatal(`Failed to create auth user ${email}: ${error.message}`);
  }
  return { created: true };
}

async function findAccountByCnpj(
  admin: SupabaseClient,
  cnpjDigits: string,
): Promise<string | null> {
  const { data } = await admin
    .from("accounts")
    .select("id")
    .eq("cnpj", cnpjDigits)
    .maybeSingle();
  return data?.id ?? null;
}

interface WorkspaceResult {
  name: string;
  status: "created" | "exists" | "skipped" | "error";
  accountId?: string;
  error?: string;
}

async function createWorkspace(
  auth: SupabaseClient,
  def: WorkspaceDef,
): Promise<WorkspaceResult> {
  const cnpjDigits = normalizeCnpj(def.cnpj);

  const existingId = await findAccountByCnpj(
    createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    ),
    cnpjDigits,
  );
  if (existingId) {
    return { name: def.name, status: "exists", accountId: existingId };
  }

  const { data, error } = await auth.rpc("create_platform_workspace", {
    p_name: def.name,
    p_cnpj: cnpjDigits,
    p_owner_email: def.ownerEmail,
  });

  if (error) {
    if (error.code === "23505") {
      return { name: def.name, status: "exists" };
    }
    if (error.code === "22023") {
      return { name: def.name, status: "skipped", error: error.message };
    }
    return { name: def.name, status: "error", error: error.message };
  }

  if (typeof data !== "string" || data === "") {
    return {
      name: def.name,
      status: "error",
      error: "RPC returned empty account ID",
    };
  }

  return { name: def.name, status: "created", accountId: data };
}

async function main(): Promise<void> {
  loadEnvLocal();

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const operatorEmail = requireEnv("BOOTSTRAP_OPERATOR_EMAIL");
  const operatorPassword = requireEnv("BOOTSTRAP_OPERATOR_PASSWORD");

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  status("Signing in as platform operator...");
  const { error: signInError } = await anon.auth.signInWithPassword({
    email: operatorEmail,
    password: operatorPassword,
  });
  if (signInError) {
    fatal(
      `Platform operator sign-in failed: ${signInError.message}. ` +
        `Verify BOOTSTRAP_OPERATOR_EMAIL / BOOTSTRAP_OPERATOR_PASSWORD in .env.local`,
    );
  }
  status(`Authenticated as ${operatorEmail}`);

  const results: WorkspaceResult[] = [];

  for (const ws of WORKSPACES) {
    status(`Processing workspace: ${ws.name}`);

    const { created } = await ensureAuthUser(admin, ws.ownerEmail, ws.ownerName);
    if (created) {
      status(`  Created auth user for ${ws.ownerEmail}`);
    } else {
      status(`  Auth user ${ws.ownerEmail} already exists`);
    }

    const result = await createWorkspace(anon, ws);
    results.push(result);
  }

  await anon.auth.signOut();

  process.stdout.write("\n");
  process.stdout.write("============================================================\n");
  process.stdout.write("  BOOTSTRAP SUMMARY\n");
  process.stdout.write("============================================================\n");

  for (const r of results) {
    const icon =
      r.status === "created"
        ? "CREATED"
        : r.status === "exists"
          ? "EXISTS"
          : r.status === "skipped"
            ? "SKIPPED"
            : "ERROR";
    process.stdout.write(`  ${r.name.padEnd(35)} ${icon}`);
    if (r.accountId) process.stdout.write(`  id=${r.accountId}`);
    if (r.error) process.stdout.write(`  reason=${r.error}`);
    process.stdout.write("\n");
  }

  process.stdout.write("============================================================\n");

  const okCount = results.filter(
    (r) => r.status === "created" || r.status === "exists",
  ).length;
  const errorCount = results.filter((r) => r.status === "error").length;

  if (errorCount > 0) {
    process.stdout.write(
      `  ${okCount} OK, ${errorCount} ERROR(S) — review above.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`  All ${results.length} workspaces ready.\n`);
  process.stdout.write("============================================================\n\n");
}

main().catch((err) => {
  fatal(err instanceof Error ? err.message : String(err));
});
