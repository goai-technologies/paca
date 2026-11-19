-- 000070_custom_field_long_text_rows.sql
-- Issue #586: adds the "long_text" custom field type. `rows` is how many text
-- lines the editor shows for such a field (ignored by every other type).

BEGIN;

ALTER TABLE custom_field_definitions
    ADD COLUMN IF NOT EXISTS rows INTEGER NOT NULL DEFAULT 3;

COMMIT;
