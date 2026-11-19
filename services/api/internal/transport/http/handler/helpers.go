package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/apierr"
	projectdom "github.com/Paca-AI/api/internal/domain/project"
	"github.com/Paca-AI/api/internal/transport/http/middleware"
	"github.com/Paca-AI/api/internal/transport/http/presenter"
)

// callerMemberID maps the authenticated caller to its project_members.id in
// projectID. Columns such as tasks.reporter_id and
// agent_conversations.triggered_by_member_id have a foreign key to
// project_members(id), so the account id itself must not be stored there.
func callerMemberID(r *http.Request, repo projectdom.MemberRepository, projectID uuid.UUID) (uuid.UUID, error) {
	if repo == nil {
		return uuid.Nil, apierr.New(apierr.CodeInternalError, "member resolver not available")
	}
	accountID, ok := middleware.ActorIDFromContext(r.Context())
	if !ok {
		return uuid.Nil, apierr.New(apierr.CodeUnauthenticated, "unauthenticated")
	}
	member, err := repo.FindMember(r.Context(), projectID, accountID)
	if err != nil {
		return uuid.Nil, err
	}
	return member.ID, nil
}

// callerAccountID returns the id of the account making the request, for
// handlers that return their own error rather than writing the response.
func callerAccountID(r *http.Request) (uuid.UUID, error) {
	id, ok := middleware.ActorIDFromContext(r.Context())
	if !ok {
		return uuid.Nil, apierr.New(apierr.CodeUnauthenticated, "unauthenticated")
	}
	return id, nil
}

// requireAccountID returns the id of the account making the request (the
// user, agent or service account behind the session or API key), writing a
// 401 and returning ok=false when the request is unauthenticated.
func requireAccountID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, ok := middleware.ActorIDFromContext(r.Context())
	if !ok {
		presenter.Error(w, r, apierr.New(apierr.CodeUnauthenticated, "unauthenticated"))
		return uuid.Nil, false
	}
	return id, true
}

// defaultQuery returns the URL query parameter named key, or fallback if missing/empty.
func defaultQuery(r *http.Request, key, fallback string) string {
	v := r.URL.Query().Get(key)
	if v == "" {
		return fallback
	}
	return v
}

// parsePageSize reads the page_size query parameter, capped at maxSize. An
// absent param silently falls back to defaultSize — only an explicitly
// supplied, invalid value is rejected. This intentionally differs from
// silently substituting a default: a caller driving pagination off the
// page_size it requested (e.g. computing the next offset as N * page_size)
// would otherwise get a smaller page back with no signal, skipping or
// duplicating rows against its own math.
func parsePageSize(r *http.Request, defaultSize, maxSize int) (int, error) {
	raw := r.URL.Query().Get("page_size")
	if raw == "" {
		return defaultSize, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > maxSize {
		return 0, apierr.New(apierr.CodeBadRequest, fmt.Sprintf("page_size must be an integer between 1 and %d", maxSize))
	}
	return n, nil
}

// parseOptionalPage reads the page query parameter for lists that page by
// cursor but can also be paged by number (for tables). It returns 0 when the
// parameter is absent — the caller then pages by cursor — and otherwise the
// 1-indexed page, rejecting a non-numeric or non-positive value.
func parseOptionalPage(r *http.Request) (int, error) {
	if !r.URL.Query().Has("page") {
		return 0, nil
	}
	return parsePage(r)
}

// pageOffset is the number of rows before page (1-indexed) at pageSize rows
// per page; 0 for the cursor mode (page == 0).
func pageOffset(page, pageSize int) int {
	if page <= 1 {
		return 0
	}
	return (page - 1) * pageSize
}

// parsePage reads the page query parameter (1-indexed). An absent param
// silently falls back to 1 — only an explicitly supplied, invalid value
// (non-numeric or less than 1) is rejected. See parsePageSize for why.
// maxPage bounds the page number so (page-1)*pageSize cannot overflow into a
// negative OFFSET, and keeps numbered paging from scanning absurd depths.
const maxPage = 100000

func parsePage(r *http.Request) (int, error) {
	raw := r.URL.Query().Get("page")
	if raw == "" {
		return 1, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > maxPage {
		return 0, apierr.New(apierr.CodeBadRequest, fmt.Sprintf("page must be an integer between 1 and %d", maxPage))
	}
	return n, nil
}

// splitCommaList splits a comma-separated query param into its trimmed,
// non-empty parts (e.g. "running, paused" -> ["running", "paused"]).
func splitCommaList(raw string) []string {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// maxIDsParam bounds the ids batch-lookup filter shared by the list endpoints.
const maxIDsParam = 100

// parseCursorParam returns the optional cursor query param, or nil when absent.
func parseCursorParam(r *http.Request) *string {
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		return &raw
	}
	return nil
}

// parseIDsParam reads the optional ids query param (comma-separated uuids, at
// most maxIDsParam) used for batch lookups.
func parseIDsParam(r *http.Request) ([]uuid.UUID, error) {
	raw := r.URL.Query().Get("ids")
	if raw == "" {
		return nil, nil
	}
	ids, err := parseQueryUUIDs(raw)
	if err != nil {
		return nil, apierr.New(apierr.CodeBadRequest, "invalid ids")
	}
	if len(ids) > maxIDsParam {
		return nil, apierr.New(apierr.CodeBadRequest, "ids must contain at most 100 entries")
	}
	return ids, nil
}
