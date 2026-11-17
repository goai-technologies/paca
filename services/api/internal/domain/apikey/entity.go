// Package apikeydom provides domain entities for API key management.
package apikeydom

import (
	"time"

	"github.com/google/uuid"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
)

// APIKey represents an API key used for programmatic authentication as an
// account: a user's personal key, a service account's key or an agent's key.
// The raw key value is never stored; only key_hash (SHA-256 hex) and key_prefix
// (first 8 hex chars) are persisted.
type APIKey struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	// AccountKind is the kind of the owning account, set when the key is
	// looked up for authentication (so the caller needs no second query).
	AccountKind accountdom.Kind
	Name        string
	KeyPrefix   string
	LastUsedAt  *time.Time
	ExpiresAt   *time.Time
	CreatedAt   time.Time
	RevokedAt   *time.Time
	// CreatedBy is the account that minted the key (the admin, for a service
	// account's key); nil when unknown.
	CreatedBy *uuid.UUID
}

// IsActive reports whether the key can be used for authentication.
func (k *APIKey) IsActive() bool {
	if k.RevokedAt != nil {
		return false
	}
	if k.ExpiresAt != nil && time.Now().After(*k.ExpiresAt) {
		return false
	}
	return true
}
