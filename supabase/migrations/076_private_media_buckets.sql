-- 076_private_media_buckets.sql — S2
--
-- chat-media and flow-media were `public = TRUE` with a SELECT policy
-- open to anyone (023:83-86, 016:87-90) — any object was readable by
-- URL alone, across tenants. Storage-level RLS is only enforced once
-- `public = FALSE`; the public-object endpoint bypasses policies
-- entirely while a bucket is public, regardless of what SELECT policy
-- exists. See docs/checkpoints/CHECKPOINT-S2-S3-AUDITED.md (S2).
--
-- Idempotent — safe to re-run.

UPDATE storage.buckets SET public = FALSE WHERE id IN ('chat-media', 'flow-media');

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
CREATE POLICY "Chat media is account-scoped readable"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
CREATE POLICY "Flow media is account-scoped readable"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );
