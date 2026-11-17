package integration_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/platform/authz/iam"
)

// The whole service account story over the real stack: an administrator creates
// an account, mints its API key (with a session only), grants it a role, and the
// account then acts with that key — and nothing more than its roles allow.
func TestServiceAccountsAPI_EndToEnd(t *testing.T) {
	e := newRoleAPIEnv(t)

	// Administrators: one may manage service accounts, one holds roles:assign.
	manager := e.user()
	e.attach(e.role("SA manager", `{"version":"2026-10-01","statements":[`+
		allowStmt(`"service_accounts:*","roles:read"`, `"service_account/*","role/*"`)+`]}`, nil), manager, nil)
	root := e.user()
	e.attach(e.role("Root", `{"version":"2026-10-01","statements":[`+allowStmt(`"*"`, `"*"`)+`]}`, nil), root, nil)
	nobody := e.user()

	var created struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
	}

	t.Run("only holders of service_accounts:* can manage them", func(t *testing.T) {
		if res := e.call(nobody, http.MethodGet, "/admin/service-accounts", nil); res.code != http.StatusForbidden {
			t.Fatalf("list as nobody: %d", res.code)
		}
		if res := e.call(nobody, http.MethodPost, "/admin/service-accounts", map[string]any{"name": "x"}); res.code != http.StatusForbidden {
			t.Fatalf("create as nobody: %d", res.code)
		}
	})

	t.Run("create validates and records the creator", func(t *testing.T) {
		if res := e.call(manager, http.MethodPost, "/admin/service-accounts", map[string]any{"name": "  "}); res.code != http.StatusBadRequest || res.errorCode() != "SERVICE_ACCOUNT_NAME_INVALID" {
			t.Fatalf("blank name: %d %s", res.code, res.errorCode())
		}
		res := e.call(manager, http.MethodPost, "/admin/service-accounts", map[string]any{"name": " CI bot ", "description": "deploys"})
		if res.code != http.StatusCreated {
			t.Fatalf("create: %d %s", res.code, res.body)
		}
		res.data(t, &created)
		if created.Name != "CI bot" || created.Description != "deploys" || created.ID == "" {
			t.Fatalf("created = %+v", created)
		}
		var by *string
		if err := e.db.Get(&by, `SELECT created_by::text FROM accounts WHERE id = $1 AND kind = 'service_account'`, created.ID); err != nil || by == nil || *by != manager.String() {
			t.Fatalf("created_by = %v err=%v", by, err)
		}
		// The account cannot log in: it has no users row.
		var n int
		if err := e.db.Get(&n, `SELECT count(*) FROM users WHERE id = $1`, created.ID); err != nil || n != 0 {
			t.Fatalf("a service account must have no users row: %d %v", n, err)
		}
	})

	t.Run("get, list and patch", func(t *testing.T) {
		var list []struct {
			ID, Name string
			Roles    []struct{ Name string }
		}
		res := e.call(manager, http.MethodGet, "/admin/service-accounts", nil)
		res.data(t, &list)
		if res.code != http.StatusOK || len(list) != 1 || list[0].ID != created.ID {
			t.Fatalf("list: %d %+v", res.code, list)
		}
		if list[0].Roles == nil || len(list[0].Roles) != 0 {
			t.Fatalf("a new account lists an empty roles array, got %+v", list[0].Roles)
		}
		if res := e.call(manager, http.MethodPatch, "/admin/service-accounts/"+created.ID, map[string]any{"name": "Release bot"}); res.code != http.StatusOK {
			t.Fatalf("patch: %d %s", res.code, res.body)
		}
		var got struct{ Name, Description string }
		res = e.call(manager, http.MethodGet, "/admin/service-accounts/"+created.ID, nil)
		res.data(t, &got)
		if got.Name != "Release bot" || got.Description != "deploys" {
			t.Fatalf("after patch: %+v", got)
		}
		if res := e.call(manager, http.MethodGet, "/admin/service-accounts/"+uuid.NewString(), nil); res.code != http.StatusNotFound || res.errorCode() != "SERVICE_ACCOUNT_NOT_FOUND" {
			t.Fatalf("unknown: %d %s", res.code, res.errorCode())
		}
		// A user id is not a service account.
		if res := e.call(manager, http.MethodGet, "/admin/service-accounts/"+nobody.String(), nil); res.code != http.StatusNotFound {
			t.Fatalf("user id as service account: %d", res.code)
		}
	})

	var key struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	t.Run("a session mints a key, shown once", func(t *testing.T) {
		res := e.call(manager, http.MethodPost, "/admin/service-accounts/"+created.ID+"/api-keys", map[string]any{"name": "ci"})
		if res.code != http.StatusCreated {
			t.Fatalf("mint: %d %s", res.code, res.body)
		}
		res.data(t, &key)
		if len(key.Key) < 20 || key.ID == "" {
			t.Fatalf("key = %+v", key)
		}
		var list []map[string]any
		res = e.call(manager, http.MethodGet, "/admin/service-accounts/"+created.ID+"/api-keys", nil)
		res.data(t, &list)
		if len(list) != 1 {
			t.Fatalf("keys listed: %d", len(list))
		}
		if _, leaked := list[0]["key"]; leaked {
			t.Fatal("the raw key must never be listed")
		}
		var by *string
		if err := e.db.Get(&by, `SELECT created_by::text FROM api_keys WHERE id = $1`, key.ID); err != nil || by == nil || *by != manager.String() {
			t.Fatalf("key created_by = %v err=%v", by, err)
		}
	})

	t.Run("the account has no permissions until it is given roles", func(t *testing.T) {
		if res := e.callKey(key.Key, http.MethodGet, "/admin/service-accounts", nil); res.code != http.StatusForbidden {
			t.Fatalf("a fresh service account must be denied, got %d", res.code)
		}
	})

	t.Run("roles are assigned like for any account, and then apply", func(t *testing.T) {
		reader := e.role("SA reader", `{"version":"2026-10-01","statements":[`+allowStmt(`"service_accounts:read"`, `"service_account/*"`)+`]}`, nil)
		path := "/admin/service-accounts/" + created.ID + "/roles"
		// The manager lacks roles:assign.
		if res := e.call(manager, http.MethodPut, path, map[string]any{"role_ids": []string{reader.String()}}); res.code != http.StatusForbidden {
			t.Fatalf("assign without roles:assign: %d", res.code)
		}
		if res := e.call(root, http.MethodPut, path, map[string]any{"role_ids": []string{reader.String()}}); res.code != http.StatusOK {
			t.Fatalf("assign: %d %s", res.code, res.body)
		}
		var roles []struct{ Name string }
		res := e.call(manager, http.MethodGet, path, nil)
		res.data(t, &roles)
		if res.code != http.StatusOK || len(roles) != 1 || roles[0].Name != "SA reader" {
			t.Fatalf("roles: %d %+v", res.code, roles)
		}
		var listed []struct {
			Roles []struct{ Name string }
		}
		res = e.callKey(key.Key, http.MethodGet, "/admin/service-accounts", nil)
		if res.code != http.StatusOK {
			t.Fatalf("the account's read role must apply, got %d %s", res.code, res.body)
		}
		res.data(t, &listed)
		if len(listed) != 1 || len(listed[0].Roles) != 1 || listed[0].Roles[0].Name != "SA reader" {
			t.Fatalf("the list must show the account's role: %+v", listed)
		}
		if res := e.callKey(key.Key, http.MethodPost, "/admin/service-accounts", map[string]any{"name": "x"}); res.code != http.StatusForbidden {
			t.Fatalf("it must not write, got %d", res.code)
		}
	})

	t.Run("an API key cannot manage credentials", func(t *testing.T) {
		full := e.role("SA full", `{"version":"2026-10-01","statements":[`+allowStmt(`"service_accounts:*"`, `"service_account/*"`)+`]}`, nil)
		e.exec(`INSERT INTO role_attachments (role_id, account_id) VALUES ($1, $2)`, full, created.ID)
		if res := e.callKey(key.Key, http.MethodPost, "/admin/service-accounts/"+created.ID+"/api-keys", map[string]any{"name": "more"}); res.code != http.StatusForbidden {
			t.Fatalf("minting with an API key: %d %s", res.code, res.body)
		}
		if res := e.callKey(key.Key, http.MethodDelete, "/admin/service-accounts/"+created.ID+"/api-keys/"+key.ID, nil); res.code != http.StatusForbidden {
			t.Fatalf("revoking with an API key: %d", res.code)
		}
		e.exec(`DELETE FROM role_attachments WHERE role_id = $1`, full)
	})

	t.Run("a project role needs project membership", func(t *testing.T) {
		project := e.project()
		viewer := e.role("Viewer", `{"version":"2026-10-01","statements":[`+allowStmt(`"tasks:read"`, `"project/`+project.String()+`/*"`)+`]}`, &project)
		sa := uuid.MustParse(created.ID)
		e.attach(viewer, sa, &project)
		sar := iam.Principal{Type: iam.PrincipalServiceAccount, ID: created.ID}
		check := func() bool {
			res, err := e.authz.Authorize(t.Context(), sar, "tasks:read", "project/"+project.String())
			if err != nil {
				t.Fatal(err)
			}
			return res.Allowed
		}
		if check() {
			t.Fatal("a project role must not apply before the account is a member")
		}
		e.member(project, sa)
		if !check() {
			t.Fatal("the project role must apply once the account is a member")
		}
	})

	t.Run("a user's keys are out of reach of the service account routes", func(t *testing.T) {
		var own struct{ ID string }
		own.ID = uuid.NewString()
		if _, err := e.db.ExecContext(t.Context(), `INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash) VALUES ($1, $2, 'mine', 'abcd1234', 'hash')`, own.ID, nobody); err != nil {
			t.Fatal(err)
		}
		// The manager holds service_accounts:write, but nobody is not a service account.
		res := e.call(manager, http.MethodDelete, "/admin/service-accounts/"+nobody.String()+"/api-keys/"+own.ID, nil)
		if res.code != http.StatusNotFound || res.errorCode() != "SERVICE_ACCOUNT_NOT_FOUND" {
			t.Fatalf("revoking a user's key: %d %s", res.code, res.body)
		}
		var revoked *string
		if err := e.db.Get(&revoked, `SELECT revoked_at::text FROM api_keys WHERE id = $1`, own.ID); err != nil || revoked != nil {
			t.Fatalf("the user's key must stay active: %v %v", revoked, err)
		}
	})

	t.Run("revoking a key stops it", func(t *testing.T) {
		if res := e.call(manager, http.MethodDelete, "/admin/service-accounts/"+created.ID+"/api-keys/"+key.ID, nil); res.code != http.StatusNoContent {
			t.Fatalf("revoke: %d %s", res.code, res.body)
		}
		if res := e.callKey(key.Key, http.MethodGet, "/admin/service-accounts", nil); res.code != http.StatusUnauthorized {
			t.Fatalf("revoked key: %d", res.code)
		}
	})

	t.Run("deleting the account stops everything", func(t *testing.T) {
		res := e.call(manager, http.MethodPost, "/admin/service-accounts/"+created.ID+"/api-keys", map[string]any{"name": "again"})
		var k2 struct{ Key string }
		res.data(t, &k2)
		if res := e.callKey(k2.Key, http.MethodGet, "/admin/service-accounts", nil); res.code != http.StatusOK {
			t.Fatalf("second key: %d", res.code)
		}
		if res := e.call(manager, http.MethodDelete, "/admin/service-accounts/"+created.ID, nil); res.code != http.StatusNoContent {
			t.Fatalf("delete: %d %s", res.code, res.body)
		}
		if res := e.callKey(k2.Key, http.MethodGet, "/admin/service-accounts", nil); res.code != http.StatusUnauthorized {
			t.Fatalf("a deleted account's key: %d", res.code)
		}
		if res := e.call(manager, http.MethodGet, "/admin/service-accounts/"+created.ID, nil); res.code != http.StatusNotFound {
			t.Fatalf("deleted account: %d", res.code)
		}
		var n int
		if err := e.db.Get(&n, `SELECT count(*) FROM role_attachments WHERE account_id = $1`, created.ID); err != nil || n != 0 {
			t.Fatalf("attachments left: %d %v", n, err)
		}
	})
}
