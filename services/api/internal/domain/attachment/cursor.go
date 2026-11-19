package attachmentdom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type attachmentCursor struct {
	CreatedAt time.Time `json:"c"`
	ID        string    `json:"id"`
}

// EncodeCursor builds the opaque cursor that resumes a task's attachment list
// (ordered by created_at, id ascending) after a.
func EncodeCursor(a *TaskAttachment) string {
	b, _ := json.Marshal(attachmentCursor{CreatedAt: a.CreatedAt.UTC(), ID: a.ID.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeCursor returns the (created_at, id) position in a token produced by
// EncodeCursor; any failure wraps ErrInvalidCursor.
func DecodeCursor(s string) (time.Time, uuid.UUID, error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c attachmentCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	id, err := uuid.Parse(c.ID)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c.CreatedAt.UTC(), id, nil
}
