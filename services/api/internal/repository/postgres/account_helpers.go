package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
)

// The accounts table is the single home of an actor's name, description,
// avatar and soft-delete flag. users and agents are extension tables keyed by
// the account id, so every write that creates or changes those shared fields
// goes through the helpers below, in the same transaction as the extension
// row. The extension tables' composite FK (id, kind) requires the account row
// to exist first.

// accountInsert is the shared part of a new actor.
type accountInsert struct {
	ID          uuid.UUID
	Kind        accountdom.Kind
	Name        string
	Description string
	AvatarKey   *string
	ThumbKey    *string
	CreatedBy   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
	DeletedAt   *time.Time
}

// insertAccount writes the accounts row of a new actor.
func insertAccount(ctx context.Context, q sqlx.ExtContext, a accountInsert) error {
	if _, err := q.ExecContext(ctx, `
		INSERT INTO accounts (id, kind, name, description, avatar_key, avatar_thumb_key, created_by, created_at, updated_at, deleted_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		a.ID.String(), string(a.Kind), a.Name, a.Description, a.AvatarKey, a.ThumbKey,
		nullableUUID(a.CreatedBy), a.CreatedAt, a.UpdatedAt, a.DeletedAt); err != nil {
		return fmt.Errorf("insert account: %w", err)
	}
	return nil
}

// updateAccountProfile saves the editable shared fields of an actor; a nil
// description leaves the stored one alone.
func updateAccountProfile(ctx context.Context, q sqlx.ExtContext, id uuid.UUID, name string, description *string, avatarKey, thumbKey *string, at time.Time) error {
	if _, err := q.ExecContext(ctx, `
		UPDATE accounts SET name = $1, description = COALESCE($2, description), avatar_key = $3, avatar_thumb_key = $4, updated_at = $5
		WHERE id = $6`,
		name, description, avatarKey, thumbKey, at, id.String()); err != nil {
		return fmt.Errorf("update account: %w", err)
	}
	return nil
}

// softDeleteAccount marks the account deleted (no-op when it already is).
func softDeleteAccount(ctx context.Context, q sqlx.ExtContext, id uuid.UUID, at time.Time) error {
	if _, err := q.ExecContext(ctx, `UPDATE accounts SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND deleted_at IS NULL`,
		at, id.String()); err != nil {
		return fmt.Errorf("soft delete account: %w", err)
	}
	return nil
}
