package apikeydom

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Repository defines persistence operations for API keys.
type Repository interface {
	// FindByID returns the API key with the given ID.
	FindByID(ctx context.Context, id uuid.UUID) (*APIKey, error)
	// FindByHash looks up an API key by its SHA-256 hash.
	// Returns ErrNotFound when no matching key exists or its account is
	// deleted. The result carries AccountKind.
	FindByHash(ctx context.Context, keyHash string) (*APIKey, error)
	// ListByAccountID returns one page of the account's non-revoked API keys,
	// newest first. cursorAfter is the opaque cursor from EncodeCursor (nil
	// for the first page); hasMore reports whether more keys follow and total
	// is the account's overall active key count.
	ListByAccountID(ctx context.Context, accountID uuid.UUID, filter KeyFilter, cursorAfter *string, limit int) (keys []*APIKey, hasMore bool, total int, err error)
	// Create persists a new API key.
	Create(ctx context.Context, key *APIKey, keyHash string) error
	// Revoke soft-deletes an API key by setting revoked_at.
	Revoke(ctx context.Context, id uuid.UUID) error
	// UpdateLastUsed sets last_used_at to the provided time.
	UpdateLastUsed(ctx context.Context, id uuid.UUID, at time.Time) error
}
