package accountdom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

type serviceAccountCursor struct {
	Name string `json:"n"`
	ID   string `json:"id"`
}

// EncodeServiceAccountCursor builds the cursor for resuming the name-ordered
// service account list after a.
func EncodeServiceAccountCursor(a *Account) string {
	b, _ := json.Marshal(serviceAccountCursor{Name: strings.ToLower(a.Name), ID: a.ID.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeServiceAccountCursor returns the (lowercased name, id) position in a
// token produced by EncodeServiceAccountCursor; any failure wraps
// ErrInvalidCursor.
func DecodeServiceAccountCursor(s string) (name string, id uuid.UUID, err error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return "", uuid.Nil, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c serviceAccountCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return "", uuid.Nil, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	id, err = uuid.Parse(c.ID)
	if err != nil {
		return "", uuid.Nil, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c.Name, id, nil
}
