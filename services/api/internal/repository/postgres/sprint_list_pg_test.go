package postgres

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	sprintdom "github.com/Paca-AI/api/internal/domain/sprint"
)

func TestSprintRepository_ListSprints_PagesFiltersAndSorts(t *testing.T) {
	db := newIAMPGTestDB(t)
	fx := newIAMFx(t, db)
	repo := NewSprintRepository(db)
	project := fx.project()
	otherProject := fx.project()
	base := time.Now().UTC().Add(-time.Hour)

	mk := func(projectID uuid.UUID, name string, status sprintdom.SprintStatus, updated time.Duration) uuid.UUID {
		sp := &sprintdom.Sprint{ID: uuid.New(), ProjectID: projectID, Name: name, Status: status, CreatedAt: base, UpdatedAt: base.Add(updated)}
		if err := repo.CreateSprint(t.Context(), sp); err != nil {
			t.Fatal(err)
		}
		return sp.ID
	}
	// Names sort case-insensitively: alpha, Bravo, charlie, delta, echo.
	alpha := mk(project, "alpha", sprintdom.SprintStatusActive, 1*time.Minute)
	bravo := mk(project, "Bravo", sprintdom.SprintStatusPlanned, 5*time.Minute)
	charlie := mk(project, "charlie", sprintdom.SprintStatusCompleted, 3*time.Minute)
	delta := mk(project, "delta", sprintdom.SprintStatusCompleted, 4*time.Minute)
	echo := mk(project, "echo", sprintdom.SprintStatusPlanned, 2*time.Minute)
	mk(otherProject, "alpha-other", sprintdom.SprintStatusActive, 0)

	page := func(f sprintdom.SprintFilter, limit int) (ids []uuid.UUID, total int) {
		var cursor *string
		for range 10 {
			got, hasMore, tot, err := repo.ListSprints(t.Context(), project, f, cursor, limit)
			if err != nil {
				t.Fatal(err)
			}
			total = tot
			for _, sp := range got {
				ids = append(ids, sp.ID)
			}
			if !hasMore {
				return ids, total
			}
			c := sprintdom.EncodeCursor(got[len(got)-1])
			cursor = &c
		}
		t.Fatal("did not terminate")
		return
	}
	same := func(label string, got, want []uuid.UUID) {
		t.Helper()
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatalf("%s = %v, want %v", label, got, want)
		}
	}

	got, total := page(sprintdom.SprintFilter{}, 2)
	same("by name", got, []uuid.UUID{alpha, bravo, charlie, delta, echo})
	if total != 5 {
		t.Fatalf("total = %d, want 5", total)
	}
	got, total = page(sprintdom.SprintFilter{Statuses: []sprintdom.SprintStatus{sprintdom.SprintStatusCompleted}, Sort: sprintdom.SprintSortRecent}, 1)
	same("completed recent", got, []uuid.UUID{delta, charlie})
	if total != 2 {
		t.Fatalf("completed total = %d, want 2", total)
	}
	got, _ = page(sprintdom.SprintFilter{Statuses: []sprintdom.SprintStatus{sprintdom.SprintStatusActive, sprintdom.SprintStatusPlanned}}, 10)
	same("active+planned", got, []uuid.UUID{alpha, bravo, echo})
	got, _ = page(sprintdom.SprintFilter{Search: "RAV"}, 10)
	same("search", got, []uuid.UUID{bravo})
	got, _ = page(sprintdom.SprintFilter{IDs: []uuid.UUID{echo, alpha}}, 10)
	same("ids", got, []uuid.UUID{alpha, echo})

	bad := "!!"
	if _, _, _, err := repo.ListSprints(t.Context(), project, sprintdom.SprintFilter{}, &bad, 5); !errors.Is(err, sprintdom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
	if all, err := repo.ListAllSprints(t.Context(), project); err != nil || len(all) != 5 {
		t.Fatalf("ListAllSprints = %d err=%v", len(all), err)
	}
}
