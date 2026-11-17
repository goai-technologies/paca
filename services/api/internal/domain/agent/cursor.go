package agentdom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ConversationCursor holds the stable ordering fields for keyset-based
// pagination over the conversations list, which is always ordered by
// created_at DESC, id DESC.
type ConversationCursor struct {
	CreatedAt time.Time `json:"ca"`
	ID        string    `json:"id"`
}

// EncodeConversationCursor builds an opaque base64 cursor from the last
// conversation on a page.
func EncodeConversationCursor(c *AgentConversation) string {
	cur := ConversationCursor{CreatedAt: c.CreatedAt.UTC(), ID: c.ID.String()}
	b, _ := json.Marshal(cur)
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeConversationCursor parses a cursor token produced by EncodeConversationCursor.
func DecodeConversationCursor(s string) (*ConversationCursor, error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("decode cursor base64: %w", err)
	}
	var c ConversationCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("decode cursor json: %w", err)
	}
	c.CreatedAt = c.CreatedAt.UTC()
	return &c, nil
}

// ConversationEventCursor holds the stable ordering field for keyset-based
// pagination over a single conversation's events, which are always ordered
// by event_index ASC. event_index alone is enough to seek by — it is unique
// and gapless per conversation — unlike the (CreatedAt, ID) tuple the other
// cursors below need to break ties on a non-unique timestamp.
type ConversationEventCursor struct {
	EventIndex int `json:"idx"`
}

// EncodeConversationEventCursor builds an opaque base64 cursor from an event
// on the boundary of a page (its first or last item, depending on which
// direction the cursor will be used to page in).
func EncodeConversationEventCursor(e *AgentConversationEvent) string {
	cur := ConversationEventCursor{EventIndex: e.EventIndex}
	b, _ := json.Marshal(cur)
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeConversationEventCursor parses a cursor token produced by
// EncodeConversationEventCursor.
func DecodeConversationEventCursor(s string) (*ConversationEventCursor, error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("decode cursor base64: %w", err)
	}
	var c ConversationEventCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("decode cursor json: %w", err)
	}
	return &c, nil
}

type agentCursor struct {
	Name string `json:"n"`
	ID   string `json:"id"`
}

// EncodeAgentCursor builds the cursor for resuming the name-ordered agent
// list after a. The name is stored as-is: the query lowercases both sides with
// the database's LOWER, so Go and Postgres case folding can never disagree.
func EncodeAgentCursor(a *Agent) string {
	b, _ := json.Marshal(agentCursor{Name: a.Name, ID: a.ID.String()})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeAgentCursor returns the (name, id) position in a token
// produced by EncodeAgentCursor; any failure wraps ErrInvalidCursor.
func DecodeAgentCursor(s string) (name string, id uuid.UUID, err error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return "", uuid.Nil, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c agentCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return "", uuid.Nil, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	id, err = uuid.Parse(c.ID)
	if err != nil {
		return "", uuid.Nil, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c.Name, id, nil
}
