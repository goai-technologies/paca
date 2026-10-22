// Package commitmentmigration moves a workspace onto central commitments,
// once, automatically, when the API starts.
//
// Before central commitments, every project held its own Commitment-typed
// tasks and work was tied to them with relates_to links. Afterwards one
// Commitments project holds every commitment, each commitment names the
// project it is for (tasks.home_project_id), and work is attached through
// tasks.commitment_task_id.
//
// Run moves each existing commitment into the Commitments project rather
// than copying it, so its id, comments, history, attachments and created
// date stay with it. It then attaches the commitment's linked work and
// removes the links it replaced. It is idempotent: it records completion in
// workspace_settings.commitments_migrated_at, a commitment already in the
// Commitments project is never touched again, and a run that stops part way
// resumes on the next start. It never blocks startup: a failure is logged and
// the API serves on; readers that still understand relates_to keep working.
//
// PACA_COMMITMENTS_MIGRATION controls it: "auto" (default) migrates,
// "dry-run" logs the plan and changes nothing, "off" skips it.
package commitmentmigration

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	projectdom "github.com/Paca-AI/api/internal/domain/project"
	settingsdom "github.com/Paca-AI/api/internal/domain/settings"
	taskdom "github.com/Paca-AI/api/internal/domain/task"
)

// Modes for PACA_COMMITMENTS_MIGRATION.
const (
	ModeAuto   = "auto"
	ModeDryRun = "dry-run"
	ModeOff    = "off"
)

// advisoryLockKey serialises the migration across API replicas starting at
// the same time. Fixed forever, like the schema migration lock.
const advisoryLockKey int64 = 20261022001

// Defaults for the Commitments project when the migration has to create it.
const (
	defaultProjectName   = "Commitments"
	defaultProjectPrefix = "COM"
)

// ProjectService is the slice of the project service the migration uses.
type ProjectService interface {
	Create(ctx context.Context, in projectdom.CreateProjectInput) (*projectdom.Project, error)
	AddMember(ctx context.Context, projectID uuid.UUID, in projectdom.AddMemberInput) (*projectdom.ProjectMember, error)
}

// SettingsService is the slice of the settings service the migration uses.
// SetCommitmentsProject also readies the project's task types.
type SettingsService interface {
	Get(ctx context.Context) (*settingsdom.WorkspaceSettings, error)
	SetCommitmentsProject(ctx context.Context, projectID *uuid.UUID, updatedBy uuid.UUID) (*settingsdom.WorkspaceSettings, error)
}

// Deps wires the migration.
type Deps struct {
	DB       *sqlx.DB
	Tasks    taskdom.Service
	Projects ProjectService
	Settings SettingsService
	// AdminUsername is the bootstrap admin; the migration acts as that
	// account (project creator, settings writer).
	AdminUsername string
	Mode          string
	Log           *slog.Logger
}

// Result summarises a run, for logs and tests.
type Result struct {
	Skipped      string // why nothing ran, if nothing ran
	TargetPrefix string
	Moved        []string // "OLD-1 -> COM-3"
	Attached     int
	LinksRemoved int
	LinksKept    int
	Issues       []string
	Completed    bool
}

// Run performs the migration according to d.Mode. It returns an error only
// for the caller to log; startup should continue regardless.
func Run(ctx context.Context, d Deps) (*Result, error) {
	mode := strings.ToLower(strings.TrimSpace(d.Mode))
	if mode == "" {
		mode = ModeAuto
	}
	res := &Result{}
	if mode == ModeOff {
		res.Skipped = "disabled by PACA_COMMITMENTS_MIGRATION=off"
		return res, nil
	}
	if mode != ModeAuto && mode != ModeDryRun {
		return res, fmt.Errorf("commitment migration: unknown PACA_COMMITMENTS_MIGRATION %q (want auto, dry-run or off)", d.Mode)
	}

	conn, err := d.DB.Connx(ctx)
	if err != nil {
		return res, fmt.Errorf("commitment migration: connection: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, advisoryLockKey); err != nil {
		return res, fmt.Errorf("commitment migration: lock: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), `SELECT pg_advisory_unlock($1)`, advisoryLockKey)
	}()

	var migratedAt sql.NullTime
	if err := d.DB.GetContext(ctx, &migratedAt, `SELECT commitments_migrated_at FROM workspace_settings LIMIT 1`); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return res, fmt.Errorf("commitment migration: read state: %w", err)
	}
	if migratedAt.Valid {
		res.Skipped = "already migrated at " + migratedAt.Time.UTC().Format(time.RFC3339)
		return res, nil
	}

	ws, err := d.Settings.Get(ctx)
	if err != nil {
		return res, fmt.Errorf("commitment migration: settings: %w", err)
	}
	inv, err := loadInventory(ctx, d.DB)
	if err != nil {
		return res, err
	}
	target := findTarget(inv, ws.CommitmentsProjectID)
	opt := options{ProjectName: defaultProjectName, Prefix: defaultProjectPrefix, Workstream: "Delivery", AlsoAttach: map[string]string{}}
	if target != nil {
		opt.TargetID = target.ID
		opt.ProjectName, opt.Prefix = target.Name, target.TaskIDPrefix
	}
	p := buildPlan(inv, opt)
	res.Issues = p.Issues
	res.TargetPrefix = opt.Prefix

	if len(p.Commitments) == 0 {
		res.Skipped = "no commitments outside the Commitments project"
		if mode == ModeAuto {
			if target != nil {
				if tid, err := uuid.Parse(target.ID); err == nil {
					retireCommitmentTypes(ctx, d, tid)
				}
			}
			if err := markDone(ctx, d.DB); err != nil {
				return res, err
			}
			res.Completed = true
		}
		return res, nil
	}

	logPlan(d.Log, inv, p, opt, mode)
	if mode == ModeDryRun {
		res.Skipped = "dry run"
		return res, nil
	}

	actor, err := adminAccount(ctx, d.DB, d.AdminUsername)
	if err != nil {
		return res, err
	}
	tgt, err := prepareTarget(ctx, d, inv, p, target, actor)
	if err != nil {
		return res, err
	}

	failed := 0
	for _, cp := range p.Commitments {
		moved, err := moveCommitment(ctx, d.DB, inv, tgt, cp)
		if err != nil {
			failed++
			d.Log.ErrorContext(ctx, "commitment migration: could not move commitment; it stays where it is and is retried on the next start",
				"commitment", cp.OldRef, "err", err)
			continue
		}
		res.Moved = append(res.Moved, moved.summary)
		res.Attached += moved.attached
		res.LinksRemoved += moved.linksRemoved
		res.LinksKept += moved.linksKept
		d.Log.InfoContext(ctx, "commitment migration: moved", "from", cp.OldRef, "to", moved.newRef,
			"attached", moved.attached, "links_removed", moved.linksRemoved, "links_kept", moved.linksKept)
	}
	if failed > 0 {
		return res, fmt.Errorf("commitment migration: %d of %d commitments not moved; see errors above", failed, len(p.Commitments))
	}
	retireCommitmentTypes(ctx, d, tgt.ID)
	if err := markDone(ctx, d.DB); err != nil {
		return res, err
	}
	res.Completed = true
	return res, nil
}

// retireCommitmentTypes removes the Commitment task type from every other
// project once its commitments have moved, so new ones can only be made in
// the Commitments project. A type still referenced by any task (a deleted
// one included) or set as a project's default is left alone and logged.
func retireCommitmentTypes(ctx context.Context, d Deps, target uuid.UUID) {
	var rows []struct {
		ID        string `db:"id"`
		ProjectID string `db:"project_id"`
		InUse     bool   `db:"in_use"`
		IsDefault bool   `db:"is_default"`
	}
	if err := d.DB.SelectContext(ctx, &rows, `
		SELECT tt.id, tt.project_id, tt.is_default,
		  EXISTS (SELECT 1 FROM tasks t WHERE t.task_type_id = tt.id) AS in_use
		FROM task_types tt JOIN projects p ON p.id = tt.project_id AND p.deleted_at IS NULL
		WHERE lower(trim(tt.name)) = 'commitment' AND tt.project_id <> $1`, target.String()); err != nil {
		d.Log.WarnContext(ctx, "commitment migration: could not list leftover Commitment types", "err", err)
		return
	}
	removed := 0
	for _, r := range rows {
		if r.InUse || r.IsDefault {
			d.Log.InfoContext(ctx, "commitment migration: kept a Commitment type still in use elsewhere", "project", r.ProjectID, "in_use", r.InUse, "default", r.IsDefault)
			continue
		}
		pid, err1 := uuid.Parse(r.ProjectID)
		tid, err2 := uuid.Parse(r.ID)
		if err1 != nil || err2 != nil {
			continue
		}
		if err := d.Tasks.DeleteTaskType(ctx, pid, tid); err != nil {
			d.Log.WarnContext(ctx, "commitment migration: could not remove a leftover Commitment type", "project", r.ProjectID, "err", err)
			continue
		}
		removed++
	}
	if removed > 0 {
		d.Log.InfoContext(ctx, "commitment migration: removed the Commitment type from other projects", "projects", removed)
	}
}

func markDone(ctx context.Context, db *sqlx.DB) error {
	if _, err := db.ExecContext(ctx, `UPDATE workspace_settings SET commitments_migrated_at = now()`); err != nil {
		return fmt.Errorf("commitment migration: record completion: %w", err)
	}
	return nil
}

// findTarget returns the configured Commitments project, else a live project
// that is plainly meant to be it (prefix COM or named Commitments).
func findTarget(inv *inventory, configured *uuid.UUID) *project {
	if configured != nil {
		if p, ok := inv.Projects[configured.String()]; ok {
			return p
		}
	}
	var byName *project
	for _, p := range inv.Projects {
		if strings.EqualFold(p.TaskIDPrefix, defaultProjectPrefix) {
			return p
		}
		if strings.EqualFold(strings.TrimSpace(p.Name), defaultProjectName) {
			byName = p
		}
	}
	return byName
}

func adminAccount(ctx context.Context, db *sqlx.DB, username string) (uuid.UUID, error) {
	var id string
	err := db.GetContext(ctx, &id, `
		SELECT u.id FROM users u JOIN accounts a ON a.id = u.id
		WHERE u.username = $1 AND a.deleted_at IS NULL`, username)
	if errors.Is(err, sql.ErrNoRows) {
		err = db.GetContext(ctx, &id, `
			SELECT ra.account_id FROM role_attachments ra
			JOIN roles r ON r.id = ra.role_id
			JOIN accounts a ON a.id = ra.account_id AND a.kind = 'user' AND a.deleted_at IS NULL
			WHERE ra.project_id IS NULL AND r.name = 'SUPER_ADMIN'
			ORDER BY a.created_at LIMIT 1`)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("commitment migration: find an admin account to act as: %w", err)
	}
	return uuid.Parse(id)
}

func logPlan(log *slog.Logger, inv *inventory, p *plan, opt options, mode string) {
	attach := 0
	for _, cp := range p.Commitments {
		attach += len(cp.Attach)
		refs := make([]string, 0, len(cp.Attach))
		for _, a := range cp.Attach {
			refs = append(refs, a.Ref)
		}
		log.Info("commitment migration: plan", "mode", mode, "commitment", cp.OldRef,
			"from_project", inv.Projects[cp.Old.ProjectID].Name, "status", cp.Status.Name, "attach", strings.Join(refs, ","))
	}
	log.Info("commitment migration: plan summary", "mode", mode, "target", opt.Prefix,
		"commitments", len(p.Commitments), "tickets_to_attach", attach, "issues", len(p.Issues))
	for _, i := range p.Issues {
		log.Warn("commitment migration: left as it is", "issue", i)
	}
}

// --- target project -----------------------------------------------------------

type targetProject struct {
	ID             uuid.UUID
	Prefix         string
	CommitmentType uuid.UUID
	StatusByKey    map[string]uuid.UUID // lower(name)|category -> id
	MemberBy       map[string]uuid.UUID // account id -> member id
}

func statusKey(name, category string) string {
	return strings.ToLower(strings.TrimSpace(name)) + "|" + category
}

// prepareTarget creates or completes the Commitments project through the
// services, so roles, schema events and caches are handled exactly as for a
// person doing it.
func prepareTarget(ctx context.Context, d Deps, inv *inventory, p *plan, existing *project, actor uuid.UUID) (*targetProject, error) {
	var projectID uuid.UUID
	var prefix string
	if existing != nil {
		projectID, _ = uuid.Parse(existing.ID)
		prefix = existing.TaskIDPrefix
	} else {
		created, err := d.Projects.Create(ctx, projectdom.CreateProjectInput{
			Name:         defaultProjectName,
			TaskIDPrefix: defaultProjectPrefix,
			Description:  "Every commitment lives here. Each one names the project it is for, and tickets in any project attach to it through their Commitment field.",
			Settings:     map[string]any{"default_workstream": "delivery"},
			CreatedBy:    &actor,
		})
		if err != nil {
			return nil, fmt.Errorf("commitment migration: create the Commitments project: %w", err)
		}
		projectID, prefix = created.ID, created.TaskIDPrefix
		d.Log.InfoContext(ctx, "commitment migration: created the Commitments project", "prefix", prefix)
	}

	// Designate it; this also leaves it with only a default Commitment type.
	if _, err := d.Settings.SetCommitmentsProject(ctx, &projectID, actor); err != nil {
		return nil, fmt.Errorf("commitment migration: designate the Commitments project: %w", err)
	}
	t := &targetProject{ID: projectID, Prefix: prefix, StatusByKey: map[string]uuid.UUID{}, MemberBy: map[string]uuid.UUID{}}

	types, err := d.Tasks.ListTaskTypes(ctx, projectID)
	if err != nil {
		return nil, err
	}
	for _, ty := range types {
		if isCommitmentType(ty.Name) {
			t.CommitmentType = ty.ID
		}
	}
	if t.CommitmentType == uuid.Nil {
		return nil, errors.New("commitment migration: the Commitments project has no Commitment type")
	}

	statuses, err := d.Tasks.ListTaskStatuses(ctx, projectID)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	maxPos := 0
	for _, s := range statuses {
		t.StatusByKey[statusKey(s.Name, string(s.Category))] = s.ID
		names[strings.ToLower(strings.TrimSpace(s.Name))] = true
		if s.Position > maxPos {
			maxPos = s.Position
		}
	}
	for _, want := range p.Statuses {
		key := statusKey(want.Name, want.Category)
		if _, ok := t.StatusByKey[key]; ok {
			continue
		}
		// Same name, different category elsewhere: keep both apart, because
		// the category decides whether the commitment counts as delivered.
		name := want.Name
		if names[strings.ToLower(name)] {
			name = fmt.Sprintf("%s (%s)", want.Name, want.Category)
		}
		maxPos++
		created, err := d.Tasks.CreateTaskStatus(ctx, taskdom.CreateTaskStatusInput{
			ProjectID: projectID, Name: name, Color: want.Color, Position: maxPos, Category: taskdom.StatusCategory(want.Category),
		})
		if err != nil {
			return nil, fmt.Errorf("commitment migration: create status %q: %w", name, err)
		}
		t.StatusByKey[key] = created.ID
		names[strings.ToLower(name)] = true
	}

	defs, err := d.Tasks.ListCustomFieldDefinitions(ctx, projectID)
	if err != nil {
		return nil, err
	}
	have := map[string]*taskdom.CustomFieldDefinition{}
	for _, f := range defs {
		have[f.FieldKey] = f
	}
	for _, f := range p.Fields {
		opts := make([]taskdom.CustomFieldOption, 0, len(f.Options))
		for _, o := range f.Options {
			opts = append(opts, taskdom.CustomFieldOption{Value: o.Value, Color: o.Color})
		}
		existing, ok := have[f.FieldKey]
		if !ok {
			if _, err := d.Tasks.CreateCustomFieldDefinition(ctx, taskdom.CreateCustomFieldDefinitionInput{
				ProjectID: projectID, FieldKey: f.FieldKey, DisplayName: f.DisplayName,
				FieldType: taskdom.FieldType(f.FieldType), Options: opts,
			}); err != nil {
				return nil, fmt.Errorf("commitment migration: create field %q: %w", f.FieldKey, err)
			}
			continue
		}
		// An existing select field gains the options the commitments use.
		merged, changed := mergeOptions(existing.Options, opts)
		if changed {
			if _, err := d.Tasks.UpdateCustomFieldDefinition(ctx, projectID, existing.ID, taskdom.UpdateCustomFieldDefinitionInput{Options: merged}); err != nil {
				return nil, fmt.Errorf("commitment migration: extend field %q: %w", f.FieldKey, err)
			}
		}
	}

	// Members: everyone who owns or reported a commitment keeps access to it.
	if err := loadTargetMembers(ctx, d.DB, t); err != nil {
		return nil, err
	}
	role, err := editorRole(ctx, d.DB, projectID)
	if err != nil {
		return nil, err
	}
	for _, o := range p.Owners {
		if _, ok := t.MemberBy[o.UserID]; ok {
			continue
		}
		accountID, err := uuid.Parse(o.UserID)
		if err != nil {
			continue
		}
		in := projectdom.AddMemberInput{RoleIDs: []uuid.UUID{role}}
		if o.MemberType == "agent" {
			in.AgentID = &accountID
		} else {
			in.UserID = accountID
		}
		if _, err := d.Projects.AddMember(ctx, projectID, in); err != nil {
			d.Log.WarnContext(ctx, "commitment migration: could not add a commitment owner to the Commitments project", "account", o.FullName, "err", err)
		}
	}
	if err := loadTargetMembers(ctx, d.DB, t); err != nil {
		return nil, err
	}
	return t, nil
}

func mergeOptions(have, want []taskdom.CustomFieldOption) ([]taskdom.CustomFieldOption, bool) {
	out := append([]taskdom.CustomFieldOption(nil), have...)
	seen := map[string]bool{}
	for _, o := range have {
		seen[strings.ToLower(strings.TrimSpace(o.Value))] = true
	}
	changed := false
	for _, o := range want {
		if !seen[strings.ToLower(strings.TrimSpace(o.Value))] {
			out = append(out, o)
			seen[strings.ToLower(strings.TrimSpace(o.Value))] = true
			changed = true
		}
	}
	return out, changed
}

func loadTargetMembers(ctx context.Context, db *sqlx.DB, t *targetProject) error {
	rows := []struct {
		ID        string `db:"id"`
		AccountID string `db:"account_id"`
	}{}
	if err := db.SelectContext(ctx, &rows, `SELECT id, account_id FROM project_members WHERE project_id = $1 AND deleted_at IS NULL`, t.ID.String()); err != nil {
		return fmt.Errorf("commitment migration: members: %w", err)
	}
	for _, r := range rows {
		if id, err := uuid.Parse(r.ID); err == nil {
			t.MemberBy[r.AccountID] = id
		}
	}
	return nil
}

func editorRole(ctx context.Context, db *sqlx.DB, projectID uuid.UUID) (uuid.UUID, error) {
	var id string
	err := db.GetContext(ctx, &id, `
		SELECT id FROM roles WHERE project_id = $1
		ORDER BY CASE lower(name) WHEN 'editor' THEN 0 WHEN 'member' THEN 1 WHEN 'admin' THEN 3 ELSE 2 END, name
		LIMIT 1`, projectID.String())
	if err != nil {
		return uuid.Nil, fmt.Errorf("commitment migration: find a role for commitment owners: %w", err)
	}
	return uuid.Parse(id)
}

// --- moving one commitment -------------------------------------------------------

type moveResult struct {
	newRef       string
	summary      string
	attached     int
	linksRemoved int
	linksKept    int
}

var workstreamLabel = map[string]string{"delivery": "Delivery", "platform": "PPE", "internal": "Internal"}

// moveCommitment moves one commitment and attaches its work in a single
// transaction: either all of it happens or none of it does.
func moveCommitment(ctx context.Context, db *sqlx.DB, inv *inventory, t *targetProject, cp commitmentPlan) (*moveResult, error) {
	old := cp.Old
	statusID, ok := t.StatusByKey[statusKey(cp.Status.Name, cp.Status.Category)]
	if !ok {
		return nil, fmt.Errorf("no status %q (%s) in the Commitments project", cp.Status.Name, cp.Status.Category)
	}
	source := inv.Projects[old.ProjectID]

	tx, err := db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var current struct {
		ProjectID string     `db:"project_id"`
		DeletedAt *time.Time `db:"deleted_at"`
	}
	if err := tx.GetContext(ctx, &current, `SELECT project_id, deleted_at FROM tasks WHERE id = $1 FOR UPDATE`, old.ID); err != nil {
		return nil, fmt.Errorf("lock: %w", err)
	}
	if current.DeletedAt != nil || current.ProjectID != old.ProjectID {
		return nil, errors.New("changed since the plan was made (moved or deleted); re-planned on the next start")
	}

	var number int64
	if err := tx.GetContext(ctx, &number, `
		INSERT INTO task_counters (project_id, last_value) VALUES ($1, 1)
		ON CONFLICT (project_id) DO UPDATE SET last_value = task_counters.last_value + 1
		RETURNING last_value`, t.ID.String()); err != nil {
		return nil, fmt.Errorf("next number: %w", err)
	}

	// Members are per project: map assignees and reporter to the same
	// accounts' memberships in the Commitments project.
	memberAccount := map[string]string{}
	for _, m := range inv.Members[old.ProjectID] {
		memberAccount[m.ID] = m.UserID
	}
	mapMember := func(id string) *uuid.UUID {
		if acc, ok := memberAccount[id]; ok {
			if nm, ok := t.MemberBy[acc]; ok {
				return &nm
			}
		}
		return nil
	}
	var reporter *string
	if old.ReporterID != nil {
		if nm := mapMember(*old.ReporterID); nm != nil {
			s := nm.String()
			reporter = &s
		}
	}

	fields := map[string]any{}
	for k, v := range old.CustomFields {
		fields[k] = v
	}
	if s, _ := fields["workstream"].(string); strings.TrimSpace(s) == "" {
		label := "Delivery"
		if source != nil {
			if dw, _ := source.Settings["default_workstream"].(string); workstreamLabel[dw] != "" {
				label = workstreamLabel[dw]
			}
		}
		fields["workstream"] = label
	}
	cf, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE tasks SET project_id = $1, task_number = $2, task_type_id = $3, status_id = $4,
		  sprint_id = NULL, parent_task_id = NULL, commitment_task_id = NULL,
		  home_project_id = $5, custom_fields = $6, reporter_id = $7, updated_at = now()
		WHERE id = $8`,
		t.ID.String(), number, t.CommitmentType.String(), statusID.String(),
		old.ProjectID, string(cf), reporter, old.ID); err != nil {
		return nil, fmt.Errorf("move: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM task_assignees WHERE task_id = $1`, old.ID); err != nil {
		return nil, fmt.Errorf("assignees: %w", err)
	}
	for _, mid := range old.AssigneeIDs {
		if nm := mapMember(mid); nm != nil {
			if _, err := tx.ExecContext(ctx, `INSERT INTO task_assignees (task_id, member_id, assigned_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, old.ID, nm.String()); err != nil {
				return nil, fmt.Errorf("assignee: %w", err)
			}
		}
	}
	// Rows that file the task under its project follow it; view positions
	// belong to the old project's views and are dropped.
	for _, q := range []string{
		`UPDATE activities SET project_id = $1 WHERE entity_type = 'task' AND entity_id = $2`,
		`UPDATE notifications SET project_id = $1 WHERE task_id = $2`,
		`UPDATE agent_conversations SET project_id = $1 WHERE task_id = $2`,
		`UPDATE page_annotations SET project_id = $1 WHERE task_id = $2`,
	} {
		if _, err := tx.ExecContext(ctx, q, t.ID.String(), old.ID); err != nil {
			return nil, fmt.Errorf("follow-up rows: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM view_task_positions WHERE task_id = $1`, old.ID); err != nil {
		return nil, fmt.Errorf("view positions: %w", err)
	}

	r := &moveResult{newRef: fmt.Sprintf("%s-%d", t.Prefix, number)}
	attached := map[string]bool{}
	for _, a := range cp.Attach {
		res, err := tx.ExecContext(ctx, `
			UPDATE tasks SET commitment_task_id = $1,
			  parent_task_id = CASE WHEN $3 THEN NULL ELSE parent_task_id END, updated_at = now()
			WHERE id = $2 AND deleted_at IS NULL AND (commitment_task_id IS NULL OR commitment_task_id = $1)`,
			old.ID, a.Task.ID, a.DetachFirst)
		if err != nil {
			return nil, fmt.Errorf("attach %s: %w", a.Ref, err)
		}
		if n, _ := res.RowsAffected(); n == 1 {
			attached[a.Task.ID] = true
			r.attached++
		}
	}

	// A link goes only when it is fully replaced: its ticket is now attached,
	// or the ticket's top-level ancestor is. Anything else (a ticket linked to
	// two commitments, a child of work that belongs elsewhere) keeps its link.
	for _, l := range cp.RemoveLinks {
		other := l.SourceTaskID
		if other == old.ID {
			other = l.TargetTaskID
		}
		ticket := inv.Tasks[other]
		replaced := ticket != nil && (attached[ticket.ID] || attached[topLevel(inv, ticket).ID])
		if !replaced {
			r.linksKept++
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM task_links WHERE id = $1`, l.ID); err != nil {
			return nil, fmt.Errorf("remove link: %w", err)
		}
		r.linksRemoved++
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	r.summary = fmt.Sprintf("%s -> %s", cp.OldRef, r.newRef)
	return r, nil
}

// --- reading the workspace -------------------------------------------------------

func loadInventory(ctx context.Context, db *sqlx.DB) (*inventory, error) {
	inv := &inventory{
		Projects: map[string]*project{},
		Types:    map[string]map[string]taskType{},
		Statuses: map[string]map[string]taskStatus{},
		Fields:   map[string][]customField{},
		Members:  map[string][]member{},
		Tasks:    map[string]*task{},
		Comments: map[string][]activity{},
	}
	var projects []struct {
		ID       string          `db:"id"`
		Name     string          `db:"name"`
		Prefix   string          `db:"task_id_prefix"`
		Settings json.RawMessage `db:"settings"`
	}
	if err := db.SelectContext(ctx, &projects, `SELECT id, name, task_id_prefix, COALESCE(settings, '{}'::jsonb) AS settings FROM projects WHERE deleted_at IS NULL`); err != nil {
		return nil, fmt.Errorf("commitment migration: projects: %w", err)
	}
	for _, p := range projects {
		settings := map[string]any{}
		_ = json.Unmarshal(p.Settings, &settings)
		inv.Projects[p.ID] = &project{ID: p.ID, Name: p.Name, TaskIDPrefix: p.Prefix, Settings: settings}
		inv.Types[p.ID] = map[string]taskType{}
		inv.Statuses[p.ID] = map[string]taskStatus{}
	}

	var types []struct {
		ID        string `db:"id"`
		ProjectID string `db:"project_id"`
		Name      string `db:"name"`
		IsDefault bool   `db:"is_default"`
	}
	if err := db.SelectContext(ctx, &types, `SELECT id, project_id, name, is_default FROM task_types`); err != nil {
		return nil, fmt.Errorf("commitment migration: task types: %w", err)
	}
	for _, t := range types {
		if m, ok := inv.Types[t.ProjectID]; ok {
			m[t.ID] = taskType{ID: t.ID, Name: t.Name, IsDefault: t.IsDefault}
		}
	}

	var statuses []struct {
		ID        string  `db:"id"`
		ProjectID string  `db:"project_id"`
		Name      string  `db:"name"`
		Category  string  `db:"category"`
		Color     *string `db:"color"`
		Position  int     `db:"position"`
	}
	if err := db.SelectContext(ctx, &statuses, `SELECT id, project_id, name, category, color, position FROM task_statuses`); err != nil {
		return nil, fmt.Errorf("commitment migration: statuses: %w", err)
	}
	for _, s := range statuses {
		if m, ok := inv.Statuses[s.ProjectID]; ok {
			m[s.ID] = taskStatus{ID: s.ID, Name: s.Name, Category: s.Category, Color: s.Color, Position: s.Position}
		}
	}

	var fields []struct {
		ID          string          `db:"id"`
		ProjectID   string          `db:"project_id"`
		FieldKey    string          `db:"field_key"`
		DisplayName string          `db:"display_name"`
		FieldType   string          `db:"field_type"`
		Options     json.RawMessage `db:"options"`
		IsRequired  bool            `db:"is_required"`
	}
	if err := db.SelectContext(ctx, &fields, `SELECT id, project_id, field_key, display_name, field_type, COALESCE(options, '[]'::jsonb) AS options, is_required FROM custom_field_definitions`); err != nil {
		return nil, fmt.Errorf("commitment migration: custom fields: %w", err)
	}
	for _, f := range fields {
		if _, ok := inv.Projects[f.ProjectID]; !ok {
			continue
		}
		var opts []fieldOption
		_ = json.Unmarshal(f.Options, &opts)
		inv.Fields[f.ProjectID] = append(inv.Fields[f.ProjectID], customField{ID: f.ID, FieldKey: f.FieldKey, DisplayName: f.DisplayName, FieldType: f.FieldType, Options: opts, IsRequired: f.IsRequired})
	}

	var members []struct {
		ID        string `db:"id"`
		ProjectID string `db:"project_id"`
		AccountID string `db:"account_id"`
		Kind      string `db:"kind"`
		Name      string `db:"name"`
	}
	if err := db.SelectContext(ctx, &members, `
		SELECT pm.id, pm.project_id, pm.account_id, a.kind, a.name
		FROM project_members pm JOIN accounts a ON a.id = pm.account_id
		WHERE pm.deleted_at IS NULL AND a.deleted_at IS NULL`); err != nil {
		return nil, fmt.Errorf("commitment migration: members: %w", err)
	}
	for _, m := range members {
		inv.Members[m.ProjectID] = append(inv.Members[m.ProjectID], member{ID: m.ID, UserID: m.AccountID, FullName: m.Name, MemberType: m.Kind})
	}

	var tasks []struct {
		ID               string          `db:"id"`
		ProjectID        string          `db:"project_id"`
		TaskNumber       int64           `db:"task_number"`
		Title            string          `db:"title"`
		TaskTypeID       *string         `db:"task_type_id"`
		StatusID         *string         `db:"status_id"`
		ParentTaskID     *string         `db:"parent_task_id"`
		CommitmentTaskID *string         `db:"commitment_task_id"`
		ReporterID       *string         `db:"reporter_id"`
		CustomFields     json.RawMessage `db:"custom_fields"`
		CreatedAt        time.Time       `db:"created_at"`
		Assignees        json.RawMessage `db:"assignees"`
	}
	if err := db.SelectContext(ctx, &tasks, `
		SELECT t.id, t.project_id, t.task_number, t.title, t.task_type_id, t.status_id, t.parent_task_id,
		  t.commitment_task_id, t.reporter_id, COALESCE(t.custom_fields, '{}'::jsonb) AS custom_fields, t.created_at,
		  COALESCE((SELECT jsonb_agg(ta.member_id) FROM task_assignees ta WHERE ta.task_id = t.id), '[]'::jsonb) AS assignees
		FROM tasks t JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
		WHERE t.deleted_at IS NULL`); err != nil {
		return nil, fmt.Errorf("commitment migration: tasks: %w", err)
	}
	for _, r := range tasks {
		t := &task{ID: r.ID, ProjectID: r.ProjectID, TaskNumber: r.TaskNumber, Title: r.Title, TaskTypeID: r.TaskTypeID,
			StatusID: r.StatusID, ParentTaskID: r.ParentTaskID, CommitmentTaskID: r.CommitmentTaskID, ReporterID: r.ReporterID, CreatedAt: r.CreatedAt}
		_ = json.Unmarshal(r.CustomFields, &t.CustomFields)
		_ = json.Unmarshal(r.Assignees, &t.AssigneeIDs)
		inv.Tasks[t.ID] = t
	}

	var links []taskLink
	if err := db.SelectContext(ctx, &links, `
		SELECT id, source_task_id, target_task_id, link_type FROM task_links WHERE link_type = 'relates_to'`); err != nil {
		return nil, fmt.Errorf("commitment migration: links: %w", err)
	}
	inv.Links = links
	return inv, nil
}
