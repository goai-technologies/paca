package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	environmentdom "github.com/Paca-AI/api/internal/domain/environment"
)

func TestEnvironmentLists_PageFilterAndCount(t *testing.T) {
	f := newScopeFx(t)
	ctx := context.Background()
	repo := NewEnvironmentRepository(f.db)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	// ── Environments: newest first, searchable by name/slug, id lookup.
	var envIDs []uuid.UUID
	for i, n := range []string{"alpha", "bravo", "charlie", "delta", "echo"} {
		id := uuid.New()
		envIDs = append(envIDs, id)
		pgExec(t, f.db, `INSERT INTO environments (id, project_id, name, slug, backend, secret_key_encrypted, created_at, updated_at) VALUES ($1,$2,$3,$4,'docker','x',$5,$5)`,
			id, f.p, "Env "+n, "slug-"+n, base.Add(time.Duration(i)*time.Minute))
	}
	var got []string
	var cursor *string
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("environment pagination did not terminate")
		}
		page, more, err := repo.ListEnvironments(ctx, f.p, environmentdom.EnvironmentFilter{}, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range page {
			got = append(got, e.Name)
		}
		if !more {
			break
		}
		c := environmentdom.EncodeCursor(page[len(page)-1].CreatedAt, page[len(page)-1].ID)
		cursor = &c
	}
	if fmt.Sprint(got) != "[Env echo Env delta Env charlie Env bravo Env alpha]" {
		t.Fatalf("environments newest first = %v", got)
	}
	if found, _, err := repo.ListEnvironments(ctx, f.p, environmentdom.EnvironmentFilter{Search: " CHAR "}, nil, 10); err != nil || len(found) != 1 || found[0].ID != envIDs[2] {
		t.Fatalf("search = %v, %v", found, err)
	}
	if found, _, err := repo.ListEnvironments(ctx, f.p, environmentdom.EnvironmentFilter{IDs: []uuid.UUID{envIDs[0], uuid.New()}}, nil, 10); err != nil || len(found) != 1 || found[0].ID != envIDs[0] {
		t.Fatalf("ids = %v, %v", found, err)
	}
	bad := "nope"
	if _, _, err := repo.ListEnvironments(ctx, f.p, environmentdom.EnvironmentFilter{}, &bad, 2); !errors.Is(err, environmentdom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}

	// ── Folders / SSH keys / port forwards of one environment: oldest first
	// with a total, paged by a cursor.
	env := envIDs[0]
	other := envIDs[1]
	var folderIDs []uuid.UUID
	for i := 0; i < 5; i++ {
		id := uuid.New()
		folderIDs = append(folderIDs, id)
		pgExec(t, f.db, `INSERT INTO environment_folders (id, environment_id, path, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
			id, env, fmt.Sprintf("/work/repo-%d", i), base.Add(time.Duration(i)*time.Minute))
		pgExec(t, f.db, `INSERT INTO environment_ssh_keys (id, environment_id, label, public_key, fingerprint, created_at) VALUES ($1,$2,$3,'ssh-ed25519 AAA',$4,$5)`,
			uuid.New(), env, fmt.Sprintf("key %d", i), fmt.Sprintf("SHA256:%d", i), base.Add(time.Duration(i)*time.Minute))
		pgExec(t, f.db, `INSERT INTO environment_port_forwards (id, environment_id, label, container_port, created_at) VALUES ($1,$2,$3,$4,$5)`,
			uuid.New(), env, fmt.Sprintf("pf %d", i), 3000+i, base.Add(time.Duration(i)*time.Minute))
	}
	// A row on another environment must never leak in or count.
	pgExec(t, f.db, `INSERT INTO environment_folders (id, environment_id, path) VALUES ($1,$2,'/other')`, uuid.New(), other)

	var paths []string
	cursor = nil
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("folder pagination did not terminate")
		}
		page, more, total, err := repo.ListFolders(ctx, env, environmentdom.FolderFilter{}, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		// total_count is a first-page field; later pages skip the COUNT.
		if want := int64(5); (cursor == nil && total != want) || (cursor != nil && total != 0) {
			t.Fatalf("folder total = %d (cursor set: %v)", total, cursor != nil)
		}
		for _, fo := range page {
			paths = append(paths, fo.Path)
		}
		if !more {
			break
		}
		c := environmentdom.EncodeCursor(page[len(page)-1].CreatedAt, page[len(page)-1].ID)
		cursor = &c
	}
	if fmt.Sprint(paths) != "[/work/repo-0 /work/repo-1 /work/repo-2 /work/repo-3 /work/repo-4]" {
		t.Fatalf("folders oldest first = %v", paths)
	}
	if found, _, total, err := repo.ListFolders(ctx, env, environmentdom.FolderFilter{Search: "REPO-3"}, nil, 10); err != nil || len(found) != 1 || total != 1 {
		t.Fatalf("folder search = %d/%d, %v", len(found), total, err)
	}
	if found, _, _, err := repo.ListFolders(ctx, env, environmentdom.FolderFilter{IDs: []uuid.UUID{folderIDs[4]}}, nil, 10); err != nil || len(found) != 1 || found[0].ID != folderIDs[4] {
		t.Fatalf("folder ids = %v, %v", found, err)
	}

	keys, more, total, err := repo.ListSSHKeys(ctx, env, nil, 3)
	if err != nil || len(keys) != 3 || !more || total != 5 || keys[0].Label != "key 0" {
		t.Fatalf("ssh keys page 1 = %d more=%v total=%d err=%v", len(keys), more, total, err)
	}
	c := environmentdom.EncodeCursor(keys[2].CreatedAt, keys[2].ID)
	keys, more, _, err = repo.ListSSHKeys(ctx, env, &c, 3)
	if err != nil || len(keys) != 2 || more || keys[0].Label != "key 3" {
		t.Fatalf("ssh keys page 2 = %d more=%v err=%v", len(keys), more, err)
	}

	forwards, more, total, err := repo.ListPortForwards(ctx, env, nil, 4)
	if err != nil || len(forwards) != 4 || !more || total != 5 {
		t.Fatalf("port forwards page 1 = %d more=%v total=%d err=%v", len(forwards), more, total, err)
	}
	c = environmentdom.EncodeCursor(forwards[3].CreatedAt, forwards[3].ID)
	forwards, more, _, err = repo.ListPortForwards(ctx, env, &c, 4)
	if err != nil || len(forwards) != 1 || more || forwards[0].Label != "pf 4" {
		t.Fatalf("port forwards page 2 = %d more=%v err=%v", len(forwards), more, err)
	}
	if _, _, _, err := repo.ListPortForwards(ctx, env, &bad, 4); !errors.Is(err, environmentdom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
}
