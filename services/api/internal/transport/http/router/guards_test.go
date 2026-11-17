package router

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/platform/authz/iam"
	jwttoken "github.com/Paca-AI/api/internal/platform/token"
	httpmw "github.com/Paca-AI/api/internal/transport/http/middleware"
)

// scopedStore grants fixed permission sets: global (a global role) and project
// (the caller's role in whichever project is asked about), served to the IAM
// engine as migration 000064 would translate them (see roleGrants).
type scopedStore struct{ global, project []iam.Action }

func (s *scopedStore) ListGrants(context.Context, iam.Principal) ([]iam.Grant, error) {
	return roleGrants(s.global, s.project), nil
}

type gateCase struct {
	name          string
	store         scopedStore
	authenticated bool
	want          int
}

// runGate serves one request through a gate (built by build from a guards value
// wired to the case's store) and returns the status code. As in the real
// router, authentication runs first and never rejects on its own here, so the
// gate alone decides.
func runGate(t *testing.T, tc gateCase, build func(g guards) func(http.Handler) http.Handler) int {
	t.Helper()
	g := newGuards(Deps{
		IAM: newTestIAM(&tc.store),
	})
	tokens := jwttoken.New("test-secret", 15*time.Minute, 24*time.Hour)
	router := chi.NewRouter()
	router.With(httpmw.OptionalAuthn(tokens), build(g)).Get("/projects/{projectId}/thing", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/projects/"+uuid.NewString()+"/thing", nil)
	if tc.authenticated {
		req.Header.Set("Authorization", "Bearer "+issueAccessTokenForRouterTests(t))
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec.Code
}

func runGateCases(t *testing.T, cases []gateCase, build func(g guards) func(http.Handler) http.Handler) {
	t.Helper()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := runGate(t, tc, build); got != tc.want {
				t.Errorf("got %d, want %d", got, tc.want)
			}
		})
	}
}

// Global reads global grants only, and requires ALL the permissions it is given.
func TestGuards_Global(t *testing.T) {
	both := []iam.Action{iam.ActionUsersWrite, iam.ActionRolesAssign}
	runGateCases(t, []gateCase{
		{name: "holds every permission", store: scopedStore{global: both}, authenticated: true, want: http.StatusNoContent},
		{name: "one of two is not enough", store: scopedStore{global: both[:1]}, authenticated: true, want: http.StatusForbidden},
		{name: "project grants do not count", store: scopedStore{project: both}, authenticated: true, want: http.StatusForbidden},
		{name: "anonymous", store: scopedStore{global: both}, want: http.StatusUnauthorized},
	}, func(g guards) func(http.Handler) http.Handler {
		return g.Global(iam.ActionUsersWrite, iam.ActionRolesAssign)
	})
}

// Project needs the permission from the caller's role in that project. A
// global role reaches in only through the "*" wildcard (GHSA-hjcj-373w-vq8m).
func TestGuards_Project(t *testing.T) {
	runGateCases(t, []gateCase{
		{name: "project role grants it", store: scopedStore{project: []iam.Action{iam.ActionSprintsWrite}}, authenticated: true, want: http.StatusNoContent},
		{name: "a named global permission does not reach into a project", store: scopedStore{global: []iam.Action{iam.ActionSprintsWrite}}, authenticated: true, want: http.StatusForbidden},
		{name: "the global wildcard does", store: scopedStore{global: []iam.Action{actionAll}}, authenticated: true, want: http.StatusNoContent},
		{name: "no grants", authenticated: true, want: http.StatusForbidden},
		{name: "anonymous", want: http.StatusUnauthorized},
	}, func(g guards) func(http.Handler) http.Handler {
		return g.Project(iam.ActionSprintsWrite)
	})
}

// ProjectOrWorkspace admits an authenticated caller who holds the permission in
// the project or projects.read globally, and nobody who is not signed in.
func TestGuards_ProjectOrWorkspace(t *testing.T) {
	runGateCases(t, []gateCase{
		{name: "anonymous", want: http.StatusUnauthorized},
		{name: "global projects.read", store: scopedStore{global: []iam.Action{iam.ActionProjectsRead}}, authenticated: true, want: http.StatusNoContent},
		{name: "project role grants it", store: scopedStore{project: []iam.Action{iam.ActionSprintsRead}}, authenticated: true, want: http.StatusNoContent},
		{name: "logged in with nothing is refused", authenticated: true, want: http.StatusForbidden},
	}, func(g guards) func(http.Handler) http.Handler {
		return g.ProjectOrWorkspace(iam.ActionSprintsRead)
	})
}

// Opening what is inside a project never rides on the workspace-wide
// projects:read: the same grant that opens the project itself does not open its
// sprints, so a Deny or an Allow limited to some children always applies.
func TestGuards_ProjectContentsIgnoreWorkspaceProjectsRead(t *testing.T) {
	runGateCases(t, []gateCase{
		{name: "global projects.read does not open the sprints", store: scopedStore{global: []iam.Action{iam.ActionProjectsRead}}, authenticated: true, want: http.StatusForbidden},
		{name: "project role grants it", store: scopedStore{project: []iam.Action{iam.ActionSprintsRead}}, authenticated: true, want: http.StatusNoContent},
		{name: "anonymous", want: http.StatusUnauthorized},
	}, func(g guards) func(http.Handler) http.Handler {
		return g.Project(iam.ActionSprintsRead)
	})
}
