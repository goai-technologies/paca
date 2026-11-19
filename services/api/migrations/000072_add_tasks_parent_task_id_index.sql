-- Subtask lookups: listing a parent's children and batched subtask counts
-- filter on parent_task_id.
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id
    ON tasks (parent_task_id)
    WHERE parent_task_id IS NOT NULL AND deleted_at IS NULL;
