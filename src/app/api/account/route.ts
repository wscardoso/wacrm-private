// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — update the account's identity fields.        Admin+.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
//
// E5a (docs/architecture/E5-workspace-commercial-identity.md) extends
// PATCH beyond `name` to also accept the three commercial-identity
// columns from migration 053 (legal_name, commercial_phone,
// commercial_email) plus a correction path for `cnpj` (041) — this is
// the SAME rename endpoint extended, not a second write path (§2/§3
// of the contract). Validation format rules are enforced here too
// (defense in depth / clean 400s) but the DB CHECK constraints (053)
// are the authoritative gate — both this route and the E5b platform
// RPC (054) write the same columns under the same constraints, so
// they cannot diverge (contract §5).
//
// Partial-update semantics (contract §7.5), normative:
//   - a key OMITTED from the JSON body leaves that field UNCHANGED;
//   - a key present with value `null` CLEARS that field;
//   - `name` is the one exception — it is NOT NULL at the schema
//     level (001), so explicit `null` for `name` is a validation
//     error, not a clear.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import {
  MAX_NAME_LEN,
  MAX_LEGAL_NAME_LEN,
  PHONE_RE,
  EMAIL_RE,
  validateName,
  validateNullableText,
  validateCnpj,
} from "@/lib/workspaces/identity-validation";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

interface PatchBody {
  name?: unknown;
  legal_name?: unknown;
  commercial_phone?: unknown;
  commercial_email?: unknown;
  cnpj?: unknown;
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Same bucket as before
    // this route was extended — E5a extends the rename path, it does
    // not introduce a second one (contract §2/§13 risk 3).
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as PatchBody | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }

    const update: Record<string, string | null> = {};

    if ("name" in body) {
      const result = validateName(body.name);
      if ("message" in result) {
        return NextResponse.json({ error: result.message, field: result.field }, { status: 400 });
      }
      update.name = result.value;
    }

    if ("legal_name" in body) {
      const result = validateNullableText(body.legal_name, "legal_name", {
        maxLen: MAX_LEGAL_NAME_LEN,
      });
      if ("message" in result) {
        return NextResponse.json({ error: result.message, field: result.field }, { status: 400 });
      }
      update.legal_name = result.value;
    }

    if ("commercial_phone" in body) {
      const result = validateNullableText(body.commercial_phone, "commercial_phone", {
        maxLen: 30,
        format: PHONE_RE,
        formatMessage: "'commercial_phone' has an invalid format",
      });
      if ("message" in result) {
        return NextResponse.json({ error: result.message, field: result.field }, { status: 400 });
      }
      update.commercial_phone = result.value;
    }

    if ("commercial_email" in body) {
      const result = validateNullableText(body.commercial_email, "commercial_email", {
        maxLen: 254,
        format: EMAIL_RE,
        formatMessage: "'commercial_email' has an invalid format",
      });
      if ("message" in result) {
        return NextResponse.json({ error: result.message, field: result.field }, { status: 400 });
      }
      update.commercial_email = result.value;
    }

    if ("cnpj" in body) {
      const result = validateCnpj(body.cnpj);
      if ("message" in result) {
        return NextResponse.json({ error: result.message, field: result.field }, { status: 400 });
      }
      update.cnpj = result.value;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: "No recognized fields in request body" },
        { status: 400 },
      );
    }

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireRole already
    // guaranteed the caller is admin+. The CHECK constraints from 053
    // (and the pre-existing ones from 041/021) are the authoritative
    // validation gate; the checks above just produce clean 400s
    // instead of a raw Postgres error surfacing to the client.
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(update)
      .eq("id", ctx.accountId)
      .select("id, name, legal_name, commercial_phone, commercial_email, cnpj")
      .single();

    if (error) {
      if (error.code === "23505") {
        // Partial unique index on cnpj (041) — another tenant already
        // has this CNPJ.
        return NextResponse.json(
          { error: "This CNPJ is already registered to another account", field: "cnpj" },
          { status: 409 },
        );
      }
      if (error.code === "23514") {
        // A CHECK constraint (053/041/021) rejected the value — this
        // should be rare given the app-layer validation above, but the
        // DB is the authoritative gate (contract §5).
        return NextResponse.json(
          { error: "One or more fields failed validation" },
          { status: 400 },
        );
      }
      console.error("[PATCH /api/account] update error:", error);
      return NextResponse.json(
        { error: "Failed to update account" },
        { status: 500 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
