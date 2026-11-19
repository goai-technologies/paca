package accountdom

import (
	"context"
	"errors"

	"github.com/google/uuid"

	attachmentdom "github.com/Paca-AI/api/internal/domain/attachment"
)

// Sentinel domain errors for service accounts.
var (
	// ErrServiceAccountNotFound means the service account does not exist or is deleted.
	ErrServiceAccountNotFound = errors.New("service account: not found")
	// ErrNameInvalid means the name is empty or too long.
	ErrNameInvalid = errors.New("service account: name must be 1-100 characters")
	// ErrDescriptionTooLong means the description exceeds MaxDescriptionLen.
	ErrDescriptionTooLong = errors.New("service account: description is too long")
	// ErrInvalidCursor means a list cursor could not be decoded.
	ErrInvalidCursor = errors.New("service account: invalid pagination cursor")
)

// Field limits.
const (
	MaxNameLen        = 100
	MaxDescriptionLen = 1000
)

// ServiceAccountRepository persists service accounts: accounts of kind
// service_account, which have no extension table.
type ServiceAccountRepository interface {
	// Create inserts the account (a.Kind is forced to KindServiceAccount).
	Create(ctx context.Context, a *Account) error
	// FindByID returns the live service account, or ErrServiceAccountNotFound.
	FindByID(ctx context.Context, id uuid.UUID) (*Account, error)
	// List returns up to limit live service accounts matching filter, ordered
	// by name, after the account cursorAfter names (nil = the first page), plus
	// whether more follow.
	List(ctx context.Context, filter ServiceAccountFilter, cursorAfter *string, limit int) ([]*Account, bool, int, error)
	// Update saves name, description and avatar keys.
	Update(ctx context.Context, a *Account) error
	// Delete soft-deletes the account and, in the same transaction, removes
	// its role attachments and project memberships. Its API keys stop
	// authenticating because their account is deleted.
	Delete(ctx context.Context, id uuid.UUID) error
}

// ServiceAccountFilter narrows a service account listing.
type ServiceAccountFilter struct {
	// Search is split on whitespace; every word must appear (case-insensitive)
	// in the account's name or description.
	Search string
	// Offset, when positive, skips that many accounts instead of resuming
	// from a cursor — page-number paging for tables. The cursor is then ignored.
	Offset int
}

// CreateServiceAccountInput carries the data to create a service account.
type CreateServiceAccountInput struct {
	Name        string
	Description string
	// CreatedBy is the account creating it.
	CreatedBy *uuid.UUID
}

// UpdateServiceAccountInput patches a service account; nil fields are left alone.
type UpdateServiceAccountInput struct {
	Name        *string
	Description *string
}

// ServiceAccountService is the use-case contract of service accounts.
type ServiceAccountService interface {
	Create(ctx context.Context, in CreateServiceAccountInput) (*Account, error)
	Get(ctx context.Context, id uuid.UUID) (*Account, error)
	// List is the cursor-paginated, searchable listing — see
	// ServiceAccountRepository.List.
	List(ctx context.Context, filter ServiceAccountFilter, cursorAfter *string, limit int) ([]*Account, bool, int, error)
	Update(ctx context.Context, id uuid.UUID, in UpdateServiceAccountInput) (*Account, error)
	Delete(ctx context.Context, id uuid.UUID) error

	InitiateAvatarUpload(ctx context.Context, id uuid.UUID, fileName, contentType string, fileSize int64) (*attachmentdom.UploadSession, error)
	CompleteAvatarUpload(ctx context.Context, id, fileID uuid.UUID) (*Account, error)
	RemoveAvatar(ctx context.Context, id uuid.UUID) (*Account, error)
}
