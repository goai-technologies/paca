-- 900001_add_task_commitment.sql
-- Fork-only migrations are numbered from 900001 so they never collide with
-- upstream's sequence; the runner tracks files by name, and they sort after
-- every upstream migration on a fresh database.
--
-- A ticket in ANY project can belong to exactly one commitment: a
-- Commitment-typed task that lives in the workspace's designated Commitments
-- project (workspace_settings.commitments_project_id). This is a column on
-- tasks rather than a task_links row because the relationship is
-- one-to-many by definition — one commitment per ticket — and because every
-- consumer that already reads tasks (the web app, the MCP server, external
-- reporting syncs) then sees it with no extra round trip.
--
-- Membership is inherited: a ticket's descendants (stories under an epic,
-- sub-tasks under a story) belong to the same commitment, so the column is
-- only ever set on a top-level ticket. The service layer enforces that.

BEGIN;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS commitment_task_id UUID NULL
        REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE tasks
    DROP CONSTRAINT IF EXISTS tasks_commitment_not_self;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_commitment_not_self
        CHECK (commitment_task_id IS NULL OR commitment_task_id <> id);

CREATE INDEX IF NOT EXISTS idx_tasks_commitment_task_id
    ON tasks (commitment_task_id)
    WHERE commitment_task_id IS NOT NULL;

ALTER TABLE workspace_settings
    ADD COLUMN IF NOT EXISTS commitments_project_id UUID NULL
        REFERENCES projects(id) ON DELETE SET NULL;

COMMIT;
