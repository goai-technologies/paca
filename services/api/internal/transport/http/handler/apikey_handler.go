package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/apierr"
	apikeydom "github.com/Paca-AI/api/internal/domain/apikey"
	"github.com/Paca-AI/api/internal/transport/http/dto"
	"github.com/Paca-AI/api/internal/transport/http/middleware"
	"github.com/Paca-AI/api/internal/transport/http/presenter"
)

// APIKeyHandler handles API key management endpoints.
type APIKeyHandler struct {
	svc apikeydom.Service
}

// NewAPIKeyHandler returns an APIKeyHandler wired to the provided service.
func NewAPIKeyHandler(svc apikeydom.Service) *APIKeyHandler {
	return &APIKeyHandler{svc: svc}
}

// List handles GET /users/me/api-keys.
func (h *APIKeyHandler) List(w http.ResponseWriter, r *http.Request) {
	accountID, ok := requireAccountID(w, r)
	if !ok {
		return
	}

	listAPIKeys(w, r, h.svc, accountID)
}

// listAPIKeys writes one cursor page of an account's active keys; shared by
// the self-service and service-account key lists.
func listAPIKeys(w http.ResponseWriter, r *http.Request, svc apikeydom.Service, accountID uuid.UUID) {
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
	keys, hasMore, total, err := svc.List(r.Context(), accountID, apikeydom.KeyFilter{Offset: pageOffset(page, pageSize)}, cursor, pageSize)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	items := make([]dto.APIKeyResponse, 0, len(keys))
	for _, k := range keys {
		items = append(items, dto.APIKeyFromEntity(k))
	}
	var nextCursor *string
	if hasMore && len(keys) > 0 {
		last := keys[len(keys)-1]
		c := apikeydom.EncodeCursor(last.CreatedAt, last.ID)
		nextCursor = &c
	}
	body := pageBody(items, pageSize, nextCursor, cursor == nil, total)
	if page > 0 {
		// Paged by number: the caller navigates by page, not by cursor.
		body["page"] = page
		body["next_cursor"] = nil
	}
	presenter.OK(w, r, body)
}

// Create handles POST /users/me/api-keys.
func (h *APIKeyHandler) Create(w http.ResponseWriter, r *http.Request) {
	accountID, ok := requireAccountID(w, r)
	if !ok {
		return
	}

	var req dto.CreateAPIKeyRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}

	in := apikeydom.CreateInput{
		AccountID: accountID,
		CreatedBy: &accountID,
		Name:      req.Name,
		ExpiresAt: req.ExpiresAt,
	}

	key, rawKey, err := h.svc.Create(r.Context(), in)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}

	resp := dto.CreateAPIKeyResponse{
		APIKeyResponse: dto.APIKeyFromEntity(key),
		Key:            rawKey,
	}
	presenter.Created(w, r, resp)
}

// Revoke handles DELETE /users/me/api-keys/:keyId.
func (h *APIKeyHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	accountID, ok := requireAccountID(w, r)
	if !ok {
		return
	}

	keyID, err := uuid.Parse(chi.URLParam(r, "keyId"))
	if err != nil {
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "invalid key ID"))
		return
	}

	if err := h.svc.Revoke(r.Context(), accountID, keyID); err != nil {
		presenter.Error(w, r, err)
		return
	}

	presenter.NoContent(w)
}
