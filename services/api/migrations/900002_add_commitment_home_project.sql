-- 900002_add_commitment_home_project.sql
-- Fork-only migration (900001+ range; see 900001_add_task_commitment.sql).
--
-- Every commitment lives in the one Commitments project, so the project a
-- commitment is FOR can no longer be read from where it lives. This column
-- records it: the project the commitment was made for, chosen from a
-- dropdown on the commitment. It is a real foreign key rather than a custom
-- field so renaming a project never breaks it, and a deleted project leaves
-- the commitment with no project rather than a dangling id. The service only
-- accepts it on Commitment-typed tasks in the Commitments project.
--
-- commitments_migrated_at records when the one-off move of existing
-- commitments into the Commitments project ran (see package
-- commitmentmigration); NULL means it has not run yet.

BEGIN;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS home_project_id UUID NULL
        REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_home_project_id
    ON tasks (home_project_id)
    WHERE home_project_id IS NOT NULL;

ALTER TABLE workspace_settings
    ADD COLUMN IF NOT EXISTS commitments_migrated_at TIMESTAMPTZ NULL;

COMMIT;
