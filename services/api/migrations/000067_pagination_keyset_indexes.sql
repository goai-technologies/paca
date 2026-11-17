-- Keyset-pagination orderings introduced with cursor-paginated lists. Each
-- index matches one list's ORDER BY so a page is an index range scan.

-- Environments: newest first within a project.
CREATE INDEX IF NOT EXISTS idx_environments_project_created
    ON environments (project_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL;

-- API keys: an account's active keys, newest first.
CREATE INDEX IF NOT EXISTS idx_api_keys_account_created
    ON api_keys (account_id, created_at DESC, id DESC)
    WHERE revoked_at IS NULL;

-- Agent and service-account lists order by (LOWER(name), id).
CREATE INDEX IF NOT EXISTS idx_accounts_kind_lower_name
    ON accounts (kind, LOWER(name), id)
    WHERE deleted_at IS NULL;
