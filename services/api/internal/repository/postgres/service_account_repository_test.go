package postgres

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
	apikeydom "github.com/Paca-AI/api/internal/domain/apikey"
)

func TestServiceAccountRepository_Lifecycle(t *testing.T) {
	db := newIAMPGTestDB(t)
	fx := newIAMFx(t, db)
	repo := NewServiceAccountRepository(db)
	keys := NewAPIKeyRepository(db)
	creator := fx.user(false)
	now := time.Now().UTC()

	sa := &accountdom.Account{ID: uuid.New(), Name: "CI bot", Description: "deploys", CreatedBy: &creator, CreatedAt: now, UpdatedAt: now}
	if err := repo.Create(t.Context(), sa); err != nil {
		t.Fatal(err)
	}
	got, err := repo.FindByID(t.Context(), sa.ID)
	if err != nil || got.Kind != accountdom.KindServiceAccount || got.Name != "CI bot" || got.Description != "deploys" ||
		got.CreatedBy == nil || *got.CreatedBy != creator {
		t.Fatalf("find = %+v err=%v", got, err)
	}

	// Users and agents are accounts too but are not service accounts.
	if _, err := repo.FindByID(t.Context(), creator); !errors.Is(err, accountdom.ErrServiceAccountNotFound) {
		t.Fatalf("a user must not resolve as a service account: %v", err)
	}
	list, _, _, err := repo.List(t.Context(), accountdom.ServiceAccountFilter{}, nil, 50)
	if err != nil || len(list) != 1 || list[0].ID != sa.ID {
		t.Fatalf("list = %+v err=%v", list, err)
	}

	// Reads carry the account's workspace roles (sorted by name); project-scoped
	// attachments are not part of them.
	roleB := fx.role(`{"version":"2026-10-01","statements":[]}`)
	roleA := fx.role(`{"version":"2026-10-01","statements":[]}`)
	pgExec(t, db, `UPDATE roles SET name = 'b-role' WHERE id = $1`, roleB)
	pgExec(t, db, `UPDATE roles SET name = 'a-role' WHERE id = $1`, roleA)
	fx.attach(roleB, sa.ID, nil)
	fx.attach(roleA, sa.ID, nil)
	scoped := fx.project()
	fx.attach(fx.role(`{"version":"2026-10-01","statements":[]}`), sa.ID, &scoped)
	withRoles, _, _, err := repo.List(t.Context(), accountdom.ServiceAccountFilter{}, nil, 50)
	if err != nil || len(withRoles) != 1 || len(withRoles[0].Roles) != 2 ||
		withRoles[0].Roles[0].Name != "a-role" || withRoles[0].Roles[1].Name != "b-role" {
		t.Fatalf("list roles = %+v err=%v", withRoles, err)
	}
	if one, err := repo.FindByID(t.Context(), sa.ID); err != nil || len(one.Roles) != 2 {
		t.Fatalf("find roles = %+v err=%v", one, err)
	}

	got.Name, got.Description = "Release bot", ""
	got.UpdatedAt = time.Now().UTC()
	if err := repo.Update(t.Context(), got); err != nil {
		t.Fatal(err)
	}
	if again, _ := repo.FindByID(t.Context(), sa.ID); again.Name != "Release bot" || again.Description != "" {
		t.Fatalf("update not saved: %+v", again)
	}

	// Its key authenticates it, with its kind; it holds a role and a membership.
	key := &apikeydom.APIKey{ID: uuid.New(), AccountID: sa.ID, CreatedBy: &creator, Name: "ci", KeyPrefix: "abcd1234", CreatedAt: now}
	if err := keys.Create(t.Context(), key, "hash-sa"); err != nil {
		t.Fatal(err)
	}
	found, err := keys.FindByHash(t.Context(), "hash-sa")
	if err != nil || found.AccountID != sa.ID || found.AccountKind != accountdom.KindServiceAccount {
		t.Fatalf("key lookup = %+v err=%v", found, err)
	}
	project := fx.project()
	fx.member(project, sa.ID, false)
	fx.attach(fx.role(`{"version":"2026-10-01","statements":[]}`), sa.ID, nil)

	if err := repo.Delete(t.Context(), sa.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.FindByID(t.Context(), sa.ID); !errors.Is(err, accountdom.ErrServiceAccountNotFound) {
		t.Fatalf("deleted account still found: %v", err)
	}
	if _, err := keys.FindByHash(t.Context(), "hash-sa"); !errors.Is(err, apikeydom.ErrNotFound) {
		t.Fatalf("a deleted account's key must stop resolving: %v", err)
	}
	var n int
	if err := db.Get(&n, `SELECT count(*) FROM role_attachments WHERE account_id = $1`, sa.ID); err != nil || n != 0 {
		t.Fatalf("attachments left: %d %v", n, err)
	}
	if err := db.Get(&n, `SELECT count(*) FROM project_members WHERE account_id = $1 AND deleted_at IS NULL`, sa.ID); err != nil || n != 0 {
		t.Fatalf("memberships left: %d %v", n, err)
	}
	if err := repo.Delete(t.Context(), sa.ID); !errors.Is(err, accountdom.ErrServiceAccountNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestServiceAccountList_PagesByNameAndSearches(t *testing.T) {
	db := newIAMPGTestDB(t)
	repo := NewServiceAccountRepository(db)
	ctx := t.Context()
	now := time.Now().UTC()
	// Names chosen so name order differs from creation order and one is
	// reachable only through its description.
	for i, n := range []struct{ name, desc string }{{"delta", ""}, {"Alpha", "ci"}, {"charlie", "deploy tool"}, {"bravo", ""}, {"echo", "has CHARLIE inside"}} {
		a := &accountdom.Account{ID: uuid.New(), Name: n.name, Description: n.desc, CreatedAt: now.Add(time.Duration(i) * time.Second), UpdatedAt: now}
		if err := repo.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
	}

	var names []string
	var cursor *string
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("pagination did not terminate")
		}
		page, more, _, err := repo.List(ctx, accountdom.ServiceAccountFilter{}, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range page {
			names = append(names, a.Name)
		}
		if !more {
			break
		}
		c := accountdom.EncodeServiceAccountCursor(page[len(page)-1])
		cursor = &c
	}
	if fmt.Sprint(names) != "[Alpha bravo charlie delta echo]" {
		t.Fatalf("name order = %v", names)
	}

	found, more, _, err := repo.List(ctx, accountdom.ServiceAccountFilter{Search: " CHARLIE "}, nil, 10)
	if err != nil || more || len(found) != 2 {
		t.Fatalf("search = %d accounts more=%v err=%v; want charlie and echo (via description)", len(found), more, err)
	}
	bad := "nope"
	if _, _, _, err := repo.List(ctx, accountdom.ServiceAccountFilter{}, &bad, 2); !errors.Is(err, accountdom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
}

func TestAPIKeyRepository_ListByAccountID_Paginates(t *testing.T) {
	db := newIAMPGTestDB(t)
	fx := newIAMFx(t, db)
	keys := NewAPIKeyRepository(db)
	owner := fx.user(false)
	other := fx.user(false)
	base := time.Now().UTC().Add(-time.Hour)

	var want []uuid.UUID // newest first
	for i := 0; i < 5; i++ {
		k := &apikeydom.APIKey{ID: uuid.New(), AccountID: owner, Name: fmt.Sprintf("k%d", i), KeyPrefix: "pk_x", CreatedAt: base.Add(time.Duration(i) * time.Minute)}
		if err := keys.Create(t.Context(), k, fmt.Sprintf("hash-%d", i)); err != nil {
			t.Fatal(err)
		}
		want = append([]uuid.UUID{k.ID}, want...)
	}
	if err := keys.Create(t.Context(), &apikeydom.APIKey{ID: uuid.New(), AccountID: other, Name: "x", KeyPrefix: "pk_x", CreatedAt: base}, "hash-other"); err != nil {
		t.Fatal(err)
	}
	if err := keys.Revoke(t.Context(), want[0]); err != nil {
		t.Fatal(err)
	}
	want = want[1:]

	var got []uuid.UUID
	var cursor *string
	for pages := 0; pages < 10; pages++ {
		page, hasMore, total, err := keys.ListByAccountID(t.Context(), owner, apikeydom.KeyFilter{}, cursor, 3)
		if err != nil {
			t.Fatal(err)
		}
		if (cursor == nil && total != 4) || (cursor != nil && total != 0) {
			t.Fatalf("total = %d (cursor set: %v), want 4 on the first page only", total, cursor != nil)
		}
		for _, k := range page {
			got = append(got, k.ID)
		}
		if !hasMore {
			break
		}
		c := apikeydom.EncodeCursor(page[len(page)-1].CreatedAt, page[len(page)-1].ID)
		cursor = &c
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("paged keys = %v, want %v", got, want)
	}

	bad := "!!"
	if _, _, _, err := keys.ListByAccountID(t.Context(), owner, apikeydom.KeyFilter{}, &bad, 3); !errors.Is(err, apikeydom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
}

func TestServiceAccountAndAPIKeyRepositories_ListByPageNumber(t *testing.T) {
	db := newIAMPGTestDB(t)
	fx := newIAMFx(t, db)
	accounts := NewServiceAccountRepository(db)
	keys := NewAPIKeyRepository(db)
	owner := fx.user(false)
	now := time.Now().UTC()

	for i := 0; i < 5; i++ {
		sa := &accountdom.Account{ID: uuid.New(), Name: fmt.Sprintf("bot-%d", i), CreatedBy: &owner, CreatedAt: now, UpdatedAt: now}
		if err := accounts.Create(t.Context(), sa); err != nil {
			t.Fatal(err)
		}
		k := &apikeydom.APIKey{ID: uuid.New(), AccountID: owner, Name: fmt.Sprintf("k%d", i), KeyPrefix: "pk_x", CreatedAt: now.Add(time.Duration(i) * time.Minute)}
		if err := keys.Create(t.Context(), k, fmt.Sprintf("hash-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	bad := "!!"
	all, _, total, err := accounts.List(t.Context(), accountdom.ServiceAccountFilter{}, nil, 100)
	if err != nil || total != 5 || len(all) != 5 {
		t.Fatalf("accounts all = %d total=%d err=%v", len(all), total, err)
	}
	page, more, total, err := accounts.List(t.Context(), accountdom.ServiceAccountFilter{Offset: 2}, &bad, 2)
	if err != nil || !more || total != 5 || len(page) != 2 || page[0].ID != all[2].ID || page[1].ID != all[3].ID {
		t.Fatalf("accounts page 2 = %v more=%v total=%d err=%v", page, more, total, err)
	}

	allKeys, _, _, err := keys.ListByAccountID(t.Context(), owner, apikeydom.KeyFilter{}, nil, 100)
	if err != nil || len(allKeys) != 5 {
		t.Fatalf("keys all = %d err=%v", len(allKeys), err)
	}
	kp, more, total, err := keys.ListByAccountID(t.Context(), owner, apikeydom.KeyFilter{Offset: 4}, &bad, 2)
	if err != nil || more || total != 5 || len(kp) != 1 || kp[0].ID != allKeys[4].ID {
		t.Fatalf("keys page 3 = %v more=%v total=%d err=%v", kp, more, total, err)
	}
}
