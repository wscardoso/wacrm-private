-- ============================================================
-- 031_webhook_dlq.sql — Dead-letter queue for failed webhook processing
--
-- Stores webhook payloads that failed processing, allowing retry
-- via cron or manual intervention. Prevents permanent message loss
-- when transient errors occur during webhook route processing.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Webhook metadata
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  whatsapp_config_id UUID NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  -- Raw incoming payload (the original JSON from Meta)
  payload JSONB NOT NULL,
  -- Error that caused the DLQ insertion
  error_message TEXT,
  -- Retry tracking
  retry_count INT NOT NULL DEFAULT 0,
  last_retry_at TIMESTAMP WITH TIME ZONE,
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Status: 'pending' (retry waiting), 'resolved' (successfully retried), 'abandoned' (too many retries)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'abandoned'))
);

-- Index for cron to find pending messages quickly
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_dlq_status_created
  ON public.whatsapp_webhook_dlq(status, created_at DESC)
  WHERE status = 'pending';

-- Compound index for retry queries: account-scoped, filtered by status, ordered by created_at
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_retry_window
  ON public.whatsapp_webhook_dlq(account_id, status, created_at DESC)
  WHERE status = 'pending';

-- Index for account-scoped queries
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_dlq_account_id
  ON public.whatsapp_webhook_dlq(account_id);

-- Trigger to update updated_at
CREATE OR REPLACE TRIGGER update_whatsapp_webhook_dlq_updated_at
  BEFORE UPDATE ON public.whatsapp_webhook_dlq
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Helper RPC to enqueue a failed webhook
-- ============================================================
CREATE OR REPLACE FUNCTION public.enqueue_webhook_dlq(
  p_account_id UUID,
  p_whatsapp_config_id UUID,
  p_payload JSONB,
  p_error_message TEXT
) RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.whatsapp_webhook_dlq (
    account_id,
    whatsapp_config_id,
    payload,
    error_message
  ) VALUES (p_account_id, p_whatsapp_config_id, p_payload, p_error_message)
  RETURNING id;
$$;

ALTER FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) OWNER TO postgres;
