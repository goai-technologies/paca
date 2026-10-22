package commitmentmigration

import (
	"strings"
	"testing"
)

// A small workspace: project A holds commitment A-1 with a linked epic A-2
// (which has a child A-3), a linked child A-5 whose parent A-4 is unlinked,
// and the commitment's own child A-6. Project B holds commitment B-1 that
// shares epic A-2 through a second link.
func fixture() *inventory {
	inv := &inventory{
		Projects: map[string]*project{"A": {ID: "A", Name: "Alpha", TaskIDPrefix: "A"}, "B": {ID: "B", Name: "Beta", TaskIDPrefix: "B"}},
		Types: map[string]map[string]taskType{
			"A": {"c": {ID: "c", Name: "Commitment"}, "e": {ID: "e", Name: "Epic"}},
			"B": {"c": {ID: "c", Name: " commitment "}, "e": {ID: "e", Name: "Epic"}},
		},
		Statuses: map[string]map[string]taskStatus{
			"A": {"done": {ID: "done", Name: "Released", Category: "done"}, "todo": {ID: "todo", Name: "Todo", Category: "todo"}},
			"B": {"ip": {ID: "ip", Name: "In Progress", Category: "inprogress"}},
		},
		Fields:   map[string][]customField{"A": {{FieldKey: "commitment_type", DisplayName: "Commitment Type", FieldType: "select", Options: []fieldOption{{Value: "Customer"}}}}},
		Members:  map[string][]member{"A": {{ID: "mA", UserID: "u1", FullName: "Owner One"}}},
		Tasks:    map[string]*task{},
		Comments: map[string][]activity{},
	}
	s := func(v string) *string { return &v }
	add := func(id, proj, ty, st string, n int64, parent *string) {
		inv.Tasks[id] = &task{ID: id, ProjectID: proj, TaskTypeID: s(ty), StatusID: s(st), TaskNumber: n, ParentTaskID: parent, Title: id}
	}
	add("a1", "A", "c", "done", 1, nil)
	inv.Tasks["a1"].AssigneeIDs = []string{"mA"}
	inv.Tasks["a1"].CustomFields = map[string]any{"commitment_type": "Customer", "stakeholder": "", "customer": "N"}
	add("a2", "A", "e", "todo", 2, nil)
	add("a3", "A", "e", "todo", 3, s("a2"))
	add("a4", "A", "e", "todo", 4, nil)
	add("a5", "A", "e", "todo", 5, s("a4"))
	add("a6", "A", "e", "todo", 6, s("a1"))
	add("b1", "B", "c", "ip", 1, nil)
	inv.Links = []taskLink{
		{ID: "l1", SourceTaskID: "a1", TargetTaskID: "a2", LinkType: "relates_to"},
		{ID: "l2", SourceTaskID: "a5", TargetTaskID: "a1", LinkType: "relates_to"},
		{ID: "l3", SourceTaskID: "a3", TargetTaskID: "a1", LinkType: "relates_to"},
	}
	return inv
}

func TestPlanAttachesTopLevelWorkAndFlagsTheRest(t *testing.T) {
	inv := fixture()
	p := buildPlan(inv, options{Prefix: "COM", Workstream: "Delivery", AlsoAttach: map[string]string{}})

	if len(p.Commitments) != 2 || p.Commitments[0].OldRef != "A-1" || p.Commitments[1].OldRef != "B-1" {
		t.Fatalf("commitments: %+v", p.Commitments)
	}
	a1 := p.Commitments[0]
	var refs []string
	for _, a := range a1.Attach {
		refs = append(refs, a.Ref+":"+a.Reason)
	}
	if got := strings.Join(refs, " "); got != "A-2:linked A-6:child-of-commitment" {
		t.Fatalf("attach = %q", got)
	}
	if !a1.Attach[1].DetachFirst {
		t.Fatal("the commitment's own child must be detached before it is attached")
	}
	if len(a1.RemoveLinks) != 3 {
		t.Fatalf("links to remove = %d, want 3", len(a1.RemoveLinks))
	}
	if len(p.Issues) != 1 || !strings.Contains(p.Issues[0], "A-5") || !strings.Contains(p.Issues[0], "--also-attach A-4=A-1") {
		t.Fatalf("issues = %v", p.Issues)
	}
	if len(a1.Skipped) != 1 || !strings.Contains(a1.Skipped[0], "A-3 follows its top-level ticket A-2") {
		t.Fatalf("skipped = %v", a1.Skipped)
	}
}

func TestPlanHonoursAlsoAttach(t *testing.T) {
	inv := fixture()
	p := buildPlan(inv, options{Prefix: "COM", AlsoAttach: map[string]string{"A-4": "A-1"}})
	if len(p.Issues) != 0 {
		t.Fatalf("issues = %v", p.Issues)
	}
	var refs []string
	for _, a := range p.Commitments[0].Attach {
		refs = append(refs, a.Ref)
	}
	if got := strings.Join(refs, " "); got != "A-2 A-4 A-6" {
		t.Fatalf("attach = %q", got)
	}
}

func TestPlanRefusesATicketLinkedToTwoCommitments(t *testing.T) {
	inv := fixture()
	inv.Links = append(inv.Links, taskLink{ID: "l4", SourceTaskID: "b1", TargetTaskID: "a2", LinkType: "relates_to"})
	p := buildPlan(inv, options{Prefix: "COM", AlsoAttach: map[string]string{"A-4": "A-1"}})
	found := false
	for _, i := range p.Issues {
		if strings.Contains(i, "A-2 is linked to 2 commitments (A-1, B-1)") {
			found = true
		}
	}
	if !found {
		t.Fatalf("issues = %v", p.Issues)
	}
	for _, cp := range p.Commitments {
		for _, a := range cp.Attach {
			if a.Ref == "A-2" {
				t.Fatal("an ambiguous ticket must not be attached anywhere")
			}
		}
	}
}

func TestPlanCollectsStatusesFieldsAndOwners(t *testing.T) {
	inv := fixture()
	p := buildPlan(inv, options{Prefix: "COM", AlsoAttach: map[string]string{"A-4": "A-1"}})
	var statuses, fields []string
	for _, s := range p.Statuses {
		statuses = append(statuses, s.Name+"/"+s.Category)
	}
	for _, f := range p.Fields {
		fields = append(fields, f.FieldKey)
	}
	if got := strings.Join(statuses, " "); got != "Released/done In Progress/inprogress" && got != "In Progress/inprogress Released/done" {
		t.Fatalf("statuses = %q", got)
	}
	// customer is set on A-1 (text, no definition anywhere -> carried as text);
	// stakeholder is empty on A-1 but provisioned anyway; workstream is added.
	if got := strings.Join(fields, " "); got != "commitment_source commitment_type customer effort_days priority stakeholder workstream" {
		t.Fatalf("fields = %q", got)
	}
	if len(p.Owners) != 1 || p.Owners[0].UserID != "u1" {
		t.Fatalf("owners = %+v", p.Owners)
	}
}

func TestPlanIgnoresCommitmentsAlreadyInTheTarget(t *testing.T) {
	inv := fixture()
	p := buildPlan(inv, options{Prefix: "COM", TargetID: "B", AlsoAttach: map[string]string{"A-4": "A-1"}})
	if len(p.Commitments) != 1 || p.Commitments[0].OldRef != "A-1" {
		t.Fatalf("commitments = %+v", p.Commitments)
	}
}

func TestPlanRefusesAlsoAttachThatContradictsALink(t *testing.T) {
	inv := fixture()
	// A-4 is linked to B-1; asking to attach it to A-1 by hand must be refused.
	inv.Links = append(inv.Links, taskLink{ID: "l5", SourceTaskID: "b1", TargetTaskID: "a4", LinkType: "relates_to"})
	p := buildPlan(inv, options{Prefix: "COM", AlsoAttach: map[string]string{"A-4": "A-1"}})
	found := false
	for _, i := range p.Issues {
		if strings.Contains(i, "--also-attach A-4=A-1: A-4 is already linked to B-1") {
			found = true
		}
	}
	if !found {
		t.Fatalf("issues = %v", p.Issues)
	}
	for _, a := range p.Commitments[0].Attach {
		if a.Ref == "A-4" {
			t.Fatal("A-4 must not be attached to A-1")
		}
	}
}
