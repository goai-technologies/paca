package postgres

import (
	"regexp"
	"testing"

	"github.com/google/uuid"
)

func TestDeriveAgentKey(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	a, b := uuid.New(), uuid.New()

	// The format services/api's API key service expects.
	if k := deriveAgentKey(secret, a, 0); !regexp.MustCompile(`^paca_[0-9a-f]{64}$`).MatchString(k) {
		t.Fatalf("key format = %q", k)
	}
	// Stable: a sandbox bakes the key in, so the same agent must always get the same one.
	first, again := deriveAgentKey(secret, a, 0), deriveAgentKey(secret, a, 0)
	if first != again {
		t.Fatal("the key must be deterministic")
	}
	// Distinct per agent, per revocation epoch and per platform secret.
	seen := map[string]string{}
	for name, k := range map[string]string{
		"agent a":      deriveAgentKey(secret, a, 0),
		"agent b":      deriveAgentKey(secret, b, 0),
		"a, epoch 1":   deriveAgentKey(secret, a, 1),
		"other secret": deriveAgentKey([]byte("another-secret-another-secret-xx"), a, 0),
	} {
		if prev, dup := seen[k]; dup {
			t.Errorf("%s and %s derive the same key", name, prev)
		}
		seen[k] = name
	}
}
