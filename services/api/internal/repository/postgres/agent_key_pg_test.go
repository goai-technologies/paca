package postgres

import (
	"testing"

	"github.com/google/uuid"
)

// An agent has one person-generated key at a time; regenerating it revokes the
// previous one and leaves any key of another name (the agent-runner's) alone.
func TestAgentRepository_ReplaceAPIKeyHash(t *testing.T) {
	db := newIAMPGTestDB(t)
	fx := newIAMFx(t, db)
	repo := NewAgentRepository(db)
	agent := fx.agent(nil, false)

	active := func(hash string) bool {
		var n int
		if err := db.Get(&n, `SELECT count(*) FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, hash); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	pgExec(t, db, `INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES ($1, 'agent-runner', 'abcd1234', 'runner-key')`, agent)

	if err := repo.ReplaceAPIKeyHash(t.Context(), agent, "first"); err != nil {
		t.Fatal(err)
	}
	if !active("first") || !active("runner-key") {
		t.Fatal("the first key and the runner's key must both be active")
	}
	if err := repo.ReplaceAPIKeyHash(t.Context(), agent, "second"); err != nil {
		t.Fatal(err)
	}
	if active("first") {
		t.Error("the previous generated key must stop working")
	}
	if !active("second") {
		t.Error("the new key must be active")
	}
	if !active("runner-key") {
		t.Error("regenerating the person-generated key must not revoke the runner's key")
	}

	found, err := repo.FindAgentByID(t.Context(), agent)
	if err != nil || !found.HasMCPAPIKey {
		t.Fatalf("HasMCPAPIKey = %v err=%v", found != nil && found.HasMCPAPIKey, err)
	}

	// An agent with only the runner's key has no generated key.
	other := fx.agent(nil, false)
	pgExec(t, db, `INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES ($1, 'agent-runner', 'abcd1234', $2)`, other, uuid.NewString())
	o, err := repo.FindAgentByID(t.Context(), other)
	if err != nil || o.HasMCPAPIKey {
		t.Fatalf("an agent with only the runner's key reports HasMCPAPIKey = %v err=%v", o != nil && o.HasMCPAPIKey, err)
	}
}
