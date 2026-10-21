package main

import (
	"fmt"
	"sort"
	"strings"
)

// inventory is everything the planner needs, read once from PACA. It is a
// plain value so the planner can be tested without a server.
type inventory struct {
	Projects map[string]*project            // by id, live projects only
	Types    map[string]map[string]taskType // project id -> type id -> type
	Statuses map[string]map[string]taskStatus
	Fields   map[string][]customField // project id -> definitions
	Members  map[string][]member      // project id -> members
	Tasks    map[string]*task         // by id, live tasks of live projects
	Links    []taskLink               // relates_to links only
	Comments map[string][]activity    // commitment task id -> comments
}

func (inv *inventory) refOf(t *task) string {
	if p, ok := inv.Projects[t.ProjectID]; ok {
		return ref(p.TaskIDPrefix, t.TaskNumber)
	}
	return "?-" + fmt.Sprint(t.TaskNumber)
}

func (inv *inventory) typeName(t *task) string {
	if t.TaskTypeID == nil {
		return ""
	}
	if ty, ok := inv.Types[t.ProjectID][*t.TaskTypeID]; ok {
		return ty.Name
	}
	return ""
}

func (inv *inventory) status(t *task) *taskStatus {
	if t.StatusID == nil {
		return nil
	}
	if s, ok := inv.Statuses[t.ProjectID][*t.StatusID]; ok {
		return &s
	}
	return nil
}

func (inv *inventory) isCommitment(t *task) bool {
	return isCommitmentType(inv.typeName(t))
}

// options steer the planner; every one of them is a flag on the command.
type options struct {
	ProjectName string
	Prefix      string
	Workstream  string            // value written to every migrated commitment's Workstream field
	AlsoAttach  map[string]string // ticket ref -> commitment ref, decided by hand
	TargetID    string            // existing Commitments project id, if already created
}

// attachment is one ticket that will carry the new commitment's id.
type attachment struct {
	Task        *task
	Ref         string
	DetachFirst bool   // the ticket is a child of the old commitment itself
	Reason      string // why it is attached: linked, also-attach, child-of-commitment
}

// commitmentPlan is the per-commitment work list.
type commitmentPlan struct {
	Old         *task
	OldRef      string
	Status      taskStatus // the old status, re-created in the target project
	Attach      []attachment
	RemoveLinks []taskLink // relates_to links between the old commitment and its work
	Comments    []activity
	Skipped     []string // informational notes about linked tickets that are not attached
}

type plan struct {
	Commitments []commitmentPlan
	Statuses    []taskStatus  // to exist in the target project (name + category)
	Fields      []customField // to exist in the target project
	Owners      []member      // accounts to add as members of the target project
	Issues      []string      // anything that must be decided before --apply
	Notes       []string
}

func buildPlan(inv *inventory, opt options) *plan {
	p := &plan{}

	// Which tickets name which commitments, through relates_to.
	linksByTicket := map[string][]*task{} // ticket id -> commitments it is linked to
	linkRows := map[string][]taskLink{}   // commitment id -> links to its work
	for _, l := range inv.Links {
		a, b := inv.Tasks[l.SourceTaskID], inv.Tasks[l.TargetTaskID]
		if a == nil || b == nil {
			continue
		}
		ca, cb := inv.isCommitment(a), inv.isCommitment(b)
		if ca == cb {
			continue // neither end is a commitment, or both are (a cross-reference)
		}
		c, t := a, b
		if cb {
			c, t = b, a
		}
		if c.ProjectID == opt.TargetID {
			continue // already lives in the Commitments project
		}
		linksByTicket[t.ID] = append(linksByTicket[t.ID], c)
		linkRows[c.ID] = append(linkRows[c.ID], l)
	}

	var commitments []*task
	for _, t := range inv.Tasks {
		if inv.isCommitment(t) && t.ProjectID != opt.TargetID {
			commitments = append(commitments, t)
		}
	}
	sort.Slice(commitments, func(i, j int) bool { return inv.refOf(commitments[i]) < inv.refOf(commitments[j]) })

	byRef := map[string]*task{}
	for _, t := range inv.Tasks {
		byRef[inv.refOf(t)] = t
	}
	extra := map[string][]*task{} // commitment id -> tickets attached by hand
	for tref, cref := range opt.AlsoAttach {
		t, c := byRef[tref], byRef[cref]
		switch {
		case t == nil || c == nil:
			p.Issues = append(p.Issues, fmt.Sprintf("--also-attach %s=%s: unknown ticket or commitment", tref, cref))
		case !inv.isCommitment(c):
			p.Issues = append(p.Issues, fmt.Sprintf("--also-attach %s=%s: %s is not a commitment", tref, cref, cref))
		case t.ParentTaskID != nil:
			p.Issues = append(p.Issues, fmt.Sprintf("--also-attach %s=%s: %s is a child ticket; attach its top-level parent instead", tref, cref, tref))
		case linkedElsewhere(linksByTicket[t.ID], c.ID):
			p.Issues = append(p.Issues, fmt.Sprintf("--also-attach %s=%s: %s is already linked to %s; remove that link first if it should move", tref, cref, tref, inv.refOf(linksByTicket[t.ID][0])))
		default:
			extra[c.ID] = append(extra[c.ID], t)
		}
	}

	statusSeen := map[string]taskStatus{}
	fieldKeys := map[string]bool{}
	owners := map[string]member{}
	for _, c := range commitments {
		cp := commitmentPlan{Old: c, OldRef: inv.refOf(c), Comments: inv.Comments[c.ID], RemoveLinks: linkRows[c.ID]}
		if st := inv.status(c); st != nil {
			cp.Status = *st
			statusSeen[strings.ToLower(st.Name)] = *st
		} else {
			p.Issues = append(p.Issues, fmt.Sprintf("%s has no status", cp.OldRef))
		}
		for k, v := range c.CustomFields {
			if s, ok := v.(string); ok && strings.TrimSpace(s) == "" {
				continue
			}
			if v != nil {
				fieldKeys[k] = true
			}
		}
		for _, mid := range c.AssigneeIDs {
			if m := findMember(inv.Members[c.ProjectID], mid); m != nil && m.MemberType != "agent" {
				owners[m.UserID] = *m
			}
		}
		if c.ReporterID != nil {
			if m := findMember(inv.Members[c.ProjectID], *c.ReporterID); m != nil && m.MemberType != "agent" {
				owners[m.UserID] = *m
			}
		}

		attached := map[string]bool{}
		add := func(t *task, reason string, detach bool) {
			if attached[t.ID] {
				return
			}
			attached[t.ID] = true
			cp.Attach = append(cp.Attach, attachment{Task: t, Ref: inv.refOf(t), Reason: reason, DetachFirst: detach})
		}

		// Linked work: top-level tickets attach; children follow their parent.
		for _, l := range linkRows[c.ID] {
			tid := l.SourceTaskID
			if tid == c.ID {
				tid = l.TargetTaskID
			}
			t := inv.Tasks[tid]
			tref := inv.refOf(t)
			if others := linksByTicket[t.ID]; len(others) > 1 {
				names := make([]string, 0, len(others))
				for _, o := range others {
					names = append(names, inv.refOf(o))
				}
				sort.Strings(names)
				p.Issues = append(p.Issues, fmt.Sprintf("%s is linked to %d commitments (%s); remove the links that do not apply", tref, len(others), strings.Join(names, ", ")))
				continue
			}
			if t.ParentTaskID == nil {
				add(t, "linked", false)
				continue
			}
			parent := inv.Tasks[*t.ParentTaskID]
			top := topLevel(inv, t)
			topRef := inv.refOf(top)
			switch {
			case parent == nil:
				cp.Skipped = append(cp.Skipped, fmt.Sprintf("%s: parent is missing; not attached", tref))
			case top.ID == c.ID:
				// A child of the commitment itself, also linked to it: handled below.
			case len(linksByTicket[top.ID]) == 1 && linksByTicket[top.ID][0].ID == c.ID,
				hasTask(extra[c.ID], top.ID):
				cp.Skipped = append(cp.Skipped, fmt.Sprintf("%s follows its top-level ticket %s, which is attached", tref, topRef))
			case len(linksByTicket[top.ID]) == 1:
				cp.Skipped = append(cp.Skipped, fmt.Sprintf("%s follows %s, which belongs to %s instead", tref, topRef, inv.refOf(linksByTicket[top.ID][0])))
			default:
				p.Issues = append(p.Issues, fmt.Sprintf("%s is linked to %s but its top-level ticket %s belongs to no commitment; pass --also-attach %s=%s or leave it out", tref, cp.OldRef, topRef, topRef, cp.OldRef))
			}
		}
		for _, t := range extra[c.ID] {
			add(t, "also-attach", false)
		}
		// The commitment's own children become top-level work of the new one.
		for _, t := range inv.Tasks {
			if t.ParentTaskID != nil && *t.ParentTaskID == c.ID {
				add(t, "child-of-commitment", true)
			}
		}
		sort.Slice(cp.Attach, func(i, j int) bool { return cp.Attach[i].Ref < cp.Attach[j].Ref })
		p.Commitments = append(p.Commitments, cp)
	}

	for _, st := range statusSeen {
		p.Statuses = append(p.Statuses, st)
	}
	sort.Slice(p.Statuses, func(i, j int) bool { return p.Statuses[i].Position < p.Statuses[j].Position })

	// Field definitions: the ones the commitments use, plus the set the
	// dashboard provisions, with Workstream added so each commitment can say
	// where it belongs now that the project no longer tells you.
	for _, k := range []string{"commitment_type", "stakeholder", "commitment_source", "priority", "effort_days", "workstream"} {
		fieldKeys[k] = true
	}
	fieldSeen := map[string]customField{}
	for _, defs := range inv.Fields {
		for _, d := range defs {
			if fieldKeys[d.FieldKey] {
				if prev, ok := fieldSeen[d.FieldKey]; !ok || len(d.Options) > len(prev.Options) {
					fieldSeen[d.FieldKey] = d
				}
			}
		}
	}
	if _, ok := fieldSeen["workstream"]; !ok {
		fieldSeen["workstream"] = customField{FieldKey: "workstream", DisplayName: "Workstream", FieldType: "select",
			Options: []fieldOption{{Value: "Delivery"}, {Value: "Platform"}, {Value: "Internal"}}}
	}
	for k := range fieldKeys {
		if _, ok := fieldSeen[k]; !ok {
			p.Notes = append(p.Notes, fmt.Sprintf("field %q is set on a commitment but has no definition anywhere; it is carried over as a text field", k))
			fieldSeen[k] = customField{FieldKey: k, DisplayName: k, FieldType: "text"}
		}
	}
	for _, d := range fieldSeen {
		p.Fields = append(p.Fields, d)
	}
	sort.Slice(p.Fields, func(i, j int) bool { return p.Fields[i].FieldKey < p.Fields[j].FieldKey })

	for _, m := range owners {
		p.Owners = append(p.Owners, m)
	}
	sort.Slice(p.Owners, func(i, j int) bool { return p.Owners[i].FullName < p.Owners[j].FullName })
	sort.Strings(p.Issues)
	return p
}

func topLevel(inv *inventory, t *task) *task {
	cur := t
	for i := 0; i < 64 && cur.ParentTaskID != nil; i++ {
		parent := inv.Tasks[*cur.ParentTaskID]
		if parent == nil {
			break
		}
		cur = parent
	}
	return cur
}

// linkedElsewhere reports whether a ticket's relates_to links name any
// commitment other than want.
func linkedElsewhere(linked []*task, want string) bool {
	for _, c := range linked {
		if c.ID != want {
			return true
		}
	}
	return false
}

func hasTask(list []*task, id string) bool {
	for _, t := range list {
		if t.ID == id {
			return true
		}
	}
	return false
}

func findMember(members []member, memberID string) *member {
	for i := range members {
		if members[i].ID == memberID {
			return &members[i]
		}
	}
	return nil
}
