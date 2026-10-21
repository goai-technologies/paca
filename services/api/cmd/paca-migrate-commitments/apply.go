package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// state is what has already been done, so a re-run after a failure resumes
// instead of creating a second copy of anything. It is rewritten after every
// step.
type state struct {
	TargetProjectID string                      `json:"target_project_id"`
	Commitments     map[string]*commitmentState `json:"commitments"` // old task id -> progress
}

type commitmentState struct {
	OldRef         string          `json:"old_ref"`
	NewID          string          `json:"new_id,omitempty"`
	NewRef         string          `json:"new_ref,omitempty"`
	NewNoted       bool            `json:"new_noted,omitempty"`
	Attached       map[string]bool `json:"attached,omitempty"` // ticket id -> done
	StatusSet      bool            `json:"status_set,omitempty"`
	CommentsCopied bool            `json:"comments_copied,omitempty"`
	LinksRemoved   map[string]bool `json:"links_removed,omitempty"`
	OldNoted       bool            `json:"old_noted,omitempty"`
	OldDeleted     bool            `json:"old_deleted,omitempty"`
}

func loadState(path string) (*state, error) {
	st := &state{Commitments: map[string]*commitmentState{}}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, st); err != nil {
		return nil, fmt.Errorf("state file %s: %w", path, err)
	}
	if st.Commitments == nil {
		st.Commitments = map[string]*commitmentState{}
	}
	return st, nil
}

func (st *state) save(path string) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// target is the Commitments project once it exists, with the ids the
// per-commitment steps need.
type target struct {
	Project        project
	CommitmentType string
	OpenStatus     string            // a non-done status to create in before attaching work
	StatusByName   map[string]string // lower-cased name -> id
	MemberByUser   map[string]string // user id -> member id
}

type runner struct {
	c        *client
	opt      options
	st       *state
	stateOut string
	log      func(string)
}

func (r *runner) save() error { return r.st.save(r.stateOut) }

// prepareTarget creates or completes the Commitments project: statuses,
// the Commitment type, fields and members. Every step is idempotent.
func (r *runner) prepareTarget(ctx context.Context, inv *inventory, p *plan) (*target, error) {
	var proj *project
	for _, pr := range inv.Projects {
		if strings.EqualFold(pr.TaskIDPrefix, r.opt.Prefix) {
			proj = pr
		}
	}
	if proj == nil {
		var created project
		err := r.c.do(ctx, http.MethodPost, "/api/v1/projects", map[string]any{
			"name":           r.opt.ProjectName,
			"task_id_prefix": r.opt.Prefix,
			"description":    "Every commitment lives here. Tickets in any project attach to one of these through their Commitment field.",
			"settings":       map[string]any{"default_workstream": strings.ToLower(r.opt.Workstream)},
		}, &created)
		if err != nil {
			return nil, fmt.Errorf("create project: %w", err)
		}
		proj = &created
		r.log(fmt.Sprintf("created project %s (%s)", created.Name, created.TaskIDPrefix))
	}
	r.st.TargetProjectID = proj.ID
	if err := r.save(); err != nil {
		return nil, err
	}
	base := "/api/v1/projects/" + proj.ID
	t := &target{Project: *proj, StatusByName: map[string]string{}, MemberByUser: map[string]string{}}

	statuses, err := listItems[taskStatus](ctx, r.c, base+"/task-statuses")
	if err != nil {
		return nil, err
	}
	for _, s := range statuses {
		t.StatusByName[strings.ToLower(s.Name)] = s.ID
		if t.OpenStatus == "" && s.Category == "todo" {
			t.OpenStatus = s.ID
		}
	}
	for _, want := range p.Statuses {
		key := strings.ToLower(want.Name)
		if id, ok := t.StatusByName[key]; ok {
			for _, have := range statuses {
				if have.ID == id && have.Category != want.Category {
					return nil, fmt.Errorf("status %q exists in %s with category %s, but the commitments use category %s", want.Name, proj.TaskIDPrefix, have.Category, want.Category)
				}
			}
			continue
		}
		var created taskStatus
		if err := r.c.do(ctx, http.MethodPost, base+"/task-statuses", map[string]any{
			"name": want.Name, "category": want.Category, "color": want.Color, "position": len(statuses) + 1,
		}, &created); err != nil {
			return nil, fmt.Errorf("create status %s: %w", want.Name, err)
		}
		statuses = append(statuses, created)
		t.StatusByName[key] = created.ID
		r.log(fmt.Sprintf("created status %s (%s)", want.Name, want.Category))
	}
	if t.OpenStatus == "" {
		return nil, errors.New("the Commitments project has no status with category todo to create commitments in")
	}

	types, err := listItems[taskType](ctx, r.c, base+"/task-types")
	if err != nil {
		return nil, err
	}
	for _, ty := range types {
		if isCommitmentType(ty.Name) {
			t.CommitmentType = ty.ID
		}
	}
	if t.CommitmentType == "" {
		var created taskType
		if err := r.c.do(ctx, http.MethodPost, base+"/task-types", map[string]any{
			"name": "Commitment", "icon": "Flag", "color": "#f59e0b", "description": "A promise made to a customer or to the business, tracked on the delivery dashboard",
		}, &created); err != nil {
			return nil, fmt.Errorf("create Commitment type: %w", err)
		}
		t.CommitmentType = created.ID
		r.log("created task type Commitment")
	}

	fields, err := listItems[customField](ctx, r.c, base+"/custom-fields")
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, f := range fields {
		have[f.FieldKey] = true
	}
	for _, f := range p.Fields {
		if have[f.FieldKey] {
			continue
		}
		opts := f.Options
		if opts == nil {
			opts = []fieldOption{}
		}
		if err := r.c.do(ctx, http.MethodPost, base+"/custom-fields", map[string]any{
			"field_key": f.FieldKey, "display_name": f.DisplayName, "field_type": f.FieldType, "options": opts, "is_required": false,
		}, nil); err != nil {
			return nil, fmt.Errorf("create field %s: %w", f.FieldKey, err)
		}
		r.log(fmt.Sprintf("created field %s (%s)", f.DisplayName, f.FieldType))
	}

	roles, err := listItems[role](ctx, r.c, base+"/roles")
	if err != nil {
		return nil, err
	}
	editor := ""
	for _, ro := range roles {
		if strings.EqualFold(ro.Name, "Editor") {
			editor = ro.ID
		}
	}
	if editor == "" && len(roles) > 0 {
		editor = roles[0].ID
	}
	members, err := listCursor[member](ctx, r.c, base+"/members")
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		t.MemberByUser[m.UserID] = m.ID
	}
	for _, o := range p.Owners {
		if _, ok := t.MemberByUser[o.UserID]; ok {
			continue
		}
		var created member
		if err := r.c.do(ctx, http.MethodPost, base+"/members", map[string]any{"user_id": o.UserID, "role_ids": []string{editor}}, &created); err != nil {
			return nil, fmt.Errorf("add member %s: %w", o.FullName, err)
		}
		t.MemberByUser[o.UserID] = created.ID
		r.log(fmt.Sprintf("added member %s", o.FullName))
	}

	if err := r.c.do(ctx, http.MethodPut, "/api/v1/admin/settings/commitments-project", map[string]any{"project_id": proj.ID}, nil); err != nil {
		return nil, fmt.Errorf("set commitments project: %w", err)
	}
	r.log(fmt.Sprintf("workspace commitments project = %s", proj.TaskIDPrefix))
	return t, nil
}

// migrateOne carries one commitment across. Each step checks the state
// first, so a re-run picks up where the last one stopped.
func (r *runner) migrateOne(ctx context.Context, inv *inventory, t *target, cp commitmentPlan) error {
	old := cp.Old
	cs := r.st.Commitments[old.ID]
	if cs == nil {
		cs = &commitmentState{OldRef: cp.OldRef, Attached: map[string]bool{}, LinksRemoved: map[string]bool{}}
		r.st.Commitments[old.ID] = cs
	}
	if cs.Attached == nil {
		cs.Attached = map[string]bool{}
	}
	if cs.LinksRemoved == nil {
		cs.LinksRemoved = map[string]bool{}
	}
	oldBase := fmt.Sprintf("/api/v1/projects/%s/tasks/%s", old.ProjectID, old.ID)
	targetBase := "/api/v1/projects/" + t.Project.ID

	finalStatus, ok := t.StatusByName[strings.ToLower(cp.Status.Name)]
	if !ok {
		return fmt.Errorf("%s: status %q missing in target", cp.OldRef, cp.Status.Name)
	}
	done := cp.Status.Category == "done"

	if cs.NewID == "" {
		fields := map[string]any{}
		for k, v := range old.CustomFields {
			fields[k] = v
		}
		fields["workstream"] = r.opt.Workstream
		var assignees []string
		for _, mid := range old.AssigneeIDs {
			if m := findMember(inv.Members[old.ProjectID], mid); m != nil {
				if nm, ok := t.MemberByUser[m.UserID]; ok {
					assignees = append(assignees, nm)
				}
			}
		}
		if assignees == nil {
			assignees = []string{}
		}
		body := map[string]any{
			"title":         old.Title,
			"task_type_id":  t.CommitmentType,
			"status_id":     t.OpenStatus,
			"importance":    old.Importance,
			"custom_fields": fields,
			"assignee_ids":  assignees,
			"tags":          old.Tags,
		}
		if !done {
			body["status_id"] = finalStatus
		}
		if len(old.Description) > 0 && string(old.Description) != "null" {
			body["description"] = json.RawMessage(old.Description)
		}
		if old.StoryPoints != nil {
			body["story_points"] = *old.StoryPoints
		}
		if old.StartDate != nil {
			body["start_date"] = old.StartDate
		}
		if old.DueDate != nil {
			body["due_date"] = old.DueDate
		}
		if old.ReporterID != nil {
			if m := findMember(inv.Members[old.ProjectID], *old.ReporterID); m != nil {
				if nm, ok := t.MemberByUser[m.UserID]; ok {
					body["reporter_id"] = nm
				}
			}
		}
		var created task
		if err := r.c.do(ctx, http.MethodPost, targetBase+"/tasks", body, &created); err != nil {
			return fmt.Errorf("%s: create: %w", cp.OldRef, err)
		}
		cs.NewID = created.ID
		cs.NewRef = ref(t.Project.TaskIDPrefix, created.TaskNumber)
		if err := r.save(); err != nil {
			return err
		}
		r.log(fmt.Sprintf("%s -> %s created", cp.OldRef, cs.NewRef))
	}
	newBase := fmt.Sprintf("%s/tasks/%s", targetBase, cs.NewID)

	if !cs.NewNoted {
		note := fmt.Sprintf("Migrated from %s (%s), created %s.", cp.OldRef, inv.Projects[old.ProjectID].Name, old.CreatedAt.Format("2 Jan 2006"))
		if err := r.c.do(ctx, http.MethodPost, newBase+"/activities/comments", map[string]any{"content": paragraphs(note)}, nil); err != nil {
			return fmt.Errorf("%s: note on new: %w", cs.NewRef, err)
		}
		cs.NewNoted = true
		if err := r.save(); err != nil {
			return err
		}
	}

	for _, a := range cp.Attach {
		if cs.Attached[a.Task.ID] {
			continue
		}
		body := map[string]any{"commitment_task_id": cs.NewID}
		if a.DetachFirst {
			body["parent_task_id"] = nil
		}
		if err := r.c.do(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/projects/%s/tasks/%s", a.Task.ProjectID, a.Task.ID), body, nil); err != nil {
			return fmt.Errorf("%s: attach %s: %w", cp.OldRef, a.Ref, err)
		}
		cs.Attached[a.Task.ID] = true
		if err := r.save(); err != nil {
			return err
		}
	}
	if len(cp.Attach) > 0 {
		r.log(fmt.Sprintf("%s: %d tickets attached", cs.NewRef, len(cp.Attach)))
	}

	if !cs.StatusSet {
		if done {
			if err := r.c.do(ctx, http.MethodPatch, newBase, map[string]any{"status_id": finalStatus}, nil); err != nil {
				return fmt.Errorf("%s: set status %s: %w", cs.NewRef, cp.Status.Name, err)
			}
		}
		cs.StatusSet = true
		if err := r.save(); err != nil {
			return err
		}
	}

	if !cs.CommentsCopied {
		for _, cm := range cp.Comments {
			var blocks []json.RawMessage
			if err := json.Unmarshal(cm.Content, &blocks); err != nil {
				blocks = nil
			}
			prefix := paragraphs(fmt.Sprintf("Comment by %s on %s, copied from %s:", cm.ActorName, cm.CreatedAt.Format("2 Jan 2006"), cp.OldRef))
			content := append(prefix, blocks...)
			if err := r.c.do(ctx, http.MethodPost, newBase+"/activities/comments", map[string]any{"content": content}, nil); err != nil {
				return fmt.Errorf("%s: copy comment: %w", cs.NewRef, err)
			}
		}
		cs.CommentsCopied = true
		if err := r.save(); err != nil {
			return err
		}
	}

	for _, l := range cp.RemoveLinks {
		if cs.LinksRemoved[l.ID] {
			continue
		}
		err := r.c.do(ctx, http.MethodDelete, fmt.Sprintf("%s/links/%s", oldBase, l.ID), nil, nil)
		var ae *apiError
		if err != nil && !(errors.As(err, &ae) && ae.Status == http.StatusNotFound) {
			return fmt.Errorf("%s: remove link: %w", cp.OldRef, err)
		}
		cs.LinksRemoved[l.ID] = true
		if err := r.save(); err != nil {
			return err
		}
	}

	if !cs.OldNoted {
		note := fmt.Sprintf("Migrated to %s in the %s project. This task is retired; the commitment and its work live there now.", cs.NewRef, t.Project.Name)
		// Best effort: comments need project membership, and the migrating
		// account is rarely a member of every project. The old task is
		// retired right after, and the new one already says where it came from.
		err := r.c.do(ctx, http.MethodPost, oldBase+"/activities/comments", map[string]any{"content": paragraphs(note)}, nil)
		var ae *apiError
		if err != nil && errors.As(err, &ae) && ae.Code == "PROJECT_MEMBER_NOT_FOUND" {
			r.log(fmt.Sprintf("%s: not a member of its project, so no retirement note was left (it is still retired)", cp.OldRef))
		} else if err != nil {
			return fmt.Errorf("%s: note on old: %w", cp.OldRef, err)
		}
		cs.OldNoted = true
		if err := r.save(); err != nil {
			return err
		}
	}
	if !cs.OldDeleted {
		err := r.c.do(ctx, http.MethodDelete, oldBase, nil, nil)
		var ae *apiError
		if err != nil && !(errors.As(err, &ae) && ae.Status == http.StatusNotFound) {
			return fmt.Errorf("%s: delete old: %w", cp.OldRef, err)
		}
		cs.OldDeleted = true
		if err := r.save(); err != nil {
			return err
		}
		r.log(fmt.Sprintf("%s retired", cp.OldRef))
	}
	return nil
}

// paragraphs renders plain text as BlockNote blocks, the format PACA stores
// comments and descriptions in.
func paragraphs(lines ...string) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(lines))
	for _, line := range lines {
		b, _ := json.Marshal(map[string]any{
			"id":       uuid.NewString(),
			"type":     "paragraph",
			"props":    map[string]any{"textColor": "default", "textAlignment": "left", "backgroundColor": "default"},
			"content":  []map[string]any{{"type": "text", "text": line, "styles": map[string]any{}}},
			"children": []any{},
		})
		out = append(out, b)
	}
	return out
}

// verify re-reads PACA and checks that every commitment exists in the target
// with exactly the tickets the plan attached, and that every old one is gone.
func (r *runner) verify(ctx context.Context, inv *inventory, p *plan, t *target) []string {
	var problems []string
	for _, cp := range p.Commitments {
		cs := r.st.Commitments[cp.Old.ID]
		if cs == nil || cs.NewID == "" {
			problems = append(problems, cp.OldRef+": not migrated")
			continue
		}
		var work struct {
			Projects []struct {
				Tasks []struct {
					Ref string `json:"ref"`
				} `json:"tasks"`
			} `json:"projects"`
			HiddenProjectCount int `json:"hidden_project_count"`
		}
		if err := r.c.get(ctx, "/api/v1/commitments/"+cs.NewID+"/work", &work); err != nil {
			problems = append(problems, fmt.Sprintf("%s: read work: %v", cs.NewRef, err))
			continue
		}
		if work.HiddenProjectCount > 0 {
			problems = append(problems, fmt.Sprintf("%s: %d project(s) hidden from the verifying account; give it read access and re-run -verify", cs.NewRef, work.HiddenProjectCount))
		}
		var got []string
		for _, g := range work.Projects {
			for _, w := range g.Tasks {
				got = append(got, w.Ref)
			}
		}
		// Expected work is what this plan attaches plus what earlier runs of
		// the same migration already attached: a resumed run re-reads PACA
		// after some links are gone, so its plan alone undercounts.
		wantSet := map[string]bool{}
		for _, a := range cp.Attach {
			wantSet[a.Ref] = true
		}
		for id := range cs.Attached {
			if tk := inv.Tasks[id]; tk != nil {
				wantSet[inv.refOf(tk)] = true
			}
		}
		var want []string
		for w := range wantSet {
			want = append(want, w)
		}
		sort.Strings(got)
		sort.Strings(want)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			problems = append(problems, fmt.Sprintf("%s (%s): attached %v, expected %v", cs.NewRef, cp.OldRef, got, want))
		}
		var old task
		err := r.c.get(ctx, fmt.Sprintf("/api/v1/projects/%s/tasks/%s", cp.Old.ProjectID, cp.Old.ID), &old)
		var ae *apiError
		if err == nil || !(errors.As(err, &ae) && ae.Status == http.StatusNotFound) {
			problems = append(problems, fmt.Sprintf("%s: old commitment still readable (%v)", cp.OldRef, err))
		}
	}
	return problems
}

// createdAtSQL is the one thing the API cannot do: keep the original
// created dates. Printed for review, never executed here.
func createdAtSQL(p *plan, st *state) string {
	var b strings.Builder
	b.WriteString("-- Keep each migrated commitment's original created date. Review, then run against the PACA database.\nBEGIN;\n")
	for _, cp := range p.Commitments {
		cs := st.Commitments[cp.Old.ID]
		if cs == nil || cs.NewID == "" {
			continue
		}
		fmt.Fprintf(&b, "UPDATE tasks SET created_at = '%s' WHERE id = '%s'; -- %s <- %s\n", cp.Old.CreatedAt.UTC().Format(time.RFC3339Nano), cs.NewID, cs.NewRef, cp.OldRef)
	}
	b.WriteString("COMMIT;\n")
	return b.String()
}
