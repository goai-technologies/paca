package redis

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const ceremonyPrefix = "webauthn:ceremony:"

// CeremonyStore keeps the server state of an in-flight WebAuthn ceremony in
// Redis, so the finish request may land on a different API instance.
type CeremonyStore struct {
	client *redis.Client
}

// NewCeremonyStore returns a CeremonyStore.
func NewCeremonyStore(client *redis.Client) *CeremonyStore { return &CeremonyStore{client: client} }

// Put stores data under key for ttl.
func (s *CeremonyStore) Put(ctx context.Context, key string, data []byte, ttl time.Duration) error {
	if err := s.client.Set(ctx, ceremonyPrefix+key, data, ttl).Err(); err != nil {
		return fmt.Errorf("webauthn ceremony: put: %w", err)
	}
	return nil
}

// Take atomically reads and deletes key (GETDEL), so one challenge can answer
// at most one finish request. Returns nil, nil when absent or expired.
func (s *CeremonyStore) Take(ctx context.Context, key string) ([]byte, error) {
	b, err := s.client.GetDel(ctx, ceremonyPrefix+key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("webauthn ceremony: take: %w", err)
	}
	return b, nil
}
