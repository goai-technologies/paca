-- 000068_account_ids.sql
-- Every actor is an account (user, agent or service account), so columns that
-- name "the actor" or "the recipient" reference accounts(id) instead of
-- users(id) and say so:
--
--   agent_chat_sessions.actor_user_id   -> actor_account_id
--   agent_conversations.actor_user_id   -> actor_account_id
--   notifications.recipient_user_id     -> recipient_account_id
--   user_view_configs.user_id           -> account_id
--
-- users(id) is the account id, so every existing value stays valid. Check
-- constraints, the primary key and the generated agent_conversations.audience
-- column follow the rename automatically. users-only data (credentials, SSO
-- identities, password-set tokens) keeps user_id: it is about logging in.

-- Deploy: API, agent-runner and realtime must roll out together with this
-- migration (an old service hits missing columns). It is not reversible
-- without a counter-migration. Every users row has an accounts row (backfilled
-- and kept in sync by 000066), so the new foreign keys validate; the ALTERs
-- take brief locks, and notifications is the only large table involved.

BEGIN;

-- Replace the foreign key of table.col (currently to users) with one to
-- accounts(id).
CREATE FUNCTION pg_temp.repoint_fk(tbl regclass, col text, new_name text, on_delete text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
        WHERE con.conrelid = tbl AND con.contype = 'f' AND att.attname = col
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, c.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES accounts(id) ON DELETE %s',
                   tbl, new_name, col, on_delete);
END $$;

ALTER TABLE agent_chat_sessions RENAME COLUMN actor_user_id TO actor_account_id;
SELECT pg_temp.repoint_fk('agent_chat_sessions', 'actor_account_id', 'fk_agent_chat_sessions_actor_account', 'RESTRICT');
ALTER INDEX IF EXISTS idx_agent_chat_sessions_agent_actor_user RENAME TO idx_agent_chat_sessions_agent_actor_account;

ALTER TABLE agent_conversations RENAME COLUMN actor_user_id TO actor_account_id;
SELECT pg_temp.repoint_fk('agent_conversations', 'actor_account_id', 'fk_agent_conversations_actor_account', 'RESTRICT');
ALTER INDEX IF EXISTS idx_agent_conversations_actor_user RENAME TO idx_agent_conversations_actor_account;

ALTER TABLE notifications RENAME COLUMN recipient_user_id TO recipient_account_id;
SELECT pg_temp.repoint_fk('notifications', 'recipient_account_id', 'fk_notifications_recipient_account', 'CASCADE');

ALTER TABLE user_view_configs RENAME COLUMN user_id TO account_id;
SELECT pg_temp.repoint_fk('user_view_configs', 'account_id', 'fk_user_view_configs_account', 'CASCADE');
ALTER INDEX IF EXISTS idx_user_view_configs_user_id RENAME TO idx_user_view_configs_account_id;

COMMIT;
