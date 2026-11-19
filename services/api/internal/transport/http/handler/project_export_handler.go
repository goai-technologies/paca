package handler

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/apierr"
	exportdom "github.com/Paca-AI/api/internal/domain/export"
	"github.com/Paca-AI/api/internal/transport/http/dto"
	"github.com/Paca-AI/api/internal/transport/http/presenter"
)

// ProjectExportHandler serves project export requests. Permission checks
// live in the router (project.export); this handler only parses, calls the
// service and renders.
type ProjectExportHandler struct {
	svc exportdom.Service
}

// NewProjectExportHandler returns a handler over svc.
func NewProjectExportHandler(svc exportdom.Service) *ProjectExportHandler {
	return &ProjectExportHandler{svc: svc}
}

// RequestExport handles POST /projects/:projectId/exports. The export is
// built asynchronously, so it answers 202 with the queued export for the
// client to poll.
func (h *ProjectExportHandler) RequestExport(w http.ResponseWriter, r *http.Request) {
	projectID, err := parseProjectID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	accountID, ok := requireAccountID(w, r)
	if !ok {
		return
	}

	e, err := h.svc.RequestExport(r.Context(), projectID, accountID)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.Accepted(w, r, dto.ProjectExportFromEntity(e, time.Now()))
}

// ListExports handles GET /projects/:projectId/exports — one numbered page
// (page, default 1; page_size, default 20, max 100), newest first.
func (h *ProjectExportHandler) ListExports(w http.ResponseWriter, r *http.Request) {
	projectID, err := parseProjectID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	pageSize, err := parsePageSize(r, 20, 100)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	page, err := parsePage(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	items, total, err := h.svc.List(r.Context(), projectID, page, pageSize)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	now := time.Now()
	resp := make([]dto.ProjectExportResponse, 0, len(items))
	for _, e := range items {
		resp = append(resp, dto.ProjectExportFromEntity(e, now))
	}
	presenter.OK(w, r, map[string]any{"items": resp, "page": page, "page_size": pageSize, "total_count": total})
}

// GetExport handles GET /projects/:projectId/exports/:exportId.
func (h *ProjectExportHandler) GetExport(w http.ResponseWriter, r *http.Request) {
	projectID, exportID, err := parseExportIDs(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	e, err := h.svc.Get(r.Context(), projectID, exportID)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, dto.ProjectExportFromEntity(e, time.Now()))
}

// DownloadExport handles GET /projects/:projectId/exports/:exportId/download.
// It returns a short-lived presigned URL rather than proxying the bytes, so
// the file is served straight from object storage.
func (h *ProjectExportHandler) DownloadExport(w http.ResponseWriter, r *http.Request) {
	projectID, exportID, err := parseExportIDs(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	url, ttl, err := h.svc.DownloadURL(r.Context(), projectID, exportID)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, dto.ProjectExportDownloadResponse{URL: url, ExpiresInSeconds: int(ttl.Seconds())})
}

func parseExportIDs(r *http.Request) (projectID, exportID uuid.UUID, err error) {
	if projectID, err = parseProjectID(r); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	exportID, err = uuid.Parse(chi.URLParam(r, "exportId"))
	if err != nil {
		return uuid.Nil, uuid.Nil, apierr.New(apierr.CodeBadRequest, "invalid export id")
	}
	return projectID, exportID, nil
}
