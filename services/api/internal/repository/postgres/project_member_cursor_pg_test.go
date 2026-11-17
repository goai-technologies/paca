package postgres

import (
	"context"
	"testing"

	"github.com/google/uuid"

	projectdom "github.com/Paca-AI/api/internal/domain/project"
)

func memberNames(ms []*projectdom.ProjectMember) []string {
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		out = append(out, m.Username)
	}
	return out
}

func TestListMembers_PagesAndFilters(t *testing.T) {
	e := newFlowEnv(t)
	ctx := context.Background()
	creator := e.user("creator")
	p := e.createProject(creator, "Cursor Members")
	editor := e.role(p.ID, "Admin")
	for _, name := range []string{"carol", "alice", "bob", "dave"} {
		if _, err := e.svc.AddMember(ctx, p.ID, projectdom.AddMemberInput{UserID: e.user(name), RoleIDs: []uuid.UUID{editor}}); err != nil {
			t.Fatalf("add %s: %v", name, err)
		}
	}
	// 5 members in total: creator + 4. Page through two at a time.
	var seen []string
	var cursor *string
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("pagination did not terminate")
		}
		ms, more, err := e.projs.ListMembers(ctx, p.ID, 2, cursor, projectdom.MemberFilter{})
		if err != nil {
			t.Fatal(err)
		}
		seen = append(seen, memberNames(ms)...)
		if !more {
			break
		}
		c := projectdom.EncodeMemberCursor(ms[len(ms)-1])
		cursor = &c
	}
	want := []string{"alice", "bob", "carol", "creator", "dave"}
	if len(seen) != len(want) {
		t.Fatalf("seen %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("seen %v, want %v", seen, want)
		}
	}

	// Search narrows before the page is cut, and roles are loaded.
	ms, more, err := e.projs.ListMembers(ctx, p.ID, 10, nil, projectdom.MemberFilter{Search: "AL"})
	if err != nil || more || len(ms) != 1 || ms[0].Username != "alice" {
		t.Fatalf("search: %v %v %v", memberNames(ms), more, err)
	}
	if len(ms[0].Roles) != 1 {
		t.Errorf("roles = %v", ms[0].Roles)
	}
	// SkipRoles leaves the roles lookup out for callers that only need identity.
	lite, _, err := e.projs.ListMembers(ctx, p.ID, 10, nil, projectdom.MemberFilter{Search: "AL", SkipRoles: true})
	if err != nil || len(lite) != 1 || lite[0].Username != "alice" || len(lite[0].Roles) != 0 {
		t.Fatalf("skip roles: %v %v", lite, err)
	}

	if n, err := e.projs.CountMembers(ctx, p.ID, projectdom.MemberFilter{}); err != nil || n != 5 {
		t.Fatalf("count all = %d, %v", n, err)
	}
	if n, err := e.projs.CountMembers(ctx, p.ID, projectdom.MemberFilter{Search: "a"}); err != nil || n != 4 {
		t.Fatalf("count search a = %d, %v", n, err)
	}

	// Batch lookup by account id, and role / type filters.
	ms, _, err = e.projs.ListMembers(ctx, p.ID, 10, nil, projectdom.MemberFilter{AccountIDs: []uuid.UUID{ms[0].AccountID}})
	if err != nil || len(ms) != 1 {
		t.Fatalf("ids: %v %v", memberNames(ms), err)
	}
	// The same lookup also accepts the membership id.
	byMember, _, err := e.projs.ListMembers(ctx, p.ID, 10, nil, projectdom.MemberFilter{AccountIDs: []uuid.UUID{ms[0].ID}})
	if err != nil || len(byMember) != 1 || byMember[0].ID != ms[0].ID {
		t.Fatalf("ids by membership id: %v %v", memberNames(byMember), err)
	}
	ms, _, err = e.projs.ListMembers(ctx, p.ID, 10, nil, projectdom.MemberFilter{MemberType: "agent"})
	if err != nil || len(ms) != 0 {
		t.Fatalf("agent type: %v %v", memberNames(ms), err)
	}
	other := uuid.New()
	ms, _, err = e.projs.ListMembers(ctx, p.ID, 10, nil, projectdom.MemberFilter{RoleID: &other})
	if err != nil || len(ms) != 0 {
		t.Fatalf("role: %v %v", memberNames(ms), err)
	}
	ms, _, err = e.projs.ListMembers(ctx, p.ID, 10, nil, projectdom.MemberFilter{RoleID: &editor})
	if err != nil || len(ms) != 5 {
		t.Fatalf("role editor: %v %v", memberNames(ms), err)
	}
}
