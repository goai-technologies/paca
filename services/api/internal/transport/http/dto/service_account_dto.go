package dto

import (
	"time"

	"github.com/google/uuid"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
)

// CreateServiceAccountRequest is the body for POST /admin/service-accounts.
type CreateServiceAccountRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// UpdateServiceAccountRequest is the body for PATCH /admin/service-accounts/{id};
// omitted fields are left unchanged.
type UpdateServiceAccountRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

// ServiceAccountResponse is the public representation of a service account.
type ServiceAccountResponse struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	CreatedBy   *uuid.UUID `json:"created_by,omitempty"`
	// Roles are the workspace roles the account holds, sorted by name.
	Roles     []RoleSummaryResponse `json:"roles"`
	CreatedAt time.Time             `json:"created_at"`
	UpdatedAt time.Time             `json:"updated_at"`
	// AvatarURL/AvatarThumbURL are presigned GET URLs, populated by the
	// handler via attachmentdom.AvatarService; nil when no avatar is set.
	AvatarURL      *string `json:"avatar_url,omitempty"`
	AvatarThumbURL *string `json:"avatar_thumb_url,omitempty"`
}

// ServiceAccountFromEntity maps a service account to its response.
func ServiceAccountFromEntity(a *accountdom.Account) ServiceAccountResponse {
	return ServiceAccountResponse{
		ID: a.ID, Name: a.Name, Description: a.Description, CreatedBy: a.CreatedBy,
		Roles:     RoleSummariesFromEntities(a.Roles),
		CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt,
	}
}
