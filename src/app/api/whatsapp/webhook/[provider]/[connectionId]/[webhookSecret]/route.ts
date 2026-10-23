import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin-client';
import { decryptWithBindingContext } from '@/lib/whatsapp/encryption';
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding';
import { getProvider, type ProviderConfig } from '@/lib/whatsapp/providers';
import type { InboundMessage } from '@/lib/whatsapp/providers/types';
import { processInboundMessage } from '@/lib/whatsapp/inbound-processor';
import { drainInboundTurnJobs } from '@/lib/agent/turn/drain';
import { handleCanonicalStatusEvent } from '@/lib/whatsapp/status-handler';
import { captureInboundFailure, classifyInboundFailure } from '@/lib/whatsapp/inbound-dlq';
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
// Non-Meta WhatsApp webhook endpoint (uazapi).
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

// Z-API support was removed. The provider segment is a fixed public literal,
// so answering for it needs no connection lookup, secret or rate-limit budget,
// and discloses nothing about any connection. Existing Z-API webhook URLs get
// 410 Gone; the stored whatsapp_config rows are left untouched.
function discontinuedProvider(provider: string): NextResponse | null {
  if (provider !== 'zapi') return null;
  return NextResponse.json({ error: 'Provider discontinued' }, { status: 410 });
}

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
  const bc = whatsappConfigBindingContext(data.account_id);
  return {
    ...(data as object),
    access_token: data.access_token ? decryptWithBindingContext(data.access_token, bc) : data.access_token,
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
  const gone = discontinuedProvider(provider);
  if (gone) return gone;
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
  const gone = discontinuedProvider(provider);
  if (gone) return gone;
  const out: { config?: ResolvedConfig } = {};
  const rejected = await authenticate(provider, connectionId, webhookSecret, out);
  if (rejected) return rejected;
  const config = out.config!;

  const providerConfig: ProviderConfig =
    { provider: 'uazapi', baseUrl: config.base_url ?? '', instanceId: config.instance_id ?? '', accessToken: config.access_token };
  const providerInstance = getProvider(providerConfig);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // =============================================================
  // Status-first dispatch (ADR-MSG-STATUS-001 §2.11, D-C).
  //
  // Each payload is checked for status events BEFORE inbound parsing,
  // so that a provider status webhook (uazapi MESSAGES_UPDATE) routes to the
  // canonical status handler instead of producing a phantom 'unknown'
  // inbound message.
  //
  // uazapi may deliver an array or { event, data: { messages: [...] } }.
  // =============================================================
  let statusCount = 0;
  let inboundCount = 0;

  // Status events are extracted from the WHOLE payload, by the adapter,
  // before any inbound interpretation. Each adapter owns its own envelope:
  // uazapi sends
  // { event: 'MESSAGES_UPDATE', data: { messages: [...] } } — where `data`
  // is an OBJECT, not an array, so it must never be fed through the
  // inbound array-unwrapping below.
  let statusEvents: ReturnType<typeof providerInstance.parseStatusEvent> = [];
  try {
    statusEvents = providerInstance.parseStatusEvent(payload);
  } catch (err) {
    console.error('[webhook] parseStatusEvent failed:', err);
  }

  if (statusEvents.length > 0) {
    // I5 — N identifiers, N independent applications: one failure must not
    // suppress the others.
    for (const statusEvent of statusEvents) {
      try {
        await handleCanonicalStatusEvent(statusEvent, config.id);
        statusCount++;
      } catch (err) {
        console.error('[webhook] status event failed:', err);
      }
    }

    return NextResponse.json({
      received: true,
      processed: 0,
      inboundProcessed: 0,
      statusProcessed: statusCount,
    });
  }

  // Not a status event — inbound path, unchanged from the pre-E2.1
  // behaviour (uazapi array or { data: [...] }).
  const events: InboundMessage[] = [];

  // C6.2 — an adapter that throws on ONE malformed item used to abort the
  // whole request with an unhandled 500 (the other items of a uazapi batch were
  // never processed and nothing was recorded). Each parse is now isolated; the
  // failure is captured below, with the config already authenticated above.
  const parseFailures: unknown[] = [];
  const safeParse = (item: unknown): InboundMessage | null => {
    try {
      return providerInstance.parseInboundMessage(item);
    } catch (err) {
      // Error CLASS only: the message may quote the offending payload.
      console.error('[webhook] parseInboundMessage failed, error_type=%s', err instanceof Error ? err.name : 'NonError');
      parseFailures.push(err);
      return null;
    }
  };

  {
    const arr = Array.isArray(payload) ? payload : (payload as { data?: unknown[] })?.data;
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const parsed = safeParse(item);
        if (parsed) events.push(parsed);
      }
    } else if (arr !== undefined) {
      const parsed = safeParse(arr);
      if (parsed) events.push(parsed);
    }
  }

  // C6.2 — failure capture is diagnostic only (minimised envelope, no original
  // payload, no replay). It is not durable recovery of the inbound message.
  //
  // HTTP (R1 / H6, UAZAPI docs):
  //   * 2xx only when every inbound event in this delivery was durably stored
  //     (message + turn job) or was not an inbound message (status, ignored callback).
  //   * persistence or parse failed, whether or not the DLQ row was written -> 500.
  //   * UAZAPI's worker does not automatically retry a non-2xx delivery
  //     (docs.uazapi.com/docs/errors-and-retries). This 500 does not recover
  //     the event through the provider. Repeated events, if they arrive, are
  //     deduped and must not re-run Flows or Automations.
  let capturedCount = 0;
  let uncapturedCount = 0;

  for (const parseErr of parseFailures) {
    const capture = await captureInboundFailure({
      accountId: config.account_id,
      configId: config.id,
      source: 'uazapi',
      stage: 'parse',
      error: parseErr,
      event: {},
    });
    if (capture.ok) capturedCount++;
    else uncapturedCount++;
  }

  for (const event of events) {
    try {
      await processInboundMessage(event, config.account_id, config.user_id, {
        deferDownstream: true,
      });
      inboundCount++;
    } catch (err) {
      const failure = classifyInboundFailure(err);
      if (failure.kind === 'post_insert') {
        console.error('[webhook] processInboundMessage failed AFTER persist (not captured):', err);
        continue;
      }
      if (failure.stage === 'unexpected') {
        // Original log line, unchanged.
        console.error('[webhook] processInboundMessage failed:', err);
      } else {
        console.error('[webhook] processInboundMessage persistence failure, stage=%s', failure.stage);
      }
      // account_id and id come from the same whatsapp_config row resolved and
      // authenticated by connection_id above (never a second lookup).
      const capture = await captureInboundFailure({
        accountId: config.account_id,
        configId: config.id,
        source: 'uazapi',
        stage: failure.stage,
        error: err,
        event: {
          type: event.type,
          externalMessageId: event.messageId,
          timestamp: event.timestamp,
          hasMedia: !!event.mediaRef,
          hasContext: !!event.contextMessageId,
        },
      });
      if (capture.ok) capturedCount++;
      else uncapturedCount++;
    }
  }

  // Any event that did not reach a durable message+job (or was not parsed)
  // blocks 2xx. A successful DLQ insert does not change that. Jobs already
  // registered for the events that did persist are still drained; the 500
  // does not ask UAZAPI to redeliver.
  if (capturedCount + uncapturedCount > 0) {
    if (inboundCount > 0) {
      drainInboundTurnJobs().catch((err) => {
        console.error('[webhook] inbound turn drain failed:', err);
      });
    }
    return NextResponse.json(
      {
        error: 'Inbound event was not durably persisted',
        processed: inboundCount,
        inboundProcessed: inboundCount,
        captured: capturedCount,
        uncaptured: uncapturedCount,
        statusProcessed: statusCount,
      },
      { status: 500 },
    );
  }

  drainInboundTurnJobs().catch((err) => {
    console.error('[webhook] inbound turn drain failed:', err);
  });

  return NextResponse.json({
    received: true,
    processed: inboundCount,
    inboundProcessed: inboundCount,
    // Additive (C6.2): events recorded in the DLQ. NOT counted as processed.
    captured: capturedCount,
    statusProcessed: statusCount,
  });
}
