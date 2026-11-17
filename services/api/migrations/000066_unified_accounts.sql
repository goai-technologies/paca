-- 000066_unified_accounts.sql
-- One `accounts` row per actor (user, agent or service account). See
-- docs/architecture/database-schema.md ("Accounts model").
--
--   accounts            identity shared by every kind: kind, name, description,
--                       avatar, created_by, timestamps and the ONLY soft-delete
--                       flag (deleted_at).
--   users / agents      become extension tables whose primary key IS the account
--                       id. Existing ids are reused, so every foreign key that
--                       pointed at users(id)/agents(id) and every
--                       role_attachments.principal_id stays valid.
--   service accounts    are accounts of kind 'service_account' with no extension
--                       table: they have nothing a user/agent row would add.
--
-- Every fact is stored once: name/description/avatar/deleted_at move OFF users
-- and agents; agents.agent_scope (a mirror of project_id IS NULL), the legacy
-- users.role_id / agents.global_role_id / project_members.project_role_id (roles
-- are role_attachments only) and agents.mcp_api_key_hash (now an api_keys row)
-- are dropped; role_attachments.principal_type/principal_id and
-- project_members.user_id/agent_id/member_type collapse to one account_id.
--
-- Uniqueness of users.username, users.email and agents.handle among LIVE
-- accounts used to be a partial unique index on deleted_at. deleted_at now lives
-- only on accounts, which an index cannot see, so ONE trigger function
-- (enforce_live_unique_identifiers) re-checks the three rules; it raises
-- unique_violation with the old constraint names so callers keep working.
--
-- A second trigger removes the accounts row whenever a users/agents row is
-- hard-deleted (e.g. a project purge cascading to its agents), so no account is
-- ever orphaned.
--
-- IRREVERSIBLE (drops columns). Single transaction with a self-check at the end.

BEGIN;

-- -------------------------------------------------------------------------
-- accounts
-- -------------------------------------------------------------------------

CREATE TABLE accounts (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind             TEXT        NOT NULL CHECK (kind IN ('user', 'agent', 'service_account')),
    name             TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    avatar_key       TEXT,
    avatar_thumb_key TEXT,
    created_by       UUID        REFERENCES accounts(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at       TIMESTAMPTZ,
    -- Target of the kind-pinning composite FKs from users and agents.
    CONSTRAINT uq_accounts_id_kind UNIQUE (id, kind)
);

CREATE INDEX idx_accounts_kind_live ON accounts (kind) WHERE deleted_at IS NULL;

INSERT INTO accounts (id, kind, name, description, avatar_key, avatar_thumb_key, created_at, updated_at, deleted_at)
SELECT id, 'user', COALESCE(NULLIF(full_name, ''), username), '', avatar_key, avatar_thumb_key,
       created_at, updated_at, deleted_at
FROM users;

-- created_by is filled after both kinds exist (agents.created_by names a user).
INSERT INTO accounts (id, kind, name, description, avatar_key, avatar_thumb_key, created_at, updated_at, deleted_at)
SELECT id, 'agent', name, COALESCE(description, ''), avatar_key, avatar_thumb_key,
       created_at, updated_at, deleted_at
FROM agents;

UPDATE accounts a SET created_by = ag.created_by
FROM agents ag
WHERE ag.id = a.id AND ag.created_by IS NOT NULL
  AND EXISTS (SELECT 1 FROM accounts c WHERE c.id = ag.created_by);

-- -------------------------------------------------------------------------
-- users / agents become extension tables
-- -------------------------------------------------------------------------

-- Indexes that depend on the dropped columns are dropped with them; the
-- uniqueness rules they enforced move to the trigger below.
DROP INDEX IF EXISTS uni_users_username_active;
DROP INDEX IF EXISTS uni_users_email_active;
DROP INDEX IF EXISTS idx_users_email_lower_active;
DROP INDEX IF EXISTS uq_agents_project_handle;
DROP INDEX IF EXISTS uq_agents_global_handle;
DROP INDEX IF EXISTS uq_agents_acp_bridge_token_hash;
DROP INDEX IF EXISTS uq_agents_mcp_api_key_hash;

-- The agent's MCP key becomes an ordinary api_keys row (api_keys is
-- reshaped below; do the move after that).

-- kind is a constant that exists only so the composite FK can pin the account
-- type; it carries no information and cannot diverge from accounts.kind.
ALTER TABLE users
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK (kind = 'user'),
    ADD CONSTRAINT fk_users_account FOREIGN KEY (id, kind)
        REFERENCES accounts (id, kind) ON DELETE CASCADE;

ALTER TABLE agents
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind = 'agent'),
    ADD CONSTRAINT fk_agents_account FOREIGN KEY (id, kind)
        REFERENCES accounts (id, kind) ON DELETE CASCADE;

-- -------------------------------------------------------------------------
-- api_keys: any account, plus who minted the key
-- -------------------------------------------------------------------------

ALTER TABLE api_keys DROP CONSTRAINT fk_api_keys_user;
ALTER TABLE api_keys RENAME COLUMN user_id TO account_id;
ALTER INDEX idx_api_keys_user_id RENAME TO idx_api_keys_account_id;
ALTER TABLE api_keys
    ADD CONSTRAINT fk_api_keys_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    ADD COLUMN created_by UUID REFERENCES accounts(id) ON DELETE SET NULL;
UPDATE api_keys SET created_by = account_id;

INSERT INTO api_keys (account_id, name, key_prefix, key_hash, created_by, created_at)
SELECT id, 'MCP key', '', mcp_api_key_hash, NULL, updated_at
FROM agents
WHERE mcp_api_key_hash IS NOT NULL
ON CONFLICT (key_hash) DO NOTHING;

-- -------------------------------------------------------------------------
-- role_attachments: one account_id with a real FK
-- -------------------------------------------------------------------------

ALTER TABLE role_attachments ADD COLUMN account_id UUID;
UPDATE role_attachments SET account_id = principal_id;

DO $$
DECLARE orphans integer;
BEGIN
    SELECT count(*) INTO orphans FROM role_attachments ra
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = ra.account_id);
    IF orphans > 0 THEN
        RAISE NOTICE '000066: dropping % role_attachments row(s) whose principal no longer exists', orphans;
        DELETE FROM role_attachments ra
        WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = ra.account_id);
    END IF;
END $$;

DROP INDEX uq_role_attachments_platform;
DROP INDEX uq_role_attachments_project;
DROP INDEX idx_role_attachments_principal;
ALTER TABLE role_attachments
    DROP COLUMN principal_type,
    DROP COLUMN principal_id,
    ALTER COLUMN account_id SET NOT NULL,
    ADD CONSTRAINT fk_role_attachments_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX uq_role_attachments_platform
    ON role_attachments (role_id, account_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX uq_role_attachments_project
    ON role_attachments (role_id, account_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_role_attachments_account ON role_attachments (account_id);

-- -------------------------------------------------------------------------
-- project_members: one account_id
-- -------------------------------------------------------------------------

ALTER TABLE project_members ADD COLUMN account_id UUID;
UPDATE project_members SET account_id = COALESCE(user_id, agent_id);

DROP INDEX uq_project_members_active;
DROP INDEX uq_pm_project_agent;
DROP INDEX idx_project_members_user_id;
DROP INDEX idx_project_members_role_id;
ALTER TABLE project_members
    DROP CONSTRAINT ck_pm_member_type_ref,
    DROP COLUMN user_id,
    DROP COLUMN agent_id,
    DROP COLUMN member_type,
    DROP COLUMN project_role_id,
    ALTER COLUMN account_id SET NOT NULL,
    ADD CONSTRAINT fk_project_members_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX uq_project_members_active
    ON project_members (project_id, account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_project_members_account_id ON project_members (account_id);

-- -------------------------------------------------------------------------
-- Audit columns that record WHO did something now name any account (a service
-- account can upload a file); same ids, so only the FK target changes.
-- -------------------------------------------------------------------------

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('files',                     'files_uploaded_by_fkey',                     'uploaded_by',  'SET NULL'),
            ('task_attachments',          'task_attachments_created_by_fkey',           'created_by',   'SET NULL'),
            ('task_links',                'task_links_created_by_fkey',                 'created_by',   'SET NULL'),
            ('environments',              'fk_environments_created_by',                 'created_by',   'SET NULL'),
            ('environment_folders',       'fk_environment_folders_created_by',          'created_by',   'SET NULL'),
            ('environment_ssh_keys',      'fk_environment_ssh_keys_created_by',         'created_by',   'SET NULL'),
            ('environment_port_forwards', 'fk_environment_port_forwards_created_by',    'created_by',   'SET NULL'),
            ('environment_access_grants', 'fk_environment_access_grants_granted_by',   'granted_by',   'SET NULL'),
            ('agent_access_grants',       'fk_agent_access_grants_granted_by',          'granted_by',   'SET NULL'),
            ('page_annotations',          'page_annotations_created_by_fkey',           'created_by',   'NO ACTION'),
            ('page_annotations',          'page_annotations_resolved_by_fkey',          'resolved_by',  'NO ACTION'),
            ('page_annotation_comments',  'page_annotation_comments_created_by_fkey',   'created_by',   'NO ACTION'),
            ('project_exports',           'project_exports_requested_by_fkey',          'requested_by', 'SET NULL'),
            ('workspace_settings',        'workspace_settings_updated_by_fkey',         'updated_by',   'SET NULL'),
            ('role_attachments',          'role_attachments_created_by_fkey',           'created_by',   'SET NULL')
        ) AS t(tbl, con, col, on_delete)
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.con);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES accounts(id) ON DELETE %s',
                       r.tbl, r.con, r.col, r.on_delete);
    END LOOP;
END $$;

-- -------------------------------------------------------------------------
-- Drop what moved or is now derived
-- -------------------------------------------------------------------------

ALTER TABLE users
    DROP COLUMN full_name,
    DROP COLUMN avatar_key,
    DROP COLUMN avatar_thumb_key,
    DROP COLUMN created_at,
    DROP COLUMN updated_at,
    DROP COLUMN deleted_at,
    DROP COLUMN role_id;

ALTER TABLE agents
    DROP COLUMN name,
    DROP COLUMN description,
    DROP COLUMN avatar_key,
    DROP COLUMN avatar_thumb_key,
    DROP COLUMN created_by,
    DROP COLUMN created_at,
    DROP COLUMN updated_at,
    DROP COLUMN deleted_at,
    DROP COLUMN agent_scope,
    DROP COLUMN global_role_id,
    DROP COLUMN mcp_api_key_hash;

-- A deleted agent's bridge token must stop working, which authentication now
-- checks through accounts.deleted_at; the hash itself is unique outright.
CREATE UNIQUE INDEX uq_agents_acp_bridge_token_hash
    ON agents (acp_bridge_token_hash) WHERE agent_type = 'acp';
CREATE INDEX idx_users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;

-- -------------------------------------------------------------------------
-- Live-uniqueness of users.username, users.email, agents.handle
-- -------------------------------------------------------------------------

-- Names the first rule account p_id breaks against another LIVE account, or
-- NULL (also when p_id itself is deleted). handle is unique per project, and
-- workspace-wide for a global agent (project_id NULL).
CREATE FUNCTION account_identifier_conflict(p_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN a.deleted_at IS NOT NULL THEN NULL ELSE COALESCE(
        (SELECT 'username' FROM users me
           JOIN users o ON o.username = me.username AND o.id <> me.id
           JOIN accounts oa ON oa.id = o.id AND oa.deleted_at IS NULL
          WHERE me.id = p_id LIMIT 1),
        (SELECT 'email' FROM users me
           JOIN users o ON o.email = me.email AND o.id <> me.id
           JOIN accounts oa ON oa.id = o.id AND oa.deleted_at IS NULL
          WHERE me.id = p_id AND me.email IS NOT NULL LIMIT 1),
        (SELECT 'handle' FROM agents me
           JOIN agents o ON o.handle = me.handle AND o.id <> me.id
                        AND o.project_id IS NOT DISTINCT FROM me.project_id
           JOIN accounts oa ON oa.id = o.id AND oa.deleted_at IS NULL
          WHERE me.id = p_id LIMIT 1)
    ) END
    FROM accounts a WHERE a.id = p_id
$$;

CREATE FUNCTION enforce_live_unique_identifiers() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    broken TEXT;
BEGIN
    -- Serialise identifier writes (rare) so two concurrent inserts cannot both
    -- pass the check; the lock is released at transaction end.
    PERFORM pg_advisory_xact_lock(hashtextextended('paca.account_identifiers', 0));
    broken := account_identifier_conflict(NEW.id);
    IF broken IS NOT NULL THEN
        RAISE EXCEPTION 'duplicate live account %', broken
            USING ERRCODE = 'unique_violation',
                  CONSTRAINT = CASE broken
                      WHEN 'username' THEN 'uni_users_username_active'
                      WHEN 'email'    THEN 'uni_users_email_active'
                      ELSE CASE WHEN (SELECT project_id FROM agents WHERE id = NEW.id) IS NULL
                                THEN 'uq_agents_global_handle'
                                ELSE 'uq_agents_project_handle' END
                  END;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_users_live_unique
    AFTER INSERT OR UPDATE OF username, email ON users
    FOR EACH ROW EXECUTE FUNCTION enforce_live_unique_identifiers();
CREATE TRIGGER trg_agents_live_unique
    AFTER INSERT OR UPDATE OF handle, project_id ON agents
    FOR EACH ROW EXECUTE FUNCTION enforce_live_unique_identifiers();
-- Restoring a soft-deleted account makes its identifiers live again.
CREATE TRIGGER trg_accounts_restore_live_unique
    AFTER UPDATE OF deleted_at ON accounts
    FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL)
    EXECUTE FUNCTION enforce_live_unique_identifiers();

-- Hard-deleting a users/agents row (e.g. a project purge cascading to its
-- agents) removes the account too, so no account is orphaned.
CREATE FUNCTION delete_owning_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM accounts WHERE id = OLD.id;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_users_delete_account  AFTER DELETE ON users  FOR EACH ROW EXECUTE FUNCTION delete_owning_account();
CREATE TRIGGER trg_agents_delete_account AFTER DELETE ON agents FOR EACH ROW EXECUTE FUNCTION delete_owning_account();

-- -------------------------------------------------------------------------
-- Self-check (aborts the migration on any inconsistency)
-- -------------------------------------------------------------------------

DO $$
DECLARE
    bad integer;
BEGIN
    SELECT count(*) INTO bad FROM users u LEFT JOIN accounts a ON a.id = u.id AND a.kind = 'user' WHERE a.id IS NULL;
    IF bad > 0 THEN RAISE EXCEPTION '000066 self-check: % user(s) without a user account', bad; END IF;

    SELECT count(*) INTO bad FROM agents g LEFT JOIN accounts a ON a.id = g.id AND a.kind = 'agent' WHERE a.id IS NULL;
    IF bad > 0 THEN RAISE EXCEPTION '000066 self-check: % agent(s) without an agent account', bad; END IF;

    SELECT count(*) INTO bad FROM accounts a
    WHERE a.kind = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.id)
       OR a.kind = 'agent' AND NOT EXISTS (SELECT 1 FROM agents g WHERE g.id = a.id);
    IF bad > 0 THEN RAISE EXCEPTION '000066 self-check: % account(s) without an extension row', bad; END IF;

    -- Existing data must satisfy the rules the trigger now enforces.
    SELECT count(*) INTO bad FROM accounts a WHERE account_identifier_conflict(a.id) IS NOT NULL;
    IF bad > 0 THEN RAISE EXCEPTION '000066 self-check: % live account(s) break username/email/handle uniqueness', bad; END IF;
END $$;

COMMIT;
