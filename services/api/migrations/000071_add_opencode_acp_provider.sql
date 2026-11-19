-- 000071_add_opencode_acp_provider.sql
-- Issue #590: adds 'opencode' to the set of built-in acp_provider values
-- (Go-layer validation updated in agentdom.ValidACPProviders/
-- ACPProviderOpenCode). apps/acp-bridge resolves its default command
-- (`opencode acp`) itself.
--
-- Drops and recreates ck_agents_acp_provider (last defined by
-- 000037_add_goose_acp_provider.sql).

BEGIN;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS ck_agents_acp_provider;

ALTER TABLE agents ADD CONSTRAINT ck_agents_acp_provider
    CHECK (acp_provider IN ('claude-code', 'codex', 'gemini-cli', 'goose', 'opencode', 'custom'));

COMMIT;
