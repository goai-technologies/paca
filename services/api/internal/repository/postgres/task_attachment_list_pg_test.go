package postgres

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	attachmentdom "github.com/Paca-AI/api/internal/domain/attachment"
)

func TestAttachmentRepository_ListTaskAttachments_Pages(t *testing.T) {
	db := newIAMPGTestDB(t)
	fx := newIAMFx(t, db)
	repo := NewAttachmentRepository(db)
	project := fx.project()
	base := time.Now().UTC().Add(-time.Hour)

	task := uuid.New()
	otherTask := uuid.New()
	pgExec(t, db, `INSERT INTO tasks (id, project_id, task_number, title) VALUES ($1,$2,1,'a'), ($3,$2,2,'b')`, task, project, otherTask)
	add := func(taskID uuid.UUID, i int, at time.Time) uuid.UUID {
		file, att := uuid.New(), uuid.New()
		pgExec(t, db, `INSERT INTO files (id, storage_key, bucket, file_name, upload_status) VALUES ($1,$2,'b',$3,'uploaded')`,
			file, fmt.Sprintf("k-%s", file), fmt.Sprintf("f%d.txt", i))
		pgExec(t, db, `INSERT INTO task_attachments (id, task_id, file_id, created_at) VALUES ($1,$2,$3,$4)`, att, taskID, file, at)
		return att
	}
	var want []uuid.UUID // oldest first
	for i := 0; i < 5; i++ {
		want = append(want, add(task, i, base.Add(time.Duration(i)*time.Minute)))
	}
	add(otherTask, 9, base)

	var got []uuid.UUID
	var cursor *string
	for range 10 {
		page, hasMore, total, err := repo.ListTaskAttachments(t.Context(), task, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		if total != 5 {
			t.Fatalf("total = %d, want 5", total)
		}
		for _, a := range page {
			got = append(got, a.ID)
			if a.File == nil || a.File.FileName == "" {
				t.Fatalf("attachment must carry its file: %+v", a)
			}
		}
		if !hasMore {
			break
		}
		c := attachmentdom.EncodeCursor(page[len(page)-1])
		cursor = &c
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("paged attachments = %v, want %v", got, want)
	}
	bad := "!!"
	if _, _, _, err := repo.ListTaskAttachments(t.Context(), task, &bad, 2); !errors.Is(err, attachmentdom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
}
