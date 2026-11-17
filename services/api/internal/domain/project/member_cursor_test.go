package projectdom

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestMemberCursor_RoundTrip(t *testing.T) {
	m := &ProjectMember{ID: uuid.New(), Username: "Ada"}
	key, got, err := DecodeMemberCursor(EncodeMemberCursor(m))
	if err != nil || got != m.ID || key != "Ada" {
		t.Fatalf("got %q %v, %v; want Ada %v", key, got, err, m.ID)
	}
}

func TestDecodeMemberCursor_RejectsGarbage(t *testing.T) {
	for _, in := range []string{"!!!", "e30=", "eyJpZCI6Im5vcGUifQ==", "eyJpZCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCJ9"} {
		if _, _, err := DecodeMemberCursor(in); !errors.Is(err, ErrInvalidMemberCursor) {
			t.Errorf("%q: err = %v, want ErrInvalidMemberCursor", in, err)
		}
	}
}
