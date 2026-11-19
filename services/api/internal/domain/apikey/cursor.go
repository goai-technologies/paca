package apikeydom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type listCursor struct {
	CreatedAt time.Time `json:"c"`
	ID        string    `json:"id"`
}

// KeyFilter shapes an API key list.
type KeyFilter struct {
	// Offset, when positive, skips that many keys instead of resuming from a
	// cursor — page-number paging for tables. The cursor is then ignored.
	Offset int
}

// EncodeCursor builds the opaque cursor that resumes a (created_at, id)
// ordered list after the row with the given values. The key list
// orders on that pair.
func EncodeCursor(createdAt time.Time, id uuid.UUID) string {
	b, _ := json.Marshal(listCursor{CreatedAt: createdAt.UTC(), ID: id.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeCursor returns the (created_at, id) position in a token produced by
// EncodeCursor; any failure wraps ErrInvalidCursor.
func DecodeCursor(s string) (time.Time, uuid.UUID, error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c listCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	id, err := uuid.Parse(c.ID)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c.CreatedAt.UTC(), id, nil
}
