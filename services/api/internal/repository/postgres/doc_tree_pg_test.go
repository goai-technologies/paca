package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"

	docdom "github.com/Paca-AI/api/internal/domain/doc"
)

func TestDocTree_PagesLevelsInManualOrderWithoutBodies(t *testing.T) {
	f := newScopeFx(t)
	ctx := context.Background()
	repo := NewDocumentRepository(f.db)

	// Root: 5 folders and 5 documents. Positions are deliberately not in
	// name order so the test fails if pages follow the title instead.
	var rootFolders []uuid.UUID
	for i := 0; i < 5; i++ {
		id := uuid.New()
		rootFolders = append(rootFolders, id)
		pgExec(t, f.db, `INSERT INTO doc_folders (id, project_id, name, position) VALUES ($1,$2,$3,$4)`, id, f.p, fmt.Sprintf("f%d", 4-i), i)
	}
	var rootDocs []uuid.UUID
	for i := 0; i < 5; i++ {
		id := uuid.New()
		rootDocs = append(rootDocs, id)
		pgExec(t, f.db, `INSERT INTO documents (id, project_id, title, position, content) VALUES ($1,$2,$3,$4,'[{"type":"paragraph"}]'::jsonb)`, id, f.p, fmt.Sprintf("d%d", 4-i), i)
	}
	// Same position -> falls back to title then id.
	tie1, tie2 := uuid.New(), uuid.New()
	pgExec(t, f.db, `INSERT INTO documents (id, project_id, title, position) VALUES ($1,$3,'b',99), ($2,$3,'a',99)`, tie1, tie2, f.p)
	// Nested: a child folder and a doc inside the first root folder.
	child, nested := uuid.New(), uuid.New()
	pgExec(t, f.db, `INSERT INTO doc_folders (id, project_id, parent_id, name) VALUES ($1,$2,$3,'child')`, child, f.p, rootFolders[0])
	pgExec(t, f.db, `INSERT INTO documents (id, project_id, folder_id, title) VALUES ($1,$2,$3,'nested')`, nested, f.p, rootFolders[0])

	collectDocs := func(parent *uuid.UUID, size int) []uuid.UUID {
		var out []uuid.UUID
		var cur *string
		for i := 0; i < 20; i++ {
			docs, more, err := repo.ListDocuments(ctx, f.p, docFilterFor(parent), cur, size)
			if err != nil {
				t.Fatal(err)
			}
			for _, d := range docs {
				out = append(out, d.ID)
				if len(d.Content) > 0 {
					t.Fatalf("tree listing loaded a body for %s", d.ID)
				}
			}
			if !more {
				return out
			}
			c := docdom.EncodeDocumentTreeCursor(docs[len(docs)-1])
			cur = &c
		}
		t.Fatal("pagination did not terminate")
		return nil
	}

	got := collectDocs(nil, 2)
	want := append(append([]uuid.UUID{}, rootDocs...), tie2, tie1) // position order, then title a < b
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("root docs\n got %v\nwant %v", got, want)
	}
	if got := collectDocs(&rootFolders[0], 1); len(got) != 1 || got[0] != nested {
		t.Fatalf("nested docs = %v, want only %v", got, nested)
	}

	var gotFolders []uuid.UUID
	var cur *string
	for i := 0; i < 20; i++ {
		fs, more, err := repo.ListFolders(ctx, f.p, nil, docdom.FolderFilter{}, cur, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, fo := range fs {
			gotFolders = append(gotFolders, fo.ID)
		}
		if !more {
			break
		}
		c := docdom.EncodeFolderTreeCursor(fs[len(fs)-1])
		cur = &c
	}
	if fmt.Sprint(gotFolders) != fmt.Sprint(rootFolders) {
		t.Fatalf("root folders\n got %v\nwant %v", gotFolders, rootFolders)
	}
	kids, more, err := repo.ListFolders(ctx, f.p, &rootFolders[0], docdom.FolderFilter{}, nil, 10)
	if err != nil || more || len(kids) != 1 || kids[0].ID != child {
		t.Fatalf("child folders = %v, %v, %v", kids, more, err)
	}

	// Search narrows within the tree order; no folder filter spans folders.
	if found, _, err := repo.ListDocuments(ctx, f.p, docdom.DocumentFilter{Search: "NEST"}, nil, 10); err != nil || len(found) != 1 || found[0].ID != nested {
		t.Fatalf("search = %v, %v; want only the nested doc", found, err)
	}
	if all, _, err := repo.ListDocuments(ctx, f.p, docdom.DocumentFilter{}, nil, 100); err != nil || len(all) != len(rootDocs)+2+1 {
		t.Fatalf("project-wide listing = %d docs, %v", len(all), err)
	}
	bad := "not-a-cursor"
	if _, _, err := repo.ListDocuments(ctx, f.p, docdom.DocumentFilter{RootOnly: true}, &bad, 5); !errors.Is(err, docdom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
}

func TestFolderPath_RootFirstAndProjectScoped(t *testing.T) {
	f := newScopeFx(t)
	ctx := context.Background()
	repo := NewDocumentRepository(f.db)
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	pgExec(t, f.db, `INSERT INTO doc_folders (id, project_id, name) VALUES ($1,$2,'A')`, a, f.p)
	pgExec(t, f.db, `INSERT INTO doc_folders (id, project_id, parent_id, name) VALUES ($1,$2,$3,'B')`, b, f.p, a)
	pgExec(t, f.db, `INSERT INTO doc_folders (id, project_id, parent_id, name) VALUES ($1,$2,$3,'C')`, c, f.p, b)

	path, err := repo.FolderPath(ctx, f.p, c)
	if err != nil || len(path) != 3 || path[0].ID != a || path[1].ID != b || path[2].ID != c {
		t.Fatalf("path = %v, %v; want A > B > C", path, err)
	}
	if _, err := repo.FolderPath(ctx, uuid.New(), c); !errors.Is(err, docdom.ErrFolderNotFound) {
		t.Fatalf("other project err = %v, want ErrFolderNotFound", err)
	}
}

// docFilterFor lists the documents directly inside parent, or the ones outside
// any folder when parent is nil.
func docFilterFor(parent *uuid.UUID) docdom.DocumentFilter {
	if parent == nil {
		return docdom.DocumentFilter{RootOnly: true}
	}
	return docdom.DocumentFilter{FolderID: parent}
}
