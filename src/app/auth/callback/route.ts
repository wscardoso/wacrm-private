// ============================================================
// /auth/callback
//
// Server-side landing point for every Supabase Auth email link that
// carries a PKCE `?code=` param: password recovery
// (forgot-password/page.tsx sets redirectTo here), signup email
// confirmation, and magic links. Previously this route did not exist
// at all — every one of those flows 404'd or, for magic links
// (auto-consumed client-side by `detectSessionInUrl`), silently
// landed the visitor back on a bare login form with no session
// established server-side (cookies never got the exchanged tokens).
//
// Exchanging the code here, server-side, is what actually persists
// the session into cookies via the `@supabase/ssr` server client —
// the client-side auto-detection in src/lib/supabase/client.ts only
// helps when the code was issued by *this* browser's own
// signInWithOtp/signUp call (it needs a locally-stored PKCE verifier
// that a Dashboard/Admin-API-issued link won't have). Routing every
// email link through this handler removes that dependency entirely.
// ============================================================

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolvePostAuthDestination } from "@/lib/auth/post-login-redirect";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Constrained to same-origin relative paths only — an open
  // `next` param taken verbatim would be an open-redirect vector.
  const rawNext = searchParams.get("next");
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : null;

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] exchangeCodeForSession error:", error.message);
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  if (next) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  // No explicit destination (e.g. a bare magic link) — send active
  // platform operators to /act, everyone else to /dashboard.
  const destination = await resolvePostAuthDestination(supabase);
  return NextResponse.redirect(`${origin}${destination}`);
}
