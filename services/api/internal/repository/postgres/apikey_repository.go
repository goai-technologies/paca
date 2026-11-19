package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
	apikeydom "github.com/Paca-AI/api/internal/domain/apikey"
)

// apiKeyRecord is the sqlx read model for the api_keys table joined to the
// owning account (for its kind).
type apiKeyRecord struct {
	ID          string     `db:"id"`
	AccountID   string     `db:"account_id"`
	AccountKind string     `db:"account_kind"`
	Name        string     `db:"name"`
	KeyPrefix   string     `db:"key_prefix"`
	KeyHash     string     `db:"key_hash"`
	LastUsedAt  *time.Time `db:"last_used_at"`
	ExpiresAt   *time.Time `db:"expires_at"`
	CreatedAt   time.Time  `db:"created_at"`
	RevokedAt   *time.Time `db:"revoked_at"`
	CreatedBy   *string    `db:"created_by"`
}

// apiKeyCols reads a key together with its account's kind; the account must
// be alive, so a deleted account's keys never resolve.
const apiKeyCols = `k.id, k.account_id, ac.kind AS account_kind, k.name, k.key_prefix, k.key_hash,
	k.last_used_at, k.expires_at, k.created_at, k.revoked_at, k.created_by`

const apiKeyFrom = `api_keys k JOIN accounts ac ON ac.id = k.account_id AND ac.deleted_at IS NULL`

func apiKeyToEntity(r *apiKeyRecord) (*apikeydom.APIKey, error) {
	id, err := uuid.Parse(r.ID)
	if err != nil {
		return nil, fmt.Errorf("api key repo: parse record id %q: %w", r.ID, err)
	}
	accountID, err := uuid.Parse(r.AccountID)
	if err != nil {
		return nil, fmt.Errorf("api key repo: parse record account_id %q: %w", r.AccountID, err)
	}
	key := &apikeydom.APIKey{
		ID:          id,
		AccountID:   accountID,
		AccountKind: accountdom.Kind(r.AccountKind),
		Name:        r.Name,
		KeyPrefix:   r.KeyPrefix,
		LastUsedAt:  r.LastUsedAt,
		ExpiresAt:   r.ExpiresAt,
		CreatedAt:   r.CreatedAt,
		RevokedAt:   r.RevokedAt,
	}
	if r.CreatedBy != nil {
		if cb, perr := uuid.Parse(*r.CreatedBy); perr == nil {
			key.CreatedBy = &cb
		}
	}
	return key, nil
}

// APIKeyRepository is the sqlx implementation of apikeydom.Repository.
type APIKeyRepository struct {
	db *sqlx.DB
}

// NewAPIKeyRepository returns a new APIKeyRepository.
func NewAPIKeyRepository(db *sqlx.DB) *APIKeyRepository {
	return &APIKeyRepository{db: db}
}

// FindByID returns the API key with the given ID.
func (r *APIKeyRepository) FindByID(ctx context.Context, id uuid.UUID) (*apikeydom.APIKey, error) {
	var rec apiKeyRecord
	err := r.db.GetContext(ctx, &rec, `SELECT `+apiKeyCols+` FROM `+apiKeyFrom+` WHERE k.id = $1`, id.String())
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apikeydom.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("api key repo: find by id: %w", err)
	}
	return apiKeyToEntity(&rec)
}

// FindByHash looks up an API key by its SHA-256 hash.
func (r *APIKeyRepository) FindByHash(ctx context.Context, keyHash string) (*apikeydom.APIKey, error) {
	var rec apiKeyRecord
	err := r.db.GetContext(ctx, &rec, `SELECT `+apiKeyCols+` FROM `+apiKeyFrom+` WHERE k.key_hash = $1`, keyHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apikeydom.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("api key repo: find by hash: %w", err)
	}
	return apiKeyToEntity(&rec)
}

// ListByAccountID returns one page of the account's non-revoked API keys,
// newest first (created_at DESC, id DESC). The total is returned on the
// first cursor page and on every numbered page only.
func (r *APIKeyRepository) ListByAccountID(ctx context.Context, accountID uuid.UUID, filter apikeydom.KeyFilter, cursorAfter *string, limit int) ([]*apikeydom.APIKey, bool, int, error) {
	if limit <= 0 {
		limit = 30
	}
	// The total is returned on the first cursor page and on every numbered
	// page (Offset); later cursor pages skip the COUNT.
	var total int
	if cursorAfter == nil || filter.Offset > 0 {
		if err := r.db.GetContext(ctx, &total, `SELECT COUNT(*) FROM `+apiKeyFrom+` WHERE k.account_id = $1 AND k.revoked_at IS NULL`, accountID.String()); err != nil {
			return nil, false, 0, fmt.Errorf("api key repo: count: %w", err)
		}
	}
	q := `SELECT ` + apiKeyCols + ` FROM ` + apiKeyFrom + ` WHERE k.account_id = $1 AND k.revoked_at IS NULL`
	sink := &argList{args: []any{accountID.String()}}
	if cursorAfter != nil && filter.Offset == 0 {
		at, id, err := apikeydom.DecodeCursor(*cursorAfter)
		if err != nil {
			return nil, false, 0, err
		}
		q += ` AND (k.created_at, k.id) < (` + sink.addArg(at) + `, ` + sink.addArg(id.String()) + `::uuid)`
	}
	q += ` ORDER BY k.created_at DESC, k.id DESC LIMIT ` + sink.addArg(limit+1) + ` OFFSET ` + sink.addArg(filter.Offset)
	var recs []apiKeyRecord
	if err := r.db.SelectContext(ctx, &recs, q, sink.args...); err != nil {
		return nil, false, 0, fmt.Errorf("api key repo: list: %w", err)
	}
	hasMore := len(recs) > limit
	if hasMore {
		recs = recs[:limit]
	}
	keys := make([]*apikeydom.APIKey, 0, len(recs))
	for i := range recs {
		entity, err := apiKeyToEntity(&recs[i])
		if err != nil {
			return nil, false, 0, err
		}
		keys = append(keys, entity)
	}
	return keys, hasMore, total, nil
}

// Create persists a new API key. The keyHash is stored; the raw key is never
// persisted.
func (r *APIKeyRepository) Create(ctx context.Context, key *apikeydom.APIKey, keyHash string) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, expires_at, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		key.ID.String(), key.AccountID.String(), key.Name, key.KeyPrefix, keyHash, key.ExpiresAt, nullableUUID(key.CreatedBy), key.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("api key repo: create: %w", err)
	}
	return nil
}

// Revoke soft-deletes an API key by setting revoked_at to now.
func (r *APIKeyRepository) Revoke(ctx context.Context, id uuid.UUID) error {
	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `UPDATE api_keys SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, now, id.String())
	if err != nil {
		return fmt.Errorf("api key repo: revoke: %w", err)
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return apikeydom.ErrNotFound
	}
	return nil
}

// UpdateLastUsed sets last_used_at on the given key.
func (r *APIKeyRepository) UpdateLastUsed(ctx context.Context, id uuid.UUID, at time.Time) error {
	_, err := r.db.ExecContext(ctx, `UPDATE api_keys SET last_used_at = $1 WHERE id = $2`, at, id.String())
	if err != nil {
		return fmt.Errorf("api key repo: update last used: %w", err)
	}
	return nil
}
