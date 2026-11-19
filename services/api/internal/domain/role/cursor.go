package roledom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// RoleFilter narrows a role list. All set fields must match.
type RoleFilter struct {
	// Search keeps roles whose name or description contains every
	// whitespace-separated word.
	Search string
	// IDs keeps only these roles (a batch lookup).
	IDs []uuid.UUID
	// Offset, when positive, skips that many roles instead of resuming from a
	// cursor — page-number paging for tables. The cursor is then ignored.
	Offset int
}

type roleCursor struct {
	// Shared is 1 for a platform role in a project listing (those follow the
	// project's own roles), 0 otherwise.
	Shared int    `json:"s"`
	Name   string `json:"n"`
	ID     string `json:"id"`
}

// EncodeCursor builds the cursor that resumes the (own-before-shared,
// LOWER(name), id) ordering after r.
func EncodeCursor(r *Role) string {
	shared := 0
	if r.ProjectID == nil {
		shared = 1
	}
	b, _ := json.Marshal(roleCursor{Shared: shared, Name: r.Name, ID: r.ID.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeCursor returns the (shared, name, id) position in a token
// produced by EncodeCursor; any failure wraps ErrInvalidCursor.
func DecodeCursor(s string) (shared int, name string, id uuid.UUID, err error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return 0, "", uuid.Nil, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c roleCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return 0, "", uuid.Nil, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	id, err = uuid.Parse(c.ID)
	if err != nil {
		return 0, "", uuid.Nil, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c.Shared, c.Name, id, nil
}
