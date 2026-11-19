package sprintdom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// SprintSort picks the order of the sprint list.
type SprintSort string

const (
	// SprintSortName orders by (LOWER(name), id) ascending — the default.
	SprintSortName SprintSort = "name"
	// SprintSortRecent orders by (updated_at, id) descending, so the most
	// recently touched sprint (e.g. the last completed) comes first. Editing a
	// sprint moves it, so a walk in progress may skip or repeat that sprint.
	SprintSortRecent SprintSort = "recent"
)

// ValidSprintSorts is the set of accepted sort values.
var ValidSprintSorts = map[SprintSort]bool{SprintSortName: true, SprintSortRecent: true}

// SprintFilter narrows a sprint list. All set fields must match.
type SprintFilter struct {
	// Search keeps sprints whose name contains every whitespace-separated word.
	Search string
	// Statuses keeps sprints in any of these statuses; empty keeps all.
	Statuses []SprintStatus
	// IDs keeps only these sprints (a batch lookup).
	IDs []uuid.UUID
	// Sort is the list order; empty means SprintSortName.
	Sort SprintSort
}

type sprintCursor struct {
	Name      string    `json:"n"`
	UpdatedAt time.Time `json:"u"`
	ID        string    `json:"id"`
}

// EncodeCursor builds the cursor that resumes either sprint ordering after s.
func EncodeCursor(s *Sprint) string {
	b, _ := json.Marshal(sprintCursor{Name: s.Name, UpdatedAt: s.UpdatedAt.UTC(), ID: s.ID.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeCursor returns the (name, updated_at, id) position in a
// token produced by EncodeCursor; any failure wraps ErrInvalidCursor.
func DecodeCursor(s string) (name string, updatedAt time.Time, id uuid.UUID, err error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return "", time.Time{}, uuid.Nil, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c sprintCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return "", time.Time{}, uuid.Nil, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	id, err = uuid.Parse(c.ID)
	if err != nil {
		return "", time.Time{}, uuid.Nil, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c.Name, c.UpdatedAt.UTC(), id, nil
}
