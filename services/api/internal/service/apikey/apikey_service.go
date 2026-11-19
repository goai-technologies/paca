// Package apikeysvc implements services for API key operations.
package apikeysvc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	apikeydom "github.com/Paca-AI/api/internal/domain/apikey"
)

const (
	keyPrefix      = "paca_"
	rawKeyHexLen   = 64 // 32 random bytes → 64 hex chars
	displayPrefLen = 8  // first N hex chars stored for display
	maxNameLen     = 100
)

// Service is the concrete implementation of apikeydom.Service.
type Service struct {
	repo apikeydom.Repository
}

// New returns a configured API key Service.
func New(repo apikeydom.Repository) *Service {
	return &Service{repo: repo}
}

// List returns one page of the account's non-revoked API keys.
func (s *Service) List(ctx context.Context, accountID uuid.UUID, filter apikeydom.KeyFilter, cursorAfter *string, limit int) ([]*apikeydom.APIKey, bool, int, error) {
	return s.repo.ListByAccountID(ctx, accountID, filter, cursorAfter, limit)
}

// Create generates a cryptographically random API key, stores its SHA-256
// hash, and returns the key record together with the raw key string.
// The raw key is returned ONLY here and is never persisted.
func (s *Service) Create(ctx context.Context, in apikeydom.CreateInput) (*apikeydom.APIKey, string, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, "", apikeydom.ErrNameInvalid
	}
	if len(name) > maxNameLen {
		return nil, "", apikeydom.ErrNameTooLong
	}

	rawBytes := make([]byte, 32)
	if _, err := rand.Read(rawBytes); err != nil {
		return nil, "", fmt.Errorf("api key svc: generate key: %w", err)
	}
	rawHex := hex.EncodeToString(rawBytes)
	rawKey := keyPrefix + rawHex

	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	key := &apikeydom.APIKey{
		ID:        uuid.New(),
		AccountID: in.AccountID,
		CreatedBy: in.CreatedBy,
		Name:      name,
		KeyPrefix: rawHex[:displayPrefLen],
		ExpiresAt: in.ExpiresAt,
		CreatedAt: time.Now().UTC(),
	}

	if err := s.repo.Create(ctx, key, keyHash); err != nil {
		return nil, "", err
	}
	return key, rawKey, nil
}

// Revoke revokes an API key. The key must belong to accountID.
func (s *Service) Revoke(ctx context.Context, accountID, keyID uuid.UUID) error {
	key, err := s.repo.FindByID(ctx, keyID)
	if err != nil {
		return err
	}
	if key.AccountID != accountID {
		return apikeydom.ErrForbidden
	}
	return s.repo.Revoke(ctx, keyID)
}

// Authenticate validates a raw API key and returns the matching record: the
// SHA-256 hash is looked up in api_keys, whichever kind of account owns the
// key (user, agent or service account). A key of a deleted account does not
// resolve. A best-effort update of last_used_at is performed; any update
// error is ignored so authentication does not fail due to its persistence.
func (s *Service) Authenticate(ctx context.Context, rawKey string) (*apikeydom.APIKey, error) {
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	key, err := s.repo.FindByHash(ctx, keyHash)
	if err != nil {
		return nil, err
	}
	if key.RevokedAt != nil {
		return nil, apikeydom.ErrRevoked
	}
	if key.ExpiresAt != nil && time.Now().After(*key.ExpiresAt) {
		return nil, apikeydom.ErrExpired
	}
	_ = s.repo.UpdateLastUsed(ctx, key.ID, time.Now().UTC())
	return key, nil
}
