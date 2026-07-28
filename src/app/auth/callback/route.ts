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
//
// Base URL: we build every redirect from `getBaseUrl(request)`
// (@/lib/http/base-url), NOT `new URL(request.url).origin`. The
// latter reflects whatever `Host` the Node process itself received —
// on this app's Hostinger Managed Node.js deploy the reverse proxy
// does not forward the original `Host`, so `request.url` resolved to
// `http://localhost:3000` and every password-reset / magic-link
// email redirected users there instead of the public domain. The
// code ran correctly (hence `auth_callback_failed` showing up
// verbatim), only the redirect target was wrong. getBaseUrl() prefers
// X-Forwarded-Host / NEXT_PUBLIC_SITE_URL over the raw request origin
// and is shared with /api/account/invitations, which hit this same
// bug class first.
// ============================================================

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolvePostAuthDestination } from "@/lib/auth/post-login-redirect";
import { getBaseUrl } from "@/lib/http/base-url";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const baseUrl = getBaseUrl(request);
  const code = searchParams.get("code");
  // Constrained to same-origin relative paths only — an open
  // `next` param taken verbatim would be an open-redirect vector.
  const rawNext = searchParams.get("next");
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : null;

  if (!code) {
    return NextResponse.redirect(`${baseUrl}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[auth/callback] exchangeCodeForSession error:", error.message);
    return NextResponse.redirect(`${baseUrl}/login?error=auth_callback_failed`);
  }

  if (next) {
    return NextResponse.redirect(`${baseUrl}${next}`);
  }

  // No explicit destination (e.g. a bare magic link) — send active
  // platform operators to /act, everyone else to /dashboard.
  const destination = await resolvePostAuthDestination(supabase);
  return NextResponse.redirect(`${baseUrl}${destination}`);
}
