package handler

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/apierr"
	accountdom "github.com/Paca-AI/api/internal/domain/account"
	apikeydom "github.com/Paca-AI/api/internal/domain/apikey"
	attachmentdom "github.com/Paca-AI/api/internal/domain/attachment"
	"github.com/Paca-AI/api/internal/transport/http/dto"
	"github.com/Paca-AI/api/internal/transport/http/middleware"
	"github.com/Paca-AI/api/internal/transport/http/presenter"
)

// ServiceAccountHandler serves /admin/service-accounts: the non-human accounts
// that authenticate with their own API keys. Roles are served by RoleHandler.
type ServiceAccountHandler struct {
	svc       accountdom.ServiceAccountService
	keys      apikeydom.Service
	avatarSvc attachmentdom.AvatarService
}

// NewServiceAccountHandler returns a new ServiceAccountHandler.
func NewServiceAccountHandler(svc accountdom.ServiceAccountService, keys apikeydom.Service) *ServiceAccountHandler {
	return &ServiceAccountHandler{svc: svc, keys: keys}
}

// WithAvatarService configures avatar URL resolution for responses.
func (h *ServiceAccountHandler) WithAvatarService(svc attachmentdom.AvatarService) *ServiceAccountHandler {
	h.avatarSvc = svc
	return h
}

func (h *ServiceAccountHandler) response(ctx context.Context, a *accountdom.Account) dto.ServiceAccountResponse {
	resp := dto.ServiceAccountFromEntity(a)
	if h.avatarSvc != nil {
		resp.AvatarURL, _ = h.avatarSvc.ResolveAvatarURL(ctx, a.AvatarKey)
		resp.AvatarThumbURL, _ = h.avatarSvc.ResolveAvatarURL(ctx, a.AvatarThumbKey)
	}
	return resp
}

func serviceAccountID(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "serviceAccountId"))
	if err != nil {
		return uuid.Nil, apierr.New(apierr.CodeBadRequest, "invalid service account id")
	}
	return id, nil
}

// List handles GET /admin/service-accounts — one cursor-paginated page of
// service accounts ordered by name:
//   - page_size=<1-100>  (default 30)
//   - cursor=<opaque>    from the previous page's next_cursor
//   - search=<text>      every word must appear in the name or description
//
// Responds with {"items": [...], "page_size": n, "next_cursor": ...}.
func (h *ServiceAccountHandler) List(w http.ResponseWriter, r *http.Request) {
	pageSize, err := parsePageSize(r, 30, 100)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	page, err := parseOptionalPage(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	cursor := parseCursorParam(r)
	accounts, hasMore, total, err := h.svc.List(r.Context(), accountdom.ServiceAccountFilter{
		Search: strings.TrimSpace(r.URL.Query().Get("search")),
		Offset: pageOffset(page, pageSize),
	}, cursor, pageSize)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	items := make([]dto.ServiceAccountResponse, len(accounts))
	for i, a := range accounts {
		items[i] = h.response(r.Context(), a)
	}
	var nextCursor *string
	if hasMore && len(accounts) > 0 {
		c := accountdom.EncodeServiceAccountCursor(accounts[len(accounts)-1])
		nextCursor = &c
	}
	body := map[string]any{"items": items, "page_size": pageSize, "next_cursor": nextCursor, "total_count": total}
	if page > 0 {
		// Paged by number: the caller navigates by page, not by cursor.
		body["page"] = page
		body["next_cursor"] = nil
	}
	presenter.OK(w, r, body)
}

// Create handles POST /admin/service-accounts.
func (h *ServiceAccountHandler) Create(w http.ResponseWriter, r *http.Request) {
	var req dto.CreateServiceAccountRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}
	a, err := h.svc.Create(r.Context(), accountdom.CreateServiceAccountInput{
		Name: req.Name, Description: req.Description, CreatedBy: attachmentCreator(r),
	})
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.Created(w, r, h.response(r.Context(), a))
}

// Get handles GET /admin/service-accounts/{serviceAccountId}.
func (h *ServiceAccountHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	a, err := h.svc.Get(r.Context(), id)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, h.response(r.Context(), a))
}

// Update handles PATCH /admin/service-accounts/{serviceAccountId}.
func (h *ServiceAccountHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	var req dto.UpdateServiceAccountRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}
	a, err := h.svc.Update(r.Context(), id, accountdom.UpdateServiceAccountInput{Name: req.Name, Description: req.Description})
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, h.response(r.Context(), a))
}

// Delete handles DELETE /admin/service-accounts/{serviceAccountId}.
func (h *ServiceAccountHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	if err := h.svc.Delete(r.Context(), id); err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.NoContent(w)
}

// --- API keys ---------------------------------------------------------------

// ListAPIKeys handles GET /admin/service-accounts/{serviceAccountId}/api-keys.
func (h *ServiceAccountHandler) ListAPIKeys(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	if _, err := h.svc.Get(r.Context(), id); err != nil {
		presenter.Error(w, r, err)
		return
	}
	listAPIKeys(w, r, h.keys, id)
}

// CreateAPIKey handles POST /admin/service-accounts/{serviceAccountId}/api-keys.
// The raw key is returned once.
func (h *ServiceAccountHandler) CreateAPIKey(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	if _, err := h.svc.Get(r.Context(), id); err != nil {
		presenter.Error(w, r, err)
		return
	}
	var req dto.CreateAPIKeyRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}
	key, raw, err := h.keys.Create(r.Context(), apikeydom.CreateInput{
		AccountID: id, CreatedBy: attachmentCreator(r), Name: req.Name, ExpiresAt: req.ExpiresAt,
	})
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.Created(w, r, dto.CreateAPIKeyResponse{APIKeyResponse: dto.APIKeyFromEntity(key), Key: raw})
}

// RevokeAPIKey handles DELETE /admin/service-accounts/{serviceAccountId}/api-keys/{keyId}.
func (h *ServiceAccountHandler) RevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	keyID, err := uuid.Parse(chi.URLParam(r, "keyId"))
	if err != nil {
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "invalid key ID"))
		return
	}
	// Like the other key routes, only a service account's keys are reachable
	// here: a user's or agent's id in the path must not revoke their keys.
	if _, err := h.svc.Get(r.Context(), id); err != nil {
		presenter.Error(w, r, err)
		return
	}
	if err := h.keys.Revoke(r.Context(), id, keyID); err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.NoContent(w)
}

// --- Avatar -----------------------------------------------------------------

// InitiateAvatarUpload handles POST /admin/service-accounts/{serviceAccountId}/avatar/initiate-upload.
func (h *ServiceAccountHandler) InitiateAvatarUpload(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	var req dto.InitiateUploadRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}
	session, err := h.svc.InitiateAvatarUpload(r.Context(), id, req.FileName, req.ContentType, req.FileSize)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.Created(w, r, dto.UploadSessionFromDomain(session))
}

// CompleteAvatarUpload handles POST /admin/service-accounts/{serviceAccountId}/avatar/complete-upload.
func (h *ServiceAccountHandler) CompleteAvatarUpload(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	var req dto.CompleteAvatarUploadRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}
	a, err := h.svc.CompleteAvatarUpload(r.Context(), id, req.FileID)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, h.response(r.Context(), a))
}

// DeleteAvatar handles DELETE /admin/service-accounts/{serviceAccountId}/avatar.
func (h *ServiceAccountHandler) DeleteAvatar(w http.ResponseWriter, r *http.Request) {
	id, err := serviceAccountID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	a, err := h.svc.RemoveAvatar(r.Context(), id)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, h.response(r.Context(), a))
}
