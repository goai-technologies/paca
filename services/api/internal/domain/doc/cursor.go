package docdom

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// TreeCursor identifies the last row of a page of the doc tree, which lists a
// folder's children in manual order: position ASC, then name/title ASC, then
// id ASC to make the order total.
type TreeCursor struct {
	Position int    `json:"p"`
	Name     string `json:"n"`
	ID       string `json:"id"`
}

func encodeTreeCursor(c TreeCursor) string {
	b, _ := json.Marshal(c)
	return base64.URLEncoding.EncodeToString(b)
}

// EncodeDocumentTreeCursor builds the cursor for resuming after d.
func EncodeDocumentTreeCursor(d *Document) string {
	return encodeTreeCursor(TreeCursor{Position: d.Position, Name: d.Title, ID: d.ID.String()})
}

// EncodeFolderTreeCursor builds the cursor for resuming after f.
func EncodeFolderTreeCursor(f *DocFolder) string {
	return encodeTreeCursor(TreeCursor{Position: f.Position, Name: f.Name, ID: f.ID.String()})
}

// DecodeTreeCursor parses a token produced by EncodeDocumentTreeCursor or
// EncodeFolderTreeCursor; any failure wraps ErrInvalidCursor.
func DecodeTreeCursor(s string) (TreeCursor, error) {
	var c TreeCursor
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return c, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("%w: json: %v", ErrInvalidCursor, err)
	}
	if _, err := uuid.Parse(c.ID); err != nil {
		return c, fmt.Errorf("%w: id: %v", ErrInvalidCursor, err)
	}
	return c, nil
}

type snapshotCursor struct {
	Number int64 `json:"n"`
}

// EncodeSnapshotCursor builds the cursor for resuming a document's snapshot
// list (newest first) after s. snapshot_number is unique and increasing per
// document, so it alone orders the list.
func EncodeSnapshotCursor(s *DocSnapshot) string {
	b, _ := json.Marshal(snapshotCursor{Number: s.SnapshotNumber})
	return base64.URLEncoding.EncodeToString(b)
}

// DecodeSnapshotCursor returns the snapshot number in a token produced by
// EncodeSnapshotCursor; any failure wraps ErrInvalidCursor.
func DecodeSnapshotCursor(s string) (int64, error) {
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return 0, fmt.Errorf("%w: base64: %v", ErrInvalidCursor, err)
	}
	var c snapshotCursor
	if err := json.Unmarshal(b, &c); err != nil || c.Number < 1 {
		return 0, fmt.Errorf("%w: bad snapshot cursor", ErrInvalidCursor)
	}
	return c.Number, nil
}
