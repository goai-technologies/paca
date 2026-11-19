package taskdom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type linkCursor struct {
	CreatedAt time.Time `json:"c"`
	ID        string    `json:"id"`
}

// EncodeLinkCursor builds the opaque cursor that resumes a task's link list
// (ordered by created_at, id ascending) after l.
func EncodeLinkCursor(l *TaskLink) string {
	b, _ := json.Marshal(linkCursor{CreatedAt: l.CreatedAt.UTC(), ID: l.ID.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeLinkCursor returns the (created_at, id) position in a token produced
// by EncodeLinkCursor; any failure wraps ErrInvalidCursor.
func DecodeLinkCursor(s string) (time.Time, uuid.UUID, error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c linkCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	id, err := uuid.Parse(c.ID)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c.CreatedAt.UTC(), id, nil
}
