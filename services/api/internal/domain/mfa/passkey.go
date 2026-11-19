package mfadom

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Passkey errors.
var (
	// ErrPasskeyNotFound means the user has no passkey with that id.
	ErrPasskeyNotFound = errors.New("mfa: passkey not found")
	// ErrPasskeyInvalid means a registration response did not verify, or its
	// challenge expired. Distinct from ErrInvalidCode (a 401) because it
	// happens on a signed-in session, where a 401 would trigger a token refresh.
	ErrPasskeyInvalid = errors.New("mfa: passkey registration failed")
	// ErrPasskeyLimit means the account already has the most passkeys allowed.
	ErrPasskeyLimit = errors.New("mfa: too many passkeys")
	// ErrPasskeyUnavailable means the server has no relying-party identity
	// configured (PUBLIC_URL unset), so passkeys cannot be used.
	ErrPasskeyUnavailable = errors.New("mfa: passkeys unavailable (PUBLIC_URL not configured)")
)

// Second-factor methods an account can answer a login challenge with.
const (
	MethodTOTP    = "totp"
	MethodPasskey = "passkey"
)

// Passkey is one registered WebAuthn credential.
type Passkey struct {
	ID     uuid.UUID
	UserID uuid.UUID
	Name   string
	// CredentialID is the authenticator-assigned credential id.
	CredentialID []byte
	// Credential is the JSON-encoded WebAuthn credential record (public key,
	// sign counter, flags). It is opaque to the domain.
	Credential []byte
	CreatedAt  time.Time
	LastUsedAt *time.Time
}

// PasskeyStore is the persistence contract for passkeys.
type PasskeyStore interface {
	ListPasskeys(ctx context.Context, userID uuid.UUID) ([]Passkey, error)
	// HasPasskeys reports whether the user has any passkey, without loading them.
	HasPasskeys(ctx context.Context, userID uuid.UUID) (bool, error)
	AddPasskey(ctx context.Context, p *Passkey) error
	// UpdatePasskeyCredential stores the credential record after a sign-in
	// (new sign counter) and stamps last_used_at. A record with a lower sign
	// counter than the stored one is ignored.
	UpdatePasskeyCredential(ctx context.Context, id uuid.UUID, credential []byte, usedAt time.Time) error
	// DeletePasskey removes one of the user's passkeys, or ErrPasskeyNotFound.
	DeletePasskey(ctx context.Context, userID, id uuid.UUID) error
	DeleteUserPasskeys(ctx context.Context, userID uuid.UUID) error
}

// CeremonyStore holds the short-lived server state of an in-flight WebAuthn
// ceremony (the challenge) between its begin and finish requests.
type CeremonyStore interface {
	Put(ctx context.Context, key string, data []byte, ttl time.Duration) error
	// Take atomically reads and deletes key; nil, nil when absent or expired.
	Take(ctx context.Context, key string) ([]byte, error)
}
