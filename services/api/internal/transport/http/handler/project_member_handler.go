package handler

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/apierr"
	attachmentdom "github.com/Paca-AI/api/internal/domain/attachment"
	projectdom "github.com/Paca-AI/api/internal/domain/project"
	"github.com/Paca-AI/api/internal/transport/http/dto"
	"github.com/Paca-AI/api/internal/transport/http/middleware"
	"github.com/Paca-AI/api/internal/transport/http/presenter"
)

// toProjectMemberResponse maps m to a ProjectMemberResponse and, if an
// AvatarService is configured, resolves the backing user/agent's avatar
// keys into presigned display URLs.
func (h *ProjectHandler) toProjectMemberResponse(ctx context.Context, m *projectdom.ProjectMember) dto.ProjectMemberResponse {
	return memberResponse(ctx, h.avatarSvc, m)
}

// memberResponse maps m to its API shape and, when avatarSvc is non-nil,
// resolves the backing user/agent's avatar keys into presigned display URLs.
func memberResponse(ctx context.Context, avatarSvc attachmentdom.AvatarService, m *projectdom.ProjectMember) dto.ProjectMemberResponse {
	resp := dto.ProjectMemberFromEntity(m)
	if avatarSvc != nil {
		key, thumbKey := dto.MemberAvatarKeys(m)
		resp.AvatarURL, _ = avatarSvc.ResolveAvatarURL(ctx, key)
		resp.AvatarThumbURL, _ = avatarSvc.ResolveAvatarURL(ctx, thumbKey)
	}
	return resp
}

// ListMembers handles GET /projects/:projectId/members — keyset-paginated and
// filterable, for infinite-scroll lists and pickers. The response is
// {items, page_size, next_cursor, total_count}.
//
// Supported query params (all optional):
//   - page_size=<1-100>      defaults to 20
//   - cursor=<opaque>        from the previous page's next_cursor
//   - search=<text>          every word must match username, name or handle
//   - role_id=<uuid>         only members holding that project role
//   - member_type=<type>     human | agent | service_account
//   - ids=<uuid,uuid,...>    only members whose account id or membership id is
//     listed (batch lookup, at most 100)
func (h *ProjectHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	id, err := parseProjectID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	pageSize, err := parsePageSize(r, 20, 100)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	q := r.URL.Query()
	filter := projectdom.MemberFilter{Search: strings.TrimSpace(q.Get("search"))}
	if raw := q.Get("role_id"); raw != "" {
		roleID, err := uuid.Parse(raw)
		if err != nil {
			presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "invalid role_id"))
			return
		}
		filter.RoleID = &roleID
	}
	switch mt := q.Get("member_type"); mt {
	case "":
	case "human", "agent", "service_account":
		filter.MemberType = mt
	default:
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "invalid member_type"))
		return
	}
	ids, err := parseIDsParam(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	filter.AccountIDs = ids
	cursor := parseCursorParam(r)

	members, hasMore, err := h.svc.ListMembers(r.Context(), id, pageSize, cursor, filter)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	// total_count is a first-page field: later pages skip the COUNT.
	var total *int64
	if cursor == nil {
		n, err := h.svc.CountMembers(r.Context(), id, filter)
		if err != nil {
			presenter.Error(w, r, err)
			return
		}
		total = &n
	}
	items := make([]dto.ProjectMemberResponse, 0, len(members))
	for _, m := range members {
		items = append(items, h.toProjectMemberResponse(r.Context(), m))
	}
	var nextCursor *string
	if hasMore && len(members) > 0 {
		s := projectdom.EncodeMemberCursor(members[len(members)-1])
		nextCursor = &s
	}
	presenter.OK(w, r, dto.CursorProjectMembersResponse{Items: items, PageSize: pageSize, NextCursor: nextCursor, TotalCount: total})
}

// AddMember handles POST /projects/:projectId/members.
func (h *ProjectHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	id, err := parseProjectID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}

	var req dto.AddProjectMemberRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}
	set := 0
	for _, has := range []bool{
		req.UserID != uuid.Nil,
		req.AgentID != nil && *req.AgentID != uuid.Nil,
		req.ServiceAccountID != nil && *req.ServiceAccountID != uuid.Nil,
	} {
		if has {
			set++
		}
	}
	if set != 1 {
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "exactly one of user_id, agent_id or service_account_id is required"))
		return
	}
	if len(req.RoleIDs) == 0 {
		presenter.Error(w, r, apierr.New(apierr.CodeRoleRequired, "role_ids is required"))
		return
	}

	m, err := h.svc.AddMember(r.Context(), id, projectdom.AddMemberInput{
		UserID:           req.UserID,
		AgentID:          req.AgentID,
		RoleIDs:          req.RoleIDs,
		ServiceAccountID: req.ServiceAccountID,
		Description:      req.Description,
		CreatedBy:        attachmentCreator(r),
	})
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.Created(w, r, h.toProjectMemberResponse(r.Context(), m))
}

// UpdateMember handles PATCH /projects/:projectId/members/:memberId. It edits
// the member's description; roles are replaced through
// PUT /projects/:projectId/members/:memberId/roles.
func (h *ProjectHandler) UpdateMember(w http.ResponseWriter, r *http.Request) {
	projectID, err := parseProjectID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	memberID, err := uuid.Parse(chi.URLParam(r, "memberId"))
	if err != nil {
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "invalid member id"))
		return
	}

	var req dto.UpdateProjectMemberRequest
	if !middleware.BindJSON(w, r, &req) {
		return
	}
	if req.Description == nil {
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "description is required"))
		return
	}

	m, err := h.svc.UpdateMemberDescription(r.Context(), projectID, memberID, *req.Description)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, h.toProjectMemberResponse(r.Context(), m))
}

// RemoveMember handles DELETE /projects/:projectId/members/:memberId.
func (h *ProjectHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	projectID, err := parseProjectID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	memberID, err := uuid.Parse(chi.URLParam(r, "memberId"))
	if err != nil {
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "invalid member id"))
		return
	}
	if err := h.svc.RemoveMemberByMemberID(r.Context(), projectID, memberID); err != nil {
		presenter.Error(w, r, err)
		return
	}
	presenter.OK(w, r, map[string]any{"message": "member removed"})
}

// GetMyProjectPermissions handles GET /projects/:projectId/members/me/permissions.
// It returns {"actions": [...]}: the caller's effective IAM actions in the
// project (see iam.Authorizer.EffectiveActions).
// Any authenticated project member can call this endpoint regardless of which
// permissions their role grants — the lookup is always scoped to themselves.
func (h *ProjectHandler) GetMyProjectPermissions(w http.ResponseWriter, r *http.Request) {
	projectID, err := parseProjectID(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}

	// The caller's effective IAM actions in the project — every registered
	// action allowed on the project or possibly on something inside it —
	// from the engine that enforces them, judged as the account the request
	// authenticated as.
	principal, err := middleware.IAMPrincipalFrom(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	if h.authorizer == nil {
		presenter.Error(w, r, apierr.New(apierr.CodeInternalError, "authorization not configured"))
		return
	}
	actions, err := h.authorizer.EffectiveActions(r.Context(), principal, projectID.String())
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	if actions == nil {
		actions = []string{}
	}

	presenter.OK(w, r, map[string]any{"actions": actions})
}

// CheckMyAccess handles POST /projects/:projectId/members/me/permissions/check.
// The body is {"checks": [{"action", "resource"}, ...]} and the answer is
// {"allowed": [bool, ...]} in the same order. Like GetMyProjectPermissions it
// reports the caller's own access and gates nothing; the pairs are evaluated by
// middleware.ProbeAccess, so this handler decides nothing.
func (h *ProjectHandler) CheckMyAccess(w http.ResponseWriter, r *http.Request) {
	allowed, ok := middleware.AccessProbeResultsFrom(r)
	if !ok {
		presenter.Error(w, r, apierr.New(apierr.CodeInternalError, "access probe not configured"))
		return
	}
	presenter.OK(w, r, map[string]any{"allowed": allowed})
}
