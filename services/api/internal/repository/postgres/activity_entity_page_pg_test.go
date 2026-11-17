package postgres

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	activitydom "github.com/Paca-AI/api/internal/domain/activity"
)

func TestActivityListForEntity_NewestFirstKeysetPaging(t *testing.T) {
	f := newScopeFx(t)
	ctx := context.Background()
	repo := NewActivityRepository(f.db)
	entity, other := uuid.New(), uuid.New()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var ids []uuid.UUID
	// Two entries share a timestamp, so the id tiebreak is exercised too.
	for i, at := range []time.Duration{0, time.Minute, time.Minute, 2 * time.Minute, 3 * time.Minute} {
		a := &activitydom.Activity{
			ID: uuid.New(), ProjectID: f.p, EntityType: "task", EntityID: &entity,
			ActivityType: "task.updated", Content: json.RawMessage(`{}`), CreatedAt: base.Add(at),
		}
		if err := repo.Create(ctx, a); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		ids = append(ids, a.ID)
	}
	if err := repo.Create(ctx, &activitydom.Activity{ID: uuid.New(), ProjectID: f.p, EntityType: "task", EntityID: &other, ActivityType: "task.updated", Content: json.RawMessage(`{}`), CreatedAt: base}); err != nil {
		t.Fatal(err)
	}

	seen := map[uuid.UUID]bool{}
	var times []time.Time
	var cursor *activitydom.Cursor
	for pages := 0; ; pages++ {
		if pages > 6 {
			t.Fatal("pagination did not terminate")
		}
		items, more, err := repo.ListForEntity(ctx, "task", entity, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range items {
			if seen[a.ID] {
				t.Fatalf("entry %s returned twice", a.ID)
			}
			seen[a.ID] = true
			times = append(times, a.CreatedAt)
		}
		if !more {
			break
		}
		last := items[len(items)-1]
		cursor = &activitydom.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	if len(seen) != len(ids) {
		t.Fatalf("saw %d entries, want %d", len(seen), len(ids))
	}
	for i := 1; i < len(times); i++ {
		if times[i].After(times[i-1]) {
			t.Fatalf("not newest first: %v", times)
		}
	}
}
