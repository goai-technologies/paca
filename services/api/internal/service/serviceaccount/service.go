// Package serviceaccountsvc implements the service account use cases: creating
// and editing the non-human accounts that authenticate with their own API keys.
package serviceaccountsvc

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
	attachmentdom "github.com/Paca-AI/api/internal/domain/attachment"
	"github.com/Paca-AI/api/internal/events"
)

// ErrAvatarServiceRequired indicates a missing AvatarService dependency when
// an avatar operation is attempted.
var ErrAvatarServiceRequired = errors.New("service account svc: avatar service required")

// Service implements accountdom.ServiceAccountService.
type Service struct {
	repo      accountdom.ServiceAccountRepository
	avatarSvc attachmentdom.AvatarService
	// grants is told when an account's access is revoked. Nil: nothing is
	// announced.
	grants events.PolicyInvalidator
}

// New returns a Service over repo.
func New(repo accountdom.ServiceAccountRepository) *Service {
	return &Service{repo: repo}
}

// WithAvatarService configures avatar upload support.
func (s *Service) WithAvatarService(svc attachmentdom.AvatarService) *Service {
	s.avatarSvc = svc
	return s
}

// WithGrantsNotifier wires in the policy cache invalidation called after a
// service account is deleted (its attachments and memberships go with it).
func (s *Service) WithGrantsNotifier(inv events.PolicyInvalidator) *Service {
	s.grants = inv
	return s
}

func validName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || utf8.RuneCountInString(name) > accountdom.MaxNameLen {
		return "", accountdom.ErrNameInvalid
	}
	return name, nil
}

func validDescription(raw string) (string, error) {
	d := strings.TrimSpace(raw)
	if utf8.RuneCountInString(d) > accountdom.MaxDescriptionLen {
		return "", accountdom.ErrDescriptionTooLong
	}
	return d, nil
}

// Create implements accountdom.ServiceAccountService.
func (s *Service) Create(ctx context.Context, in accountdom.CreateServiceAccountInput) (*accountdom.Account, error) {
	name, err := validName(in.Name)
	if err != nil {
		return nil, err
	}
	desc, err := validDescription(in.Description)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	a := &accountdom.Account{
		ID: uuid.New(), Kind: accountdom.KindServiceAccount,
		Name: name, Description: desc, CreatedBy: in.CreatedBy,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repo.Create(ctx, a); err != nil {
		return nil, err
	}
	return a, nil
}

// Get implements accountdom.ServiceAccountService.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (*accountdom.Account, error) {
	return s.repo.FindByID(ctx, id)
}

// List implements accountdom.ServiceAccountService.
func (s *Service) List(ctx context.Context, filter accountdom.ServiceAccountFilter, cursorAfter *string, limit int) ([]*accountdom.Account, bool, int, error) {
	return s.repo.List(ctx, filter, cursorAfter, limit)
}

// Update implements accountdom.ServiceAccountService.
func (s *Service) Update(ctx context.Context, id uuid.UUID, in accountdom.UpdateServiceAccountInput) (*accountdom.Account, error) {
	a, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		if a.Name, err = validName(*in.Name); err != nil {
			return nil, err
		}
	}
	if in.Description != nil {
		if a.Description, err = validDescription(*in.Description); err != nil {
			return nil, err
		}
	}
	a.UpdatedAt = time.Now().UTC()
	if err := s.repo.Update(ctx, a); err != nil {
		return nil, err
	}
	return a, nil
}

// Delete implements accountdom.ServiceAccountService.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	a, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if err := s.repo.Delete(ctx, id); err != nil {
		return err
	}
	if s.grants != nil {
		s.grants.Invalidate()
	}
	if s.avatarSvc != nil {
		s.avatarSvc.DeleteAvatarObjects(ctx, a.AvatarKey, a.AvatarThumbKey)
	}
	return nil
}

// InitiateAvatarUpload implements accountdom.ServiceAccountService.
func (s *Service) InitiateAvatarUpload(ctx context.Context, id uuid.UUID, fileName, contentType string, fileSize int64) (*attachmentdom.UploadSession, error) {
	if s.avatarSvc == nil {
		return nil, ErrAvatarServiceRequired
	}
	if _, err := s.repo.FindByID(ctx, id); err != nil {
		return nil, err
	}
	return s.avatarSvc.InitiateAvatarUpload(ctx, attachmentdom.AvatarUploadInput{
		OwnerKind:   attachmentdom.AvatarOwnerServiceAccount,
		OwnerID:     id,
		FileName:    fileName,
		ContentType: contentType,
		FileSize:    fileSize,
		UploadedBy:  id,
	})
}

// CompleteAvatarUpload implements accountdom.ServiceAccountService.
func (s *Service) CompleteAvatarUpload(ctx context.Context, id, fileID uuid.UUID) (*accountdom.Account, error) {
	if s.avatarSvc == nil {
		return nil, ErrAvatarServiceRequired
	}
	a, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	keys, err := s.avatarSvc.CompleteAvatarUpload(ctx, attachmentdom.AvatarCompleteInput{
		OwnerKind: attachmentdom.AvatarOwnerServiceAccount,
		OwnerID:   id,
		FileID:    fileID,
	})
	if err != nil {
		return nil, err
	}
	oldKey, oldThumb := a.AvatarKey, a.AvatarThumbKey
	a.AvatarKey, a.AvatarThumbKey = &keys.Key, &keys.ThumbKey
	a.UpdatedAt = time.Now().UTC()
	if err := s.repo.Update(ctx, a); err != nil {
		return nil, err
	}
	s.avatarSvc.DeleteAvatarObjects(ctx, oldKey, oldThumb)
	return a, nil
}

// RemoveAvatar implements accountdom.ServiceAccountService.
func (s *Service) RemoveAvatar(ctx context.Context, id uuid.UUID) (*accountdom.Account, error) {
	if s.avatarSvc == nil {
		return nil, ErrAvatarServiceRequired
	}
	a, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	oldKey, oldThumb := a.AvatarKey, a.AvatarThumbKey
	if oldKey == nil && oldThumb == nil {
		return a, nil
	}
	a.AvatarKey, a.AvatarThumbKey = nil, nil
	a.UpdatedAt = time.Now().UTC()
	if err := s.repo.Update(ctx, a); err != nil {
		return nil, err
	}
	s.avatarSvc.DeleteAvatarObjects(ctx, oldKey, oldThumb)
	return a, nil
}
