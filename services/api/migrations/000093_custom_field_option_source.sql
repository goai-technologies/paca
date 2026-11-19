-- 000093_custom_field_option_source.sql
-- Adds option_source to custom_field_definitions to allow select / multi_select fields
-- to dynamically source options from project members / teams.
-- Values: 'manual' (default) or 'project_members'.

BEGIN;

ALTER TABLE custom_field_definitions
    ADD COLUMN IF NOT EXISTS option_source TEXT NOT NULL DEFAULT 'manual';

COMMIT;

