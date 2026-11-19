package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
	roledom "github.com/Paca-AI/api/internal/domain/role"
)

// ServiceAccountRepository is the sqlx implementation of
// accountdom.ServiceAccountRepository. A service account is an accounts row of
// kind service_account and nothing else.
type ServiceAccountRepository struct {
	db *sqlx.DB
}

// NewServiceAccountRepository returns a new ServiceAccountRepository.
func NewServiceAccountRepository(db *sqlx.DB) *ServiceAccountRepository {
	return &ServiceAccountRepository{db: db}
}

type accountRecord struct {
	ID             string     `db:"id"`
	Kind           string     `db:"kind"`
	Name           string     `db:"name"`
	Description    string     `db:"description"`
	AvatarKey      *string    `db:"avatar_key"`
	AvatarThumbKey *string    `db:"avatar_thumb_key"`
	CreatedBy      *string    `db:"created_by"`
	CreatedAt      time.Time  `db:"created_at"`
	UpdatedAt      time.Time  `db:"updated_at"`
	DeletedAt      *time.Time `db:"deleted_at"`
}

const serviceAccountCols = `id, kind, name, description, avatar_key, avatar_thumb_key, created_by, created_at, updated_at, deleted_at`

func (r *accountRecord) entity() *accountdom.Account {
	a := &accountdom.Account{
		ID:             mustParseUUID(r.ID),
		Kind:           accountdom.Kind(r.Kind),
		Name:           r.Name,
		Description:    r.Description,
		AvatarKey:      r.AvatarKey,
		AvatarThumbKey: r.AvatarThumbKey,
		CreatedAt:      r.CreatedAt,
		UpdatedAt:      r.UpdatedAt,
		DeletedAt:      r.DeletedAt,
	}
	if r.CreatedBy != nil {
		id := mustParseUUID(*r.CreatedBy)
		a.CreatedBy = &id
	}
	return a
}

// Create implements accountdom.ServiceAccountRepository.
func (r *ServiceAccountRepository) Create(ctx context.Context, a *accountdom.Account) error {
	return insertAccount(ctx, r.db, accountInsert{
		ID: a.ID, Kind: accountdom.KindServiceAccount, Name: a.Name, Description: a.Description,
		AvatarKey: a.AvatarKey, ThumbKey: a.AvatarThumbKey, CreatedBy: a.CreatedBy,
		CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt,
	})
}

// FindByID implements accountdom.ServiceAccountRepository.
func (r *ServiceAccountRepository) FindByID(ctx context.Context, id uuid.UUID) (*accountdom.Account, error) {
	var rec accountRecord
	err := r.db.GetContext(ctx, &rec, `SELECT `+serviceAccountCols+` FROM accounts WHERE id = $1 AND kind = 'service_account' AND deleted_at IS NULL`, id.String())
	if errors.Is(err, sql.ErrNoRows) {
		return nil, accountdom.ErrServiceAccountNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("service account repo: find: %w", err)
	}
	a := rec.entity()
	if err := r.loadRoles(ctx, []*accountdom.Account{a}); err != nil {
		return nil, err
	}
	return a, nil
}

// List implements accountdom.ServiceAccountRepository: one keyset page
// ordered by (LOWER(name), id), optionally narrowed by a search over name and
// description.
func (r *ServiceAccountRepository) List(ctx context.Context, filter accountdom.ServiceAccountFilter, cursorAfter *string, limit int) ([]*accountdom.Account, bool, int, error) {
	if limit <= 0 {
		limit = 30
	}
	where := `kind = 'service_account' AND deleted_at IS NULL`
	var args []any
	for _, word := range strings.Fields(filter.Search) {
		args = append(args, "%"+escapeLike(word)+"%")
		where += fmt.Sprintf(` AND (LOWER(name) LIKE LOWER($%[1]d) ESCAPE '\' OR LOWER(COALESCE(description, '')) LIKE LOWER($%[1]d) ESCAPE '\')`, len(args))
	}
	var total int
	if err := r.db.GetContext(ctx, &total, `SELECT COUNT(*) FROM accounts WHERE `+where, args...); err != nil {
		return nil, false, 0, fmt.Errorf("service account repo: count: %w", err)
	}
	if cursorAfter != nil && filter.Offset == 0 {
		name, id, err := accountdom.DecodeServiceAccountCursor(*cursorAfter)
		if err != nil {
			return nil, false, 0, err
		}
		args = append(args, name, id.String())
		where += fmt.Sprintf(` AND (LOWER(name), id) > ($%d, $%d::uuid)`, len(args)-1, len(args))
	}
	args = append(args, limit+1, filter.Offset)
	var recs []accountRecord
	if err := r.db.SelectContext(ctx, &recs, `SELECT `+serviceAccountCols+` FROM accounts WHERE `+where+
		fmt.Sprintf(` ORDER BY LOWER(name), id LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...); err != nil {
		return nil, false, 0, fmt.Errorf("service account repo: list: %w", err)
	}
	hasMore := len(recs) > limit
	if hasMore {
		recs = recs[:limit]
	}
	out := make([]*accountdom.Account, len(recs))
	for i := range recs {
		out[i] = recs[i].entity()
	}
	if err := r.loadRoles(ctx, out); err != nil {
		return nil, false, 0, err
	}
	return out, hasMore, total, nil
}

// loadRoles fills Roles on the accounts: the platform-wide roles attached to
// each, sorted by name, in one query.
func (r *ServiceAccountRepository) loadRoles(ctx context.Context, accounts []*accountdom.Account) error {
	if len(accounts) == 0 {
		return nil
	}
	ids := make([]string, len(accounts))
	byID := make(map[string]*accountdom.Account, len(accounts))
	for i, a := range accounts {
		ids[i] = a.ID.String()
		byID[ids[i]] = a
		a.Roles = []roledom.Summary{}
	}
	var rows []struct {
		AccountID string `db:"account_id"`
		ID        string `db:"id"`
		Name      string `db:"name"`
	}
	if err := r.db.SelectContext(ctx, &rows, `
		SELECT ra.account_id::text AS account_id, ro.id::text AS id, ro.name
		FROM role_attachments ra JOIN roles ro ON ro.id = ra.role_id
		WHERE ra.project_id IS NULL AND ra.account_id = ANY($1::uuid[])
		ORDER BY ro.name, ro.id`, ids); err != nil {
		return fmt.Errorf("service account repo: load roles: %w", err)
	}
	for _, row := range rows {
		if a := byID[row.AccountID]; a != nil {
			a.Roles = append(a.Roles, roledom.Summary{ID: mustParseUUID(row.ID), Name: row.Name})
		}
	}
	return nil
}

// Update implements accountdom.ServiceAccountRepository.
func (r *ServiceAccountRepository) Update(ctx context.Context, a *accountdom.Account) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE accounts SET name = $1, description = $2, avatar_key = $3, avatar_thumb_key = $4, updated_at = $5
		WHERE id = $6 AND kind = 'service_account' AND deleted_at IS NULL`,
		a.Name, a.Description, a.AvatarKey, a.AvatarThumbKey, a.UpdatedAt, a.ID.String())
	if err != nil {
		return fmt.Errorf("service account repo: update: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return accountdom.ErrServiceAccountNotFound
	}
	return nil
}

// Delete implements accountdom.ServiceAccountRepository. It is a soft delete
// that detaches roles and memberships; restoring a service account is not
// supported.
func (r *ServiceAccountRepository) Delete(ctx context.Context, id uuid.UUID) error {
	now := time.Now().UTC()
	return WithTx(ctx, r.db, func(tx *sqlx.Tx) error {
		res, err := tx.ExecContext(ctx, `
			UPDATE accounts SET deleted_at = $1, updated_at = $1
			WHERE id = $2 AND kind = 'service_account' AND deleted_at IS NULL`, now, id.String())
		if err != nil {
			return fmt.Errorf("service account repo: delete: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return accountdom.ErrServiceAccountNotFound
		}
		if _, err := tx.ExecContext(ctx, `UPDATE project_members SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL`, now, id.String()); err != nil {
			return fmt.Errorf("service account repo: delete memberships: %w", err)
		}
		// Keys already stop resolving with the account (see apiKeyFrom); revoking
		// them too keeps them dead for any reader that does not join accounts.
		if _, err := tx.ExecContext(ctx, `UPDATE api_keys SET revoked_at = $1 WHERE account_id = $2 AND revoked_at IS NULL`, now, id.String()); err != nil {
			return fmt.Errorf("service account repo: revoke keys: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM role_attachments WHERE account_id = $1::uuid`, id.String()); err != nil {
			return fmt.Errorf("service account repo: delete attachments: %w", err)
		}
		return nil
	})
}
