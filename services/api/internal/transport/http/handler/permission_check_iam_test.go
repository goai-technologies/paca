package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
	domainauth "github.com/Paca-AI/api/internal/domain/auth"
	"github.com/Paca-AI/api/internal/platform/authz/iam"
	"github.com/Paca-AI/api/internal/transport/http/handler"
	httpmw "github.com/Paca-AI/api/internal/transport/http/middleware"
)

// POST /projects/{id}/members/me/permissions/check answers per resource, as
// the caller, with the engine's real semantics: an entity-level Deny applies
// where the project-wide action list cannot show it.
func TestCheckMyAccess_AnswersPerResourceAsTheCaller(t *testing.T) {
	projectID, otherProject := uuid.New(), uuid.New()
	userID, otherUser := uuid.New(), uuid.New()
	deniedTask, openTask := uuid.New(), uuid.New()
	p := "project/" + projectID.String()

	store := grantsByPrincipal{
		iam.User(userID.String()): {{
			RoleID: uuid.NewString(), ProjectID: projectID.String(),
			Policy: &iam.Policy{Statements: []iam.Statement{
				{Effect: iam.EffectAllow, Actions: []string{"tasks:*"}, Resources: []string{p + "/*"}},
				{Effect: iam.EffectDeny, Actions: []string{"tasks:read"}, Resources: []string{p + "/task/" + deniedTask.String()}},
			}},
		}},
		iam.User(otherUser.String()): {},
	}
	h := handler.NewProjectHandler(nil, iam.NewAuthorizer(store, iam.NewRegistry(), iam.NewAttributeSchema()))
	authz := iam.NewAuthorizer(store, iam.NewRegistry(), iam.NewAttributeSchema())

	serve := func(caller uuid.UUID, body string) *httptest.ResponseRecorder {
		principal := httpmw.Principal{AccountID: caller, Kind: accountdom.KindUser, Method: httpmw.MethodSession}
		claims := &domainauth.Claims{RegisteredClaims: jwt.RegisteredClaims{Subject: caller.String()}, Kind: "access"}
		r := chi.NewRouter()
		r.With(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				ctx := context.WithValue(req.Context(), httpmw.ClaimsContextKey(), claims)
				next.ServeHTTP(w, req.WithContext(httpmw.WithPrincipal(ctx, principal)))
			})
		}, httpmw.ProbeAccess(authz, "projectId")).Post("/projects/{projectId}/members/me/permissions/check", h.CheckMyAccess)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodPost,
			"/projects/"+projectID.String()+"/members/me/permissions/check", strings.NewReader(body)))
		return rec
	}
	check := func(action, resource string) string {
		b, _ := json.Marshal(map[string]string{"action": action, "resource": resource})
		return string(b)
	}
	allowed := func(t *testing.T, rec *httptest.ResponseRecorder) []bool {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var env struct {
			Data struct {
				Allowed []bool `json:"allowed"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatal(err)
		}
		return env.Data.Allowed
	}

	body := `{"checks":[` + strings.Join([]string{
		check("tasks:read", p+"/task/"+openTask.String()),
		check("tasks:read", p+"/task/"+deniedTask.String()),
		check("tasks:write", p+"/task/"+deniedTask.String()),
		check("docs:read", p+"/doc/"+uuid.NewString()),
		check("not:anaction", p),
	}, ",") + `]}`

	got := allowed(t, serve(userID, body))
	want := []bool{true, false, true, false, false}
	if len(got) != len(want) {
		t.Fatalf("allowed = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("check %d = %v, want %v (all: %v)", i, got[i], want[i], got)
		}
	}

	// A caller holding nothing gets all false, not an error.
	for i, a := range allowed(t, serve(otherUser, body)) {
		if a {
			t.Errorf("a caller with no roles was allowed check %d", i)
		}
	}

	bad := map[string]string{
		"empty body":             ``,
		"no checks":              `{"checks":[]}`,
		"other project resource": `{"checks":[` + check("tasks:read", "project/"+otherProject.String()+"/task/"+openTask.String()) + `]}`,
		"platform resource":      `{"checks":[` + check("users:read", "user/"+userID.String()) + `]}`,
		"no action":              `{"checks":[` + check("", p) + `]}`,
		"not json":               `nope`,
	}
	for name, b := range bad {
		if rec := serve(userID, b); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400: %s", name, rec.Code, rec.Body.String())
		}
	}

	var many []string
	for range 201 {
		many = append(many, check("tasks:read", p))
	}
	if rec := serve(userID, `{"checks":[`+strings.Join(many, ",")+`]}`); rec.Code != http.StatusBadRequest {
		t.Errorf("201 checks: got %d, want 400", rec.Code)
	}
}
