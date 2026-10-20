import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

// =============================================================
// F3 — ownership isolation, database layer.
//
// Reproduces, against Postgres real (PGlite), the cross-account
// association gaps left by the 017 RLS policies:
//
//   - contact_tags: the policy only checks the contact's account.
//     The tag_id can belong to another account.
//   - deals: the policy only checks the deal's account_id. contact,
//     pipeline, stage and conversation can point at another account.
//   - conversations: same — only account_id is checked; contact_id
//     and assigned_agent_id are not.
//   - automation_steps: the policy only checks automation_id;
//     parent_step_id may reference a step from another account.
//
// The second block applies the PROPOSED fix inline (policy rewrites +
// one trigger) to prove it closes the gaps. No production migration is
// created by this test — the proposal lives in
// docs/security/F3-OWNERSHIP-ISOLATION-PROPOSAL.md.
// =============================================================

let db: PGlite

const FOUNDATION = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::UUID
$$;

CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum
);

-- Tenant membership. The role hierarchy is not the subject of this
-- test, so every member is treated as satisfying 'agent'.
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
  );
$$;
`

// Minimal shape of the real tables + the 017 policies as shipped.
const BASE = `
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  phone TEXT
);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  name TEXT NOT NULL
);

CREATE TABLE contact_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE (contact_id, tag_id)
);
ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL
  USING (EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent')
  ));

CREATE TABLE pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  assigned_agent_id UUID REFERENCES profiles(user_id) ON DELETE SET NULL
);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (is_account_member(account_id));

CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pipeline_id UUID NOT NULL REFERENCES pipelines(id),
  stage_id UUID NOT NULL REFERENCES pipeline_stages(id),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  conversation_id UUID REFERENCES conversations(id),
  title TEXT NOT NULL,
  value NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
);
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
CREATE POLICY deals_insert ON deals FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY deals_select ON deals FOR SELECT
  USING (is_account_member(account_id));

CREATE TABLE automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id)
);

CREATE TABLE automation_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  parent_step_id UUID REFERENCES automation_steps(id) ON DELETE CASCADE,
  branch TEXT CHECK (branch IN ('yes', 'no')),
  step_type TEXT NOT NULL,
  step_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL
);
ALTER TABLE automation_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY automation_steps_modify ON automation_steps FOR ALL
  USING (EXISTS (
    SELECT 1 FROM automations a
    WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'agent')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM automations a
    WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'agent')
  ));

-- Supabase's bootstrap grants table-wide privileges; RLS is the
-- enforcement layer being tested.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  contacts, tags, contact_tags, pipelines, pipeline_stages,
  conversations, deals, automations, automation_steps
TO authenticated;

-- Real Supabase grants SELECT on profiles to authenticated. The
-- proposed conversations policy reads it directly.
GRANT SELECT ON profiles TO authenticated;
`

// Proposed fix, applied only inside this test. Mirrors what a
// production migration would do after authorization.
const PROPOSED_FIX = `
DROP POLICY contact_tags_modify ON contact_tags;
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent')
    )
    AND EXISTS (
      SELECT 1 FROM contacts c
      JOIN tags t ON t.account_id = c.account_id
      WHERE c.id = contact_tags.contact_id AND t.id = contact_tags.tag_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent')
    )
    AND EXISTS (
      SELECT 1 FROM contacts c
      JOIN tags t ON t.account_id = c.account_id
      WHERE c.id = contact_tags.contact_id AND t.id = contact_tags.tag_id
    )
  );

DROP POLICY conversations_insert ON conversations;
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = conversations.contact_id AND c.account_id = conversations.account_id
    )
    AND (
      conversations.assigned_agent_id IS NULL
      OR EXISTS (
        SELECT 1 FROM profiles p
        WHERE p.user_id = conversations.assigned_agent_id
          AND p.account_id = conversations.account_id
      )
    )
  );

DROP POLICY deals_insert ON deals;
CREATE POLICY deals_insert ON deals FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id AND c.account_id = deals.account_id
    )
    AND EXISTS (
      SELECT 1 FROM pipeline_stages s
      JOIN pipelines p ON p.id = s.pipeline_id
      WHERE s.id = deals.stage_id
        AND s.pipeline_id = deals.pipeline_id
        AND p.account_id = deals.account_id
    )
    AND (
      deals.conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM conversations cv
        WHERE cv.id = deals.conversation_id
          AND cv.account_id = deals.account_id
          AND cv.contact_id = deals.contact_id
      )
    )
  );

CREATE OR REPLACE FUNCTION automation_steps_parent_same_automation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_parent_automation UUID;
BEGIN
  IF NEW.parent_step_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT automation_id INTO v_parent_automation
    FROM automation_steps
   WHERE id = NEW.parent_step_id;

  IF v_parent_automation IS NULL THEN
    RAISE EXCEPTION 'automation_steps: parent step not found';
  END IF;

  IF v_parent_automation <> NEW.automation_id THEN
    RAISE EXCEPTION 'automation_steps: parent step belongs to another automation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER automation_steps_parent_tenant
  BEFORE INSERT OR UPDATE ON automation_steps
  FOR EACH ROW EXECUTE FUNCTION automation_steps_parent_same_automation();
`

async function run<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query(text, params)
  return result.rows as T[]
}

async function asUser(userId: string, fn: () => Promise<void>) {
  await run(`SET ROLE authenticated`)
  await run(`SELECT set_config('app.current_user', $1, false)`, [userId])
  try {
    await fn()
  } finally {
    await run(`SELECT set_config('app.current_user', NULL, false)`)
    await run(`RESET ROLE`)
  }
}

const U = {
  a: '10000000-0000-0000-0000-000000000001',
  b: '10000000-0000-0000-0000-000000000002',
}
const ACC = {
  a: '20000000-0000-0000-0000-000000000001',
  b: '20000000-0000-0000-0000-000000000002',
}

const ids = {
  contactA: '',
  contactB: '',
  tagA: '',
  tagB: '',
  pipelineA: '',
  pipelineB: '',
  stageA: '',
  stageB: '',
  conversationA: '',
  conversationB: '',
  automationA: '',
  automationB: '',
  stepB: '',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await db.exec(BASE)

  await run(`INSERT INTO accounts (id) VALUES ($1), ($2)`, [ACC.a, ACC.b])
  await run(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [U.a, U.b])
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role)
     VALUES ($1, $2, 'agent'), ($3, $4, 'agent')`,
    [U.a, ACC.a, U.b, ACC.b],
  )

  const contactA = await run<{ id: string }>(
    `INSERT INTO contacts (account_id, user_id, phone) VALUES ($1, $2, '5511') RETURNING id`,
    [ACC.a, U.a],
  )
  const contactB = await run<{ id: string }>(
    `INSERT INTO contacts (account_id, user_id, phone) VALUES ($1, $2, '5522') RETURNING id`,
    [ACC.b, U.b],
  )
  const tagA = await run<{ id: string }>(
    `INSERT INTO tags (account_id, user_id, name) VALUES ($1, $2, 'own') RETURNING id`,
    [ACC.a, U.a],
  )
  const tagB = await run<{ id: string }>(
    `INSERT INTO tags (account_id, user_id, name) VALUES ($1, $2, 'foreign') RETURNING id`,
    [ACC.b, U.b],
  )
  const pipelineA = await run<{ id: string }>(
    `INSERT INTO pipelines (account_id) VALUES ($1) RETURNING id`,
    [ACC.a],
  )
  const pipelineB = await run<{ id: string }>(
    `INSERT INTO pipelines (account_id) VALUES ($1) RETURNING id`,
    [ACC.b],
  )
  const stageA = await run<{ id: string }>(
    `INSERT INTO pipeline_stages (pipeline_id) VALUES ($1) RETURNING id`,
    [pipelineA[0].id],
  )
  const stageB = await run<{ id: string }>(
    `INSERT INTO pipeline_stages (pipeline_id) VALUES ($1) RETURNING id`,
    [pipelineB[0].id],
  )
  const conversationA = await run<{ id: string }>(
    `INSERT INTO conversations (account_id, user_id, contact_id) VALUES ($1, $2, $3) RETURNING id`,
    [ACC.a, U.a, contactA[0].id],
  )
  const conversationB = await run<{ id: string }>(
    `INSERT INTO conversations (account_id, user_id, contact_id) VALUES ($1, $2, $3) RETURNING id`,
    [ACC.b, U.b, contactB[0].id],
  )
  const automationA = await run<{ id: string }>(
    `INSERT INTO automations (account_id, user_id) VALUES ($1, $2) RETURNING id`,
    [ACC.a, U.a],
  )
  const automationB = await run<{ id: string }>(
    `INSERT INTO automations (account_id, user_id) VALUES ($1, $2) RETURNING id`,
    [ACC.b, U.b],
  )
  const stepB = await run<{ id: string }>(
    `INSERT INTO automation_steps (automation_id, step_type, position)
     VALUES ($1, 'add_tag', 0) RETURNING id`,
    [automationB[0].id],
  )

  Object.assign(ids, {
    contactA: contactA[0].id,
    contactB: contactB[0].id,
    tagA: tagA[0].id,
    tagB: tagB[0].id,
    pipelineA: pipelineA[0].id,
    pipelineB: pipelineB[0].id,
    stageA: stageA[0].id,
    stageB: stageB[0].id,
    conversationA: conversationA[0].id,
    conversationB: conversationB[0].id,
    automationA: automationA[0].id,
    automationB: automationB[0].id,
    stepB: stepB[0].id,
  })
})

describe('ANTES — as policies de 017 permitem associação cross-account', () => {
  it('authenticated de A anexa tag de B a um contato de A', async () => {
    await asUser(U.a, async () => {
      await run(
        `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2)`,
        [ids.contactA, ids.tagB],
      )
    })

    const rows = await run<{ count: number }>(
      `SELECT count(*)::int AS count FROM contact_tags
        WHERE contact_id = $1 AND tag_id = $2`,
      [ids.contactA, ids.tagB],
    )
    expect(rows[0].count).toBe(1)
  })

  it('authenticated de A cria deal em A apontando para contato/pipeline/stage/conversa de B', async () => {
    await asUser(U.a, async () => {
      await run(
        `INSERT INTO deals
           (user_id, account_id, pipeline_id, stage_id, contact_id, conversation_id, title)
         VALUES ($1, $2, $3, $4, $5, $6, 'cross-account')`,
        [U.a, ACC.a, ids.pipelineB, ids.stageB, ids.contactB, ids.conversationB],
      )
    })

    const rows = await run<{ count: number }>(
      `SELECT count(*)::int AS count FROM deals WHERE title = 'cross-account'`,
    )
    expect(rows[0].count).toBe(1)
  })

  it('authenticated de A cria conversa em A apontando para contato de B', async () => {
    await asUser(U.a, async () => {
      await run(
        `INSERT INTO conversations (account_id, user_id, contact_id)
         VALUES ($1, $2, $3)`,
        [ACC.a, U.a, ids.contactB],
      )
    })

    const rows = await run<{ count: number }>(
      `SELECT count(*)::int AS count FROM conversations
        WHERE account_id = $1 AND contact_id = $2`,
      [ACC.a, ids.contactB],
    )
    expect(rows[0].count).toBe(1)
  })

  it('authenticated de A cria step em A com parent_step_id de B', async () => {
    await asUser(U.a, async () => {
      await run(
        `INSERT INTO automation_steps
           (automation_id, parent_step_id, branch, step_type, position)
         VALUES ($1, $2, 'yes', 'add_tag', 0)`,
        [ids.automationA, ids.stepB],
      )
    })

    const rows = await run<{ count: number }>(
      `SELECT count(*)::int AS count FROM automation_steps
        WHERE automation_id = $1 AND parent_step_id = $2`,
      [ids.automationA, ids.stepB],
    )
    expect(rows[0].count).toBe(1)
  })
})

describe('PROPOSTA — policies/trigger fecham os quatro caminhos', () => {
  beforeAll(async () => {
    await db.exec(PROPOSED_FIX)
  })

  it('rejeita tag de outra conta em contact_tags', async () => {
    await expect(
      asUser(U.a, async () => {
        await run(
          `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2)`,
          [ids.contactA, ids.tagB],
        )
      }),
    ).rejects.toThrow(/row-level security|policy/i)
  })

  it('rejeita deal com contato/pipeline/stage/conversa de outra conta', async () => {
    await expect(
      asUser(U.a, async () => {
        await run(
          `INSERT INTO deals
             (user_id, account_id, pipeline_id, stage_id, contact_id, conversation_id, title)
           VALUES ($1, $2, $3, $4, $5, $6, 'blocked')`,
          [U.a, ACC.a, ids.pipelineB, ids.stageB, ids.contactB, ids.conversationB],
        )
      }),
    ).rejects.toThrow(/row-level security|policy/i)
  })

  it('rejeita conversa com contato de outra conta', async () => {
    await expect(
      asUser(U.a, async () => {
        await run(
          `INSERT INTO conversations (account_id, user_id, contact_id)
           VALUES ($1, $2, $3)`,
          [ACC.a, U.a, ids.contactB],
        )
      }),
    ).rejects.toThrow(/row-level security|policy/i)
  })

  it('rejeita parent_step_id de outra automação', async () => {
    await expect(
      asUser(U.a, async () => {
        await run(
          `INSERT INTO automation_steps
             (automation_id, parent_step_id, branch, step_type, position)
           VALUES ($1, $2, 'yes', 'add_tag', 0)`,
          [ids.automationA, ids.stepB],
        )
      }),
    ).rejects.toThrow(/another automation/)
  })

  it('continua permitindo as associações legítimas da própria conta', async () => {
    await asUser(U.a, async () => {
      await run(
        `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2)`,
        [ids.contactA, ids.tagA],
      )
      await run(
        `INSERT INTO deals
           (user_id, account_id, pipeline_id, stage_id, contact_id, conversation_id, title)
         VALUES ($1, $2, $3, $4, $5, $6, 'legit')`,
        [U.a, ACC.a, ids.pipelineA, ids.stageA, ids.contactA, ids.conversationA],
      )
      await run(
        `INSERT INTO conversations (account_id, user_id, contact_id)
         VALUES ($1, $2, $3)`,
        [ACC.a, U.a, ids.contactA],
      )
      await run(
        `INSERT INTO automation_steps
           (automation_id, step_type, position)
         VALUES ($1, 'add_tag', 1)`,
        [ids.automationA],
      )
      await run(
        `INSERT INTO automation_steps
           (automation_id, parent_step_id, branch, step_type, position)
         SELECT $1, id, 'yes', 'add_tag', 0
           FROM automation_steps
          WHERE automation_id = $1 AND step_type = 'add_tag'
          ORDER BY position DESC LIMIT 1`,
        [ids.automationA],
      )
    })

    const rows = await run<{ count: number }>(
      `SELECT count(*)::int AS count FROM deals WHERE title = 'legit'`,
    )
    expect(rows[0].count).toBe(1)
  })
})
