package postgres

import (
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestProjectExportRepository_ListByProject_Pages(t *testing.T) {
	db := newIAMPGTestDB(t)
	fx := newIAMFx(t, db)
	repo := NewProjectExportRepository(db)
	project := fx.project()
	other := fx.project()
	base := time.Now().UTC().Add(-time.Hour)

	var ids []uuid.UUID // newest first
	for i := 0; i < 5; i++ {
		id := uuid.New()
		pgExec(t, db, `INSERT INTO project_exports (id, project_id, status, created_at) VALUES ($1, $2, 'completed', $3)`,
			id, project, base.Add(time.Duration(i)*time.Minute))
		ids = append([]uuid.UUID{id}, ids...)
	}
	pgExec(t, db, `INSERT INTO project_exports (id, project_id, status) VALUES ($1, $2, 'completed')`, uuid.New(), other)

	page2, total, err := repo.ListByProject(t.Context(), project, 2, 2)
	if err != nil || total != 5 || len(page2) != 2 || page2[0].ID != ids[2] || page2[1].ID != ids[3] {
		t.Fatalf("page 2 = %v total=%d err=%v", page2, total, err)
	}
	last, total, err := repo.ListByProject(t.Context(), project, 4, 2)
	if err != nil || total != 5 || len(last) != 1 || fmt.Sprint(last[0].ID) != fmt.Sprint(ids[4]) {
		t.Fatalf("last page = %v total=%d err=%v", last, total, err)
	}
	past, total, err := repo.ListByProject(t.Context(), project, 10, 2)
	if err != nil || total != 5 || len(past) != 0 {
		t.Fatalf("past the end = %v total=%d err=%v", past, total, err)
	}
}
