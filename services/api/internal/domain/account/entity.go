// Package accountdom holds the account aggregate: the identity every actor
// shares, whether it is a human user, an agent or a service account.
//
// users and agents are extension tables keyed by the account id (userdom.User
// and agentdom.Agent carry their own fields on top); a service account has
// nothing beyond what Account holds. See docs/architecture/database-schema.md (Accounts model).
package accountdom

import (
	"time"

	"github.com/google/uuid"

	roledom "github.com/Paca-AI/api/internal/domain/role"
)

// Kind is the type of an account: the only place an actor's type is stored.
// Its values equal the principal types the IAM engine reports as
// "principal.type".
type Kind string

// Account kinds.
const (
	KindUser           Kind = "user"
	KindAgent          Kind = "agent"
	KindServiceAccount Kind = "service_account"
)

// Valid reports whether k is a known kind.
func (k Kind) Valid() bool {
	switch k {
	case KindUser, KindAgent, KindServiceAccount:
		return true
	}
	return false
}

// Account is the identity shared by every kind of actor.
type Account struct {
	ID          uuid.UUID
	Kind        Kind
	Name        string
	Description string
	// AvatarKey and AvatarThumbKey are object-storage keys for the two
	// server-generated avatar variants (256x256 full, 64x64 thumb). Both nil
	// when no avatar has been uploaded. See attachmentdom.AvatarService.
	AvatarKey      *string
	AvatarThumbKey *string
	// CreatedBy is the account that created this one; nil when unknown.
	CreatedBy *uuid.UUID
	// Roles are the workspace roles attached to the account, sorted by name.
	// Only service account reads fill it (a user's and an agent's roles are
	// loaded by their own repositories).
	Roles     []roledom.Summary
	CreatedAt time.Time
	UpdatedAt time.Time
	// DeletedAt is the only soft-delete flag of an actor: a deleted account no
	// longer authenticates and frees its username / handle.
	DeletedAt *time.Time
}
