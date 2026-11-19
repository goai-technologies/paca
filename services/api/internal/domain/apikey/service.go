package apikeydom

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// CreateInput carries the data needed to create a new API key.
type CreateInput struct {
	// AccountID is the account the key authenticates as.
	AccountID uuid.UUID
	// CreatedBy is the account minting the key.
	CreatedBy *uuid.UUID
	Name      string
	ExpiresAt *time.Time
}

// Service defines the API key use-case contract.
type Service interface {
	// List returns one page of the account's active (non-revoked) API keys,
	// newest first; see Repository.ListByAccountID for the paging contract.
	List(ctx context.Context, accountID uuid.UUID, filter KeyFilter, cursorAfter *string, limit int) ([]*APIKey, bool, int, error)
	// Create generates a new API key, persists its hash, and returns the key
	// along with the raw key value (returned ONLY on creation).
	Create(ctx context.Context, in CreateInput) (*APIKey, string, error)
	// Revoke revokes an API key of the account (ErrForbidden when the key
	// belongs to another account).
	Revoke(ctx context.Context, accountID, keyID uuid.UUID) error
	// Authenticate looks up and validates an API key by its raw value.
	// On success it returns the matching key record (with the account id and kind).
	Authenticate(ctx context.Context, rawKey string) (*APIKey, error)
}
