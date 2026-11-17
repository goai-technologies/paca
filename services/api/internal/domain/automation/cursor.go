package automationdom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// AutomationCursor holds the stable ordering fields for keyset-based
// pagination over a searchable/paginated automation listing (see
// Repository.ListAutomations), ordered by created_at DESC, id DESC.
type AutomationCursor struct {
	CreatedAt time.Time `json:"ca"`
	ID        string    `json:"id"`
}

// EncodeAutomationCursor builds an opaque base64 cursor from the last
// automation on a page.
func EncodeAutomationCursor(a *Automation) string {
	cur := AutomationCursor{CreatedAt: a.CreatedAt.UTC(), ID: a.ID.String()}
	b, _ := json.Marshal(cur)
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeAutomationCursor parses a cursor token produced by
// EncodeAutomationCursor. A malformed token returns ok=false rather than an
// error — see docdom.DecodeDocumentCursor's doc comment for why this is
// permissive rather than a hard failure.
func DecodeAutomationCursor(s string) (cur AutomationCursor, ok bool) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return AutomationCursor{}, false
	}
	if err := json.Unmarshal(b, &cur); err != nil {
		return AutomationCursor{}, false
	}
	cur.CreatedAt = cur.CreatedAt.UTC()
	return cur, true
}

// RunCursor identifies the last run on a page of an automation's run history,
// ordered started_at DESC, id DESC.
type RunCursor struct {
	StartedAt time.Time `json:"sa"`
	ID        string    `json:"id"`
}

// EncodeRunCursor builds an opaque base64 cursor from the last run on a page.
func EncodeRunCursor(r *Run) string {
	b, _ := json.Marshal(RunCursor{StartedAt: r.StartedAt.UTC(), ID: r.ID.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeRunCursor parses a token produced by EncodeRunCursor; any failure
// wraps ErrInvalidCursor.
func DecodeRunCursor(s string) (RunCursor, error) {
	var c RunCursor
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return c, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	if err := json.Unmarshal(b, &c); err != nil || c.ID == "" {
		return c, fmt.Errorf("%w: bad run cursor", ErrInvalidCursor)
	}
	c.StartedAt = c.StartedAt.UTC()
	return c, nil
}
