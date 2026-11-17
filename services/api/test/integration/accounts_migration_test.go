package integration_test

// Test for migrations/000066_unified_accounts.sql: seeds a database shaped like
// the one before it (users, agents, memberships, attachments, keys, an orphan
// attachment), applies the migration, and checks that every actor became an
// account with its id preserved, that the duplicated columns are gone, and that
// the live-uniqueness and cleanup triggers hold.
//
// Needs a disposable Postgres: set PACA_TEST_PG_DSN (see iam_migration_test.go).

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/platform/database"
)

const accountsMigrationFile = "000066_unified_accounts.sql"

func TestUnifiedAccountsMigration(t *testing.T) {
	db := newMigrationTestDB(t)
	if err := database.RunMigrationsFS(db, migrationsBefore(t, accountsMigrationFile)); err != nil {
		t.Fatalf("apply earlier migrations: %v", err)
	}

	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(t.Context(), q, args...); err != nil {
			t.Fatalf("exec %q: %v", q, err)
		}
	}
	var userRole string
	if err := db.QueryRowContext(t.Context(), `SELECT id::text FROM global_roles WHERE name = 'USER'`).Scan(&userRole); err != nil {
		t.Fatal(err)
	}

	alice, bob, oldBob := uuid.New(), uuid.New(), uuid.New()
	p1, p2 := uuid.New(), uuid.New()
	agentP1, agentP2, agentGlobal := uuid.New(), uuid.New(), uuid.New()
	mAlice, mAgent, mGlobal := uuid.New(), uuid.New(), uuid.New()
	role, ghost := uuid.New(), uuid.New()

	exec(`INSERT INTO users (id, username, password_hash, full_name, role_id, email) VALUES ($1,'alice','x','Alice A',$2,'alice@x.io')`, alice, userRole)
	exec(`INSERT INTO users (id, username, password_hash, full_name, role_id) VALUES ($1,'bob','x','',$2)`, bob, userRole)
	exec(`INSERT INTO users (id, username, password_hash, full_name, role_id, deleted_at) VALUES ($1,'bob','x','Old Bob',$2, now())`, oldBob, userRole)
	exec(`INSERT INTO projects (id, name) VALUES ($1,'P1'), ($2,'P2')`, p1, p2)
	exec(`INSERT INTO agents (id, project_id, name, handle, llm_provider, llm_model, llm_api_key_secret, created_by, agent_type, acp_provider, mcp_api_key_hash, description)
		VALUES ($1,$2,'Coder','coder','','','',$3,'acp','claude-code','hash-mcp','does code')`, agentP1, p1, alice)
	exec(`INSERT INTO agents (id, project_id, name, handle, llm_provider, llm_model, llm_api_key_secret) VALUES ($1,$2,'Coder','coder','a','m','s')`, agentP2, p2)
	exec(`INSERT INTO agents (id, project_id, name, handle, llm_provider, llm_model, llm_api_key_secret, agent_scope) VALUES ($1,NULL,'Helper','helper','a','m','s','global')`, agentGlobal)
	exec(`INSERT INTO project_members (id, project_id, user_id, member_type) VALUES ($1,$2,$3,'human')`, mAlice, p1, alice)
	exec(`INSERT INTO project_members (id, project_id, agent_id, member_type) VALUES ($1,$2,$3,'agent'), ($4,$2,$5,'agent')`, mAgent, p1, agentP1, mGlobal, agentGlobal)
	exec(`INSERT INTO roles (id, name, policy) VALUES ($1,'R','{"version":"2026-10-01","statements":[]}')`, role)
	exec(`INSERT INTO role_attachments (role_id, principal_type, principal_id, created_by) VALUES ($1,'user',$2,$2), ($1,'agent',$3,NULL), ($1,'user',$4,NULL)`, role, alice, agentGlobal, ghost)
	exec(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1,'k','abcd1234','hash-user')`, alice)
	exec(`INSERT INTO files (storage_key, bucket, file_name, uploaded_by) VALUES ('k','b','f',$1)`, alice)

	if err := database.RunMigrationsFS(db, migrationsThrough(t, accountsMigrationFile)); err != nil {
		t.Fatalf("apply %s: %v", accountsMigrationFile, err)
	}

	scan := func(dst any, q string, args ...any) {
		t.Helper()
		if err := db.QueryRowContext(t.Context(), q, args...).Scan(dst); err != nil {
			t.Fatalf("%q: %v", q, err)
		}
	}
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		scan(&n, q, args...)
		return n
	}

	t.Run("every actor is an account with its id preserved", func(t *testing.T) {
		type acct struct {
			kind, name, desc string
			deleted          bool
			createdBy        sql.NullString
		}
		want := map[uuid.UUID]acct{
			alice:       {kind: "user", name: "Alice A"},
			bob:         {kind: "user", name: "bob"}, // empty full_name falls back to the username
			oldBob:      {kind: "user", name: "Old Bob", deleted: true},
			agentP1:     {kind: "agent", name: "Coder", desc: "does code", createdBy: sql.NullString{String: alice.String(), Valid: true}},
			agentP2:     {kind: "agent", name: "Coder"},
			agentGlobal: {kind: "agent", name: "Helper"},
		}
		for id, w := range want {
			var g acct
			scan(&g.kind, `SELECT kind FROM accounts WHERE id = $1`, id)
			scan(&g.name, `SELECT name FROM accounts WHERE id = $1`, id)
			scan(&g.desc, `SELECT description FROM accounts WHERE id = $1`, id)
			scan(&g.deleted, `SELECT deleted_at IS NOT NULL FROM accounts WHERE id = $1`, id)
			scan(&g.createdBy, `SELECT created_by::text FROM accounts WHERE id = $1`, id)
			if g != w {
				t.Errorf("account %s = %+v, want %+v", id, g, w)
			}
		}
		if n := count(`SELECT count(*) FROM accounts`); n != len(want) {
			t.Errorf("%d accounts, want %d", n, len(want))
		}
	})

	t.Run("duplicated and legacy columns are gone", func(t *testing.T) {
		for _, c := range [][2]string{
			{"users", "full_name"}, {"users", "deleted_at"}, {"users", "role_id"}, {"users", "avatar_key"},
			{"agents", "name"}, {"agents", "deleted_at"}, {"agents", "agent_scope"}, {"agents", "global_role_id"},
			{"agents", "mcp_api_key_hash"}, {"agents", "avatar_key"}, {"agents", "created_by"},
			{"project_members", "user_id"}, {"project_members", "agent_id"}, {"project_members", "member_type"}, {"project_members", "project_role_id"},
			{"role_attachments", "principal_type"}, {"role_attachments", "principal_id"},
			{"api_keys", "user_id"},
		} {
			if n := count(`SELECT count(*) FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, c[0], c[1]); n != 0 {
				t.Errorf("%s.%s still exists", c[0], c[1])
			}
		}
	})

	t.Run("memberships, attachments and keys follow the account", func(t *testing.T) {
		for m, acc := range map[uuid.UUID]uuid.UUID{mAlice: alice, mAgent: agentP1, mGlobal: agentGlobal} {
			var got uuid.UUID
			scan(&got, `SELECT account_id FROM project_members WHERE id = $1`, m)
			if got != acc {
				t.Errorf("member %s account = %s, want %s", m, got, acc)
			}
		}
		if n := count(`SELECT count(*) FROM role_attachments`); n != 2 {
			t.Errorf("%d attachments, want 2 (the orphan is dropped)", n)
		}
		if n := count(`SELECT count(*) FROM role_attachments WHERE account_id = $1`, ghost); n != 0 {
			t.Error("the orphan attachment survived")
		}
		// The agent's MCP key became an api_keys row; the user's key kept its owner.
		if n := count(`SELECT count(*) FROM api_keys WHERE account_id = $1 AND key_hash = 'hash-mcp'`, agentP1); n != 1 {
			t.Errorf("agent MCP key migrated %d times", n)
		}
		if n := count(`SELECT count(*) FROM api_keys WHERE account_id = $1 AND key_hash = 'hash-user' AND created_by = $1`, alice); n != 1 {
			t.Error("the user's key lost its owner or creator")
		}
	})

	t.Run("a service account can do what an actor does", func(t *testing.T) {
		sa := uuid.New()
		exec(`INSERT INTO accounts (id, kind, name) VALUES ($1,'service_account','CI')`, sa)
		exec(`INSERT INTO files (storage_key, bucket, file_name, uploaded_by) VALUES ('k2','b','f',$1)`, sa)
		exec(`INSERT INTO api_keys (account_id, name, key_prefix, key_hash, created_by) VALUES ($1,'k','abcd1234','hash-sa',$2)`, sa, alice)
		exec(`INSERT INTO project_members (id, project_id, account_id) VALUES ($1,$2,$3)`, uuid.New(), p1, sa)
		exec(`INSERT INTO role_attachments (role_id, account_id) VALUES ($1,$2)`, role, sa)
	})

	t.Run("live uniqueness is enforced by the trigger", func(t *testing.T) {
		insertUser := func(id uuid.UUID, username string, email any) error {
			if _, err := db.ExecContext(t.Context(), `INSERT INTO accounts (id, kind, name) VALUES ($1,'user',$2)`, id, username); err != nil {
				return err
			}
			_, err := db.ExecContext(t.Context(), `INSERT INTO users (id, username, password_hash, email) VALUES ($1,$2,'x',$3)`, id, username, email)
			return err
		}
		expectDup := func(name string, err error, constraint string) {
			t.Helper()
			if err == nil || !strings.Contains(err.Error(), constraint) && !strings.Contains(err.Error(), "duplicate live account") {
				t.Errorf("%s: want a duplicate error, got %v", name, err)
			}
		}
		tx := func(f func() error) error { // each attempt in its own aborted transaction
			return f()
		}
		expectDup("username", tx(func() error { return insertUser(uuid.New(), "alice", nil) }), "uni_users_username_active")
		expectDup("email", tx(func() error { return insertUser(uuid.New(), "alice2", "alice@x.io") }), "uni_users_email_active")

		// A deleted account's username is free; reusing it blocks the restore.
		if err := insertUser(uuid.New(), "old-name", nil); err != nil {
			t.Fatalf("a fresh username: %v", err)
		}
		_, err := db.ExecContext(t.Context(), `UPDATE accounts SET deleted_at = NULL WHERE id = $1`, oldBob)
		expectDup("restore", err, "uni_users_username_active")

		// Agent handles are unique per project, and among global agents.
		agentIn := func(project any, handle string) error {
			id := uuid.New()
			if _, err := db.ExecContext(t.Context(), `INSERT INTO accounts (id, kind, name) VALUES ($1,'agent','A')`, id); err != nil {
				return err
			}
			_, err := db.ExecContext(t.Context(), `INSERT INTO agents (id, project_id, handle, llm_provider, llm_model, llm_api_key_secret) VALUES ($1,$2,$3,'a','m','s')`, id, project, handle)
			return err
		}
		expectDup("project handle", agentIn(p1, "coder"), "uq_agents_project_handle")
		if err := agentIn(p2, "other"); err != nil {
			t.Errorf("a new handle in another project: %v", err)
		}
		expectDup("global handle", agentIn(nil, "helper"), "uq_agents_global_handle")
		if err := agentIn(p1, "helper"); err != nil {
			t.Errorf("the same handle in a project vs the workspace is fine: %v", err)
		}
	})

	t.Run("an extension row cannot point at an account of another kind", func(t *testing.T) {
		if _, err := db.ExecContext(t.Context(), `INSERT INTO users (id, username, password_hash) VALUES ($1,'zz','x')`, agentP1); err == nil {
			t.Error("a users row for an agent account was accepted")
		}
	})

	t.Run("deleting a project removes its agents' accounts", func(t *testing.T) {
		exec(`DELETE FROM projects WHERE id = $1`, p2)
		if n := count(`SELECT count(*) FROM accounts WHERE id = $1`, agentP2); n != 0 {
			t.Error("the project agent's account outlived its project")
		}
	})
}
