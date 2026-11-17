package postgres

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	automationdom "github.com/Paca-AI/api/internal/domain/automation"
)

func TestListAutomations_PagesNewestFirstAndAllReturnsEverything(t *testing.T) {
	f := newScopeFx(t)
	ctx := context.Background()
	repo := NewAutomationRepository(f.db)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var ids []uuid.UUID
	for i := 0; i < 5; i++ {
		id := uuid.New()
		ids = append(ids, id)
		status := "active"
		if i == 0 {
			status = "inactive"
		}
		pgExec(t, f.db, `INSERT INTO automations (id, project_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)`,
			id, f.p, fmt.Sprintf("auto %d", i), status, base.Add(time.Duration(i)*time.Minute))
	}

	var got []uuid.UUID
	var cursor *string
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("pagination did not terminate")
		}
		page, more, err := repo.ListAutomations(ctx, f.p, nil, nil, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range page {
			got = append(got, a.ID)
		}
		if !more {
			break
		}
		c := automationdom.EncodeAutomationCursor(page[len(page)-1])
		cursor = &c
	}
	want := []uuid.UUID{ids[4], ids[3], ids[2], ids[1], ids[0]}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("paged order\n got %v\nwant %v", got, want)
	}

	if page, more, err := repo.ListAutomations(ctx, f.p, nil, nil, nil, 0); err != nil || more || len(page) != 5 {
		t.Fatalf("default page size: %d automations more=%v err=%v", len(page), more, err)
	}
	active := automationdom.StatusActive
	if all, err := repo.ListAllAutomations(ctx, f.p, &active); err != nil || len(all) != 4 {
		t.Fatalf("active automations = %d, %v; want 4", len(all), err)
	}
	if all, err := repo.ListAllAutomations(ctx, f.p, nil); err != nil || len(all) != 5 {
		t.Fatalf("all automations = %d, %v; want 5", len(all), err)
	}
}
