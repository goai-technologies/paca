package postgres

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// agentKeyName names the api_keys rows this repository owns, so they can be
// told apart from keys a person created for the same agent.
const agentKeyName = "agent-runner"

// AgentKeyRepository provides the API key an agent's Paca MCP server
// authenticates to services/api with. The key is an ordinary api_keys row of
// the agent's account (the same shape services/api's API key service stores and
// looks up: "paca_" + 64 hex characters, with the row holding its SHA-256 hex
// digest and the first 8 hex characters for display).
//
// The key is derived, not random: HMAC-SHA256 of the agent id (and a revocation
// epoch) under the platform secret, so every call for the same agent returns the
// same key and only the hash is ever stored. Stability matters because a
// sandbox bakes PACA_API_KEY into its environment: a key that changed on every
// conversation would make the sandbox look stale and be recreated each time.
// Revoking the key (in api_keys) moves the agent to the next epoch, whose key
// is new.
//
// Revoking therefore ROTATES the key rather than cutting the agent off: the
// next call registers the next epoch's key. To stop an agent, delete or
// disable the agent itself. Anyone holding the platform secret can derive
// every agent's key, so it must be protected like the keys themselves.
type AgentKeyRepository struct {
	db     *sqlx.DB
	secret []byte
}

// NewAgentKeyRepository returns a repository deriving keys under secret (the
// platform's ENCRYPTION_KEY bytes).
func NewAgentKeyRepository(db *sqlx.DB, secret []byte) *AgentKeyRepository {
	return &AgentKeyRepository{db: db, secret: append([]byte(nil), secret...)}
}

// deriveAgentKey is the plaintext key of agentID at the given revocation epoch.
func deriveAgentKey(secret []byte, agentID uuid.UUID, epoch int) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("paca.agent-runner.api-key:" + agentID.String() + ":" + strconv.Itoa(epoch)))
	return "paca_" + hex.EncodeToString(mac.Sum(nil))
}

// APIKeyFor returns the agent's API key, registering it with services/api (by
// hash) when it is not yet. It fails for an unknown or deleted agent.
func (r *AgentKeyRepository) APIKeyFor(ctx context.Context, agentID uuid.UUID) (string, error) {
	var epoch int
	if err := r.db.GetContext(ctx, &epoch,
		`SELECT count(*) FROM api_keys WHERE account_id = $1 AND name = $2 AND revoked_at IS NOT NULL`,
		agentID, agentKeyName); err != nil {
		return "", fmt.Errorf("postgres: agent key epoch for %s: %w", agentID, err)
	}
	plaintext := deriveAgentKey(r.secret, agentID, epoch)
	sum := sha256.Sum256([]byte(plaintext))
	res, err := r.db.ExecContext(ctx, `
		INSERT INTO api_keys (account_id, name, key_prefix, key_hash)
		SELECT a.id, $2, $3, $4
		FROM agents a JOIN accounts ac ON ac.id = a.id AND ac.deleted_at IS NULL
		WHERE a.id = $1
		ON CONFLICT (key_hash) DO NOTHING`,
		agentID, agentKeyName, plaintext[len("paca_"):len("paca_")+8], hex.EncodeToString(sum[:]))
	if err != nil {
		return "", fmt.Errorf("postgres: register agent key for %s: %w", agentID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Already registered, or the agent does not exist / is deleted.
		var live bool
		if err := r.db.GetContext(ctx, &live, `
			SELECT EXISTS (SELECT 1 FROM api_keys k JOIN accounts ac ON ac.id = k.account_id AND ac.deleted_at IS NULL
			               WHERE k.account_id = $1 AND k.key_hash = $2 AND k.revoked_at IS NULL)`,
			agentID, hex.EncodeToString(sum[:])); err != nil {
			return "", fmt.Errorf("postgres: check agent key for %s: %w", agentID, err)
		}
		if !live {
			return "", fmt.Errorf("postgres: agent %s has no usable API key (unknown, deleted or revoked mid-flight)", agentID)
		}
	}
	return plaintext, nil
}
