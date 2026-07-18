import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getProvider, type ProviderConfig } from '@/lib/whatsapp/providers';
import type { InboundMessage } from '@/lib/whatsapp/providers/types';
import { processInboundMessage } from '@/lib/whatsapp/inbound-processor';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  constantTimeEqual,
  hashWebhookSecret,
} from '@/lib/whatsapp/webhook-auth';

// =============================================================
// Non-Meta WhatsApp webhook endpoint (Z-API, uazapi).
//
// URL contract (ADR-SEC-001 / C7):
//   GET  /api/whatsapp/webhook/{provider}/{connectionId}/{webhookSecret}
//   POST /api/whatsapp/webhook/{provider}/{connectionId}/{webhookSecret}
//
// Authentication:
//   1. Rate-limit by connection_id (fixed-window, reuse existing limiter).
//   2. Resolve the connection DIRECTLY by indexed connection_id — no O(n)
//      scan over every whatsapp_config and no per-row decrypt/compare loop.
//   3. Require config.provider === URL provider (provider mismatch → 401).
//   4. Constant-time compare the SHA-256 of the URL secret against the
//      stored webhook_secret_hash. There is NO fallback to the legacy
//      verify_token; a NULL hash → uniform 401.
//   5. Every auth failure returns the SAME 401 { error: "Unauthorized" }
//      regardless of which step failed (no enumeration oracle).
//
// The Meta (C4) webhook is handled by a separate route and is untouched.
// =============================================================

const INVALID = { error: 'Unauthorized' } as const;

function unauthorized(): NextResponse {
  return NextResponse.json(INVALID, { status: 401 });
}

interface ResolvedConfig {
  id: string;
  user_id: string;
  account_id: string;
  provider: string;
  access_token: string;
  webhook_secret_hash: string | null;
  instance_id: string | null;
  base_url: string | null;
  connection_id: string;
}

async function resolveConfig(connectionId: string): Promise<ResolvedConfig | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, user_id, account_id, access_token, instance_id, base_url, provider, connection_id, webhook_secret_hash')
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    ...(data as object),
    access_token: data.access_token ? decrypt(data.access_token) : data.access_token,
  } as ResolvedConfig;
}

/**
 * Returns a NextResponse when authentication FAILS, or null when it succeeds
 * (in which case `out.config` holds the resolved config). The function never
 * returns the legacy verify_token and never distinguishes failure reasons.
 */
async function authenticate(
  provider: string,
  connectionId: string,
  webhookSecret: string | undefined,
  out: { config?: ResolvedConfig },
): Promise<NextResponse | null> {
  // Rate-limit keyed on the public connection identifier. Even a 401 burns
  // a token so a scanner can't exhaust the budget to hide its hit rate.
  const rl = checkRateLimit(`webhook-nonmeta:${connectionId}`, RATE_LIMITS.webhookNonMeta);
  if (!rl.success) return rateLimitResponse(rl);

  if (!connectionId || !webhookSecret) return unauthorized();

  const config = await resolveConfig(connectionId);
  if (!config) return unauthorized();

  if (config.provider !== provider) return unauthorized();

  if (!config.webhook_secret_hash) return unauthorized();

  const receivedHash = hashWebhookSecret(webhookSecret);
  if (!constantTimeEqual(receivedHash, config.webhook_secret_hash)) {
    return unauthorized();
  }

  out.config = config;
  return null;
}

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ provider: string; connectionId: string; webhookSecret: string }> },
) {
  const { provider, connectionId, webhookSecret } = await params;
  const out: { config?: ResolvedConfig } = {};
  const rejected = await authenticate(provider, connectionId, webhookSecret, out);
  if (rejected) return rejected;
  // Non-Meta providers do not support a GET verification handshake. After a
  // successful auth we still reject the method (no open "200 OK" endpoint).
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; connectionId: string; webhookSecret: string }> },
) {
  const { provider, connectionId, webhookSecret } = await params;
  const out: { config?: ResolvedConfig } = {};
  const rejected = await authenticate(provider, connectionId, webhookSecret, out);
  if (rejected) return rejected;
  const config = out.config!;

  const providerConfig: ProviderConfig =
    provider === 'zapi'
      ? { provider: 'zapi', instanceId: config.instance_id ?? '', accessToken: config.access_token }
      : { provider: 'uazapi', baseUrl: config.base_url ?? '', instanceId: config.instance_id ?? '', accessToken: config.access_token };
  const providerInstance = getProvider(providerConfig);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Z-API delivers a single message object; uazapi (Evolution) may deliver
  // an array of messages inside payload.data. Normalize to an array of
  // parsed events and dispatch each independently so one malformed event
  // never blocks the others.
  const events: InboundMessage[] = [];

  if (provider === 'zapi') {
    const parsed = providerInstance.parseInboundMessage(payload);
    if (parsed) events.push(parsed);
  } else {
    const arr = Array.isArray(payload) ? payload : (payload as { data?: unknown[] })?.data;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const parsed = providerInstance.parseInboundMessage(item);
        if (parsed) events.push(parsed);
      }
    } else if (arr !== undefined) {
      const parsed = providerInstance.parseInboundMessage(arr);
      if (parsed) events.push(parsed);
    }
  }

  for (const event of events) {
    try {
      await processInboundMessage(event, config.account_id, config.user_id);
    } catch (err) {
      console.error('[webhook] processInboundMessage failed:', err);
    }
  }

  return NextResponse.json({
    received: true,
    processed: events.length,
  });
}
