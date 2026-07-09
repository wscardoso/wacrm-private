-- Test: handle_new_user trigger cria profile e account corretamente
-- Uso: psql <CONNECTION_STRING> < supabase/tests/test_migration_001_handle_new_user.sql
-- Esperado: PASS: profile created
-- Falha se: trigger falha silenciosamente (usuario orfão)

BEGIN;

-- Simular insertion em auth.users (o que a trigger handle_new_user escuta)
-- Nota: em produção isso é feito pelo Supabase Auth, aqui simulamos
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'test-orphan@example.com',
  '{"full_name": "Test Orphan"}',
  now(),
  now()
);

-- Verifica se o profile foi criado pela trigger
SELECT
  CASE
    WHEN p.id IS NOT NULL AND p.account_id IS NOT NULL
    THEN 'PASS: profile created'
    ELSE 'FAIL: profile or account missing'
  END as test_result
FROM auth.users u
LEFT JOIN profiles p ON p.user_id = u.id
WHERE u.id = '00000000-0000-0000-0000-000000000001';

-- Cleanup
DELETE FROM profiles WHERE user_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM accounts WHERE owner_user_id = '00000000-0000-0000-0000-000000000001';
DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001';

COMMIT;