-- 000069_custom_field_use_in_search.sql
-- Issue #576: lets a project mark a custom field as searchable, so the task
-- search box also matches the value stored in that field (tracking numbers,
-- client ids, ...).

BEGIN;

ALTER TABLE custom_field_definitions
    ADD COLUMN IF NOT EXISTS use_in_search BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the search predicate only ever looks up flagged definitions
-- of a project, which is a tiny subset of the table.
CREATE INDEX IF NOT EXISTS idx_custom_field_definitions_use_in_search
    ON custom_field_definitions (project_id)
    WHERE use_in_search;

COMMIT;
