package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	gitdom "github.com/Paca-AI/api/internal/domain/git"
)

// ── comment index ────────────────────────────────────────────────────────────

type gitIndexedCommentRecord struct {
	RepositoryID   string    `db:"repository_id"`
	CommentID      string    `db:"comment_id"`
	SubjectKind    string    `db:"subject_kind"`
	SubjectNumber  string    `db:"subject_number"`
	ThreadID       string    `db:"thread_id"`
	AgentID        *string   `db:"agent_id"`
	ConversationID *string   `db:"conversation_id"`
	CreatedAt      time.Time `db:"created_at"`
}

const gitIndexedCols = `repository_id, comment_id, subject_kind, subject_number, thread_id, agent_id, conversation_id, created_at`

func (r gitIndexedCommentRecord) domain() *gitdom.IndexedComment {
	rid, _ := uuid.Parse(r.RepositoryID)
	return &gitdom.IndexedComment{RepositoryID: rid, CommentID: r.CommentID, SubjectKind: r.SubjectKind, SubjectNumber: r.SubjectNumber,
		ThreadID: r.ThreadID, AgentID: parseUUIDPtr(r.AgentID), ConversationID: parseUUIDPtr(r.ConversationID), CreatedAt: r.CreatedAt}
}

// IndexComment records a comment Paca posted. Indexing the same comment twice is a no-op.
func (s *GitRepository) IndexComment(ctx context.Context, c *gitdom.IndexedComment) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO git_comment_index (repository_id, comment_id, subject_kind, subject_number, thread_id, agent_id, conversation_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (repository_id, comment_id) DO NOTHING`,
		c.RepositoryID.String(), c.CommentID, c.SubjectKind, c.SubjectNumber, c.ThreadID,
		uuidPtrString(c.AgentID), uuidPtrString(c.ConversationID))
	if err != nil {
		return fmt.Errorf("git repo: index comment: %w", err)
	}
	return nil
}

// FindIndexedComment returns the index entry for a comment id.
func (s *GitRepository) FindIndexedComment(ctx context.Context, repositoryID uuid.UUID, commentID string) (*gitdom.IndexedComment, error) {
	var rec gitIndexedCommentRecord
	if err := s.db.GetContext(ctx, &rec, `SELECT `+gitIndexedCols+` FROM git_comment_index WHERE repository_id = $1 AND comment_id = $2`,
		repositoryID.String(), commentID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, gitdom.ErrNotFound
		}
		return nil, fmt.Errorf("git repo: find indexed comment: %w", err)
	}
	return rec.domain(), nil
}

// LatestIndexedForSubject returns the newest comment Paca posted on a subject.
func (s *GitRepository) LatestIndexedForSubject(ctx context.Context, repositoryID uuid.UUID, subjectKind, number string) (*gitdom.IndexedComment, error) {
	var rec gitIndexedCommentRecord
	if err := s.db.GetContext(ctx, &rec, `SELECT `+gitIndexedCols+` FROM git_comment_index
		WHERE repository_id = $1 AND subject_kind = $2 AND subject_number = $3 AND agent_id IS NOT NULL
		ORDER BY created_at DESC LIMIT 1`, repositoryID.String(), subjectKind, number); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, gitdom.ErrNotFound
		}
		return nil, fmt.Errorf("git repo: latest indexed comment: %w", err)
	}
	return rec.domain(), nil
}

// ── settings and triggers ────────────────────────────────────────────────────

// GetProjectSettings returns a project's Git workflow settings, or the defaults.
func (s *GitRepository) GetProjectSettings(ctx context.Context, projectID uuid.UUID) (*gitdom.ProjectSettings, error) {
	var rec struct {
		Responder *string   `db:"default_responder_agent_id"`
		Paused    bool      `db:"paused"`
		MinActor  string    `db:"min_actor_permission"`
		UpdatedAt time.Time `db:"updated_at"`
	}
	err := s.db.GetContext(ctx, &rec, `SELECT default_responder_agent_id, paused, min_actor_permission, updated_at
		FROM git_project_settings WHERE project_id = $1`, projectID.String())
	if errors.Is(err, sql.ErrNoRows) {
		return &gitdom.ProjectSettings{ProjectID: projectID, MinActorPermission: gitdom.DefaultMinActorPermission}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("git repo: get project settings: %w", err)
	}
	return &gitdom.ProjectSettings{ProjectID: projectID, DefaultResponderAgentID: parseUUIDPtr(rec.Responder),
		Paused: rec.Paused, MinActorPermission: rec.MinActor, UpdatedAt: rec.UpdatedAt}, nil
}

// UpsertProjectSettings stores a project's Git workflow settings.
func (s *GitRepository) UpsertProjectSettings(ctx context.Context, st *gitdom.ProjectSettings) error {
	min := st.MinActorPermission
	if min == "" {
		min = gitdom.DefaultMinActorPermission
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO git_project_settings (project_id, default_responder_agent_id, paused, min_actor_permission)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (project_id) DO UPDATE SET default_responder_agent_id = EXCLUDED.default_responder_agent_id,
			paused = EXCLUDED.paused, min_actor_permission = EXCLUDED.min_actor_permission, updated_at = NOW()`,
		st.ProjectID.String(), uuidPtrString(st.DefaultResponderAgentID), st.Paused, min)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		// The service already checked the responder is one of the project's
		// agents, so a foreign-key miss here means the project does not exist.
		return gitdom.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("git repo: upsert project settings: %w", err)
	}
	return nil
}

// ListAgentTriggers returns the agent's explicit trigger settings.
func (s *GitRepository) ListAgentTriggers(ctx context.Context, agentID uuid.UUID) ([]*gitdom.AgentTrigger, error) {
	var recs []struct {
		Kind    string          `db:"kind"`
		Enabled bool            `db:"enabled"`
		Config  json.RawMessage `db:"config"`
	}
	if err := s.db.SelectContext(ctx, &recs, `SELECT kind, enabled, config FROM git_agent_triggers WHERE agent_id = $1 ORDER BY kind`, agentID.String()); err != nil {
		return nil, fmt.Errorf("git repo: list agent triggers: %w", err)
	}
	out := make([]*gitdom.AgentTrigger, 0, len(recs))
	for _, r := range recs {
		out = append(out, &gitdom.AgentTrigger{AgentID: agentID, Kind: gitdom.TriggerKind(r.Kind), Enabled: r.Enabled, Config: r.Config})
	}
	return out, nil
}

// UpsertAgentTrigger stores one agent trigger setting.
func (s *GitRepository) UpsertAgentTrigger(ctx context.Context, t *gitdom.AgentTrigger) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO git_agent_triggers (agent_id, kind, enabled, config) VALUES ($1,$2,$3,$4::jsonb)
		ON CONFLICT (agent_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config`,
		t.AgentID.String(), string(t.Kind), t.Enabled, string(jsonOrEmpty(t.Config)))
	if err != nil {
		return fmt.Errorf("git repo: upsert agent trigger: %w", err)
	}
	return nil
}

// ── routing ──────────────────────────────────────────────────────────────────

// claimStale is how long a claimed event may sit unfinished before another
// worker takes it over (the first worker crashed).
const claimStale = "5 minutes"

// ClaimInboxEvents hands out events still to route, oldest first.
func (s *GitRepository) ClaimInboxEvents(ctx context.Context, limit int, minAge time.Duration) ([]*gitdom.InboxEvent, error) {
	var recs []struct {
		EventID      string          `db:"event_id"`
		RepositoryID string          `db:"repository_id"`
		EndpointKey  string          `db:"endpoint_key"`
		Kind         string          `db:"kind"`
		Action       string          `db:"action"`
		Payload      json.RawMessage `db:"payload"`
		ReceivedAt   time.Time       `db:"received_at"`
	}
	err := s.db.SelectContext(ctx, &recs, `
		UPDATE git_event_inbox SET processed_at = NOW()
		WHERE (event_id, repository_id) IN (
			SELECT event_id, repository_id FROM git_event_inbox
			WHERE status = 'received' AND (processed_at IS NULL OR processed_at < NOW() - INTERVAL '`+claimStale+`')
				AND received_at <= NOW() - make_interval(secs => $2)
			ORDER BY received_at LIMIT $1 FOR UPDATE SKIP LOCKED)
		RETURNING event_id, repository_id, endpoint_key, kind, action, payload, received_at`, limit, minAge.Seconds())
	if err != nil {
		return nil, fmt.Errorf("git repo: claim inbox events: %w", err)
	}
	out := make([]*gitdom.InboxEvent, 0, len(recs))
	for _, r := range recs {
		rid, _ := uuid.Parse(r.RepositoryID)
		out = append(out, &gitdom.InboxEvent{EventID: r.EventID, RepositoryID: rid, EndpointKey: r.EndpointKey, Kind: r.Kind,
			Action: r.Action, Payload: r.Payload, Status: gitdom.InboxReceived, ReceivedAt: r.ReceivedAt})
	}
	// UPDATE ... RETURNING has no defined order; routing wants oldest first.
	sort.SliceStable(out, func(i, j int) bool { return out[i].ReceivedAt.Before(out[j].ReceivedAt) })
	return out, nil
}

// FinishInboxEvent records how an event was routed.
func (s *GitRepository) FinishInboxEvent(ctx context.Context, eventID string, repositoryID uuid.UUID, status gitdom.InboxStatus, reason string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE git_event_inbox SET status = $3, reason = $4, processed_at = NOW()
		WHERE event_id = $1 AND repository_id = $2`, eventID, repositoryID.String(), string(status), reason)
	if err != nil {
		return fmt.Errorf("git repo: finish inbox event: %w", err)
	}
	return nil
}

// ReleaseInboxEvent makes a claimed event claimable again after retryAfter.
func (s *GitRepository) ReleaseInboxEvent(ctx context.Context, eventID string, repositoryID uuid.UUID, retryAfter time.Duration) error {
	_, err := s.db.ExecContext(ctx, `UPDATE git_event_inbox
		SET processed_at = NOW() - INTERVAL '`+claimStale+`' + make_interval(secs => $3)
		WHERE event_id = $1 AND repository_id = $2 AND status = 'received'`, eventID, repositoryID.String(), retryAfter.Seconds())
	if err != nil {
		return fmt.Errorf("git repo: release inbox event: %w", err)
	}
	return nil
}

// FindAgentForIdentity returns the agent an agent-scoped identity belongs to.
func (s *GitRepository) FindAgentForIdentity(ctx context.Context, identityID uuid.UUID) (uuid.UUID, bool, error) {
	var id string
	err := s.db.GetContext(ctx, &id, `SELECT agent_id FROM git_agent_identities WHERE identity_id = $1 LIMIT 1`, identityID.String())
	if errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("git repo: find agent for identity: %w", err)
	}
	agent, _ := uuid.Parse(id)
	return agent, true, nil
}

// CountRuns counts the runs of a trigger an agent had on a subject.
func (s *GitRepository) CountRuns(ctx context.Context, repositoryID, agentID uuid.UUID, trigger gitdom.TriggerKind, subjectKind, number string) (int, error) {
	var n int
	if err := s.db.GetContext(ctx, &n, `SELECT count(*) FROM git_runs
		WHERE repository_id = $1 AND agent_id = $2 AND trigger = $3 AND subject_kind = $4 AND subject_number = $5`,
		repositoryID.String(), agentID.String(), string(trigger), subjectKind, number); err != nil {
		return 0, fmt.Errorf("git repo: count runs: %w", err)
	}
	return n, nil
}

type gitRunRecord struct {
	ID             string     `db:"id"`
	EventID        string     `db:"event_id"`
	RepositoryID   string     `db:"repository_id"`
	AgentID        string     `db:"agent_id"`
	Trigger        string     `db:"trigger"`
	SubjectKind    string     `db:"subject_kind"`
	SubjectNumber  string     `db:"subject_number"`
	HeadSHA        string     `db:"head_sha"`
	ConversationID *string    `db:"conversation_id"`
	Status         string     `db:"status"`
	StatusRef      string     `db:"status_ref"`
	CreatedAt      time.Time  `db:"created_at"`
	FinishedAt     *time.Time `db:"finished_at"`
}

const gitRunCols = `id, event_id, repository_id, agent_id, trigger, subject_kind, subject_number, head_sha, conversation_id, status, status_ref, created_at, finished_at`

func (r gitRunRecord) domain() *gitdom.Run {
	id, _ := uuid.Parse(r.ID)
	rid, _ := uuid.Parse(r.RepositoryID)
	aid, _ := uuid.Parse(r.AgentID)
	return &gitdom.Run{ID: id, EventID: r.EventID, RepositoryID: rid, AgentID: aid, Trigger: gitdom.TriggerKind(r.Trigger),
		SubjectKind: r.SubjectKind, SubjectNumber: r.SubjectNumber, HeadSHA: r.HeadSHA, ConversationID: parseUUIDPtr(r.ConversationID),
		Status: gitdom.RunStatus(r.Status), StatusRef: r.StatusRef, CreatedAt: r.CreatedAt, FinishedAt: r.FinishedAt}
}

// CreateRun stores a run unless the event already started one for the agent.
func (s *GitRepository) CreateRun(ctx context.Context, r *gitdom.Run) (bool, error) {
	status := r.Status
	if status == "" {
		status = gitdom.RunRunning
	}
	var rec gitRunRecord
	err := s.db.GetContext(ctx, &rec, `
		INSERT INTO git_runs (event_id, repository_id, agent_id, trigger, subject_kind, subject_number, head_sha, conversation_id, status, status_ref)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (event_id, repository_id, agent_id) DO NOTHING
		RETURNING `+gitRunCols,
		r.EventID, r.RepositoryID.String(), r.AgentID.String(), string(r.Trigger), r.SubjectKind, r.SubjectNumber, r.HeadSHA,
		uuidPtrString(r.ConversationID), string(status), r.StatusRef)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "uq_git_runs_active_subject" {
		return false, gitdom.ErrRunActive
	}
	if err != nil {
		return false, fmt.Errorf("git repo: create run: %w", err)
	}
	*r = *rec.domain()
	return true, nil
}

// UpdateRun stores a run's conversation, status and status reference.
func (s *GitRepository) UpdateRun(ctx context.Context, r *gitdom.Run) error {
	var finished any
	if !r.Status.Active() {
		finished = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, `UPDATE git_runs SET conversation_id = $2, status = $3, status_ref = $4,
		finished_at = COALESCE(finished_at, $5) WHERE id = $1`,
		r.ID.String(), uuidPtrString(r.ConversationID), string(r.Status), r.StatusRef, finished)
	if err != nil {
		return fmt.Errorf("git repo: update run: %w", err)
	}
	return nil
}

// ListActiveRuns returns every unfinished run.
func (s *GitRepository) ListActiveRuns(ctx context.Context) ([]*gitdom.Run, error) {
	var recs []gitRunRecord
	if err := s.db.SelectContext(ctx, &recs, `SELECT `+gitRunCols+` FROM git_runs WHERE status IN ('queued','running') ORDER BY created_at`); err != nil {
		return nil, fmt.Errorf("git repo: list active runs: %w", err)
	}
	out := make([]*gitdom.Run, 0, len(recs))
	for _, r := range recs {
		out = append(out, r.domain())
	}
	return out, nil
}

// FindActiveRunForSubject finds an unfinished run of the agent on a subject.
func (s *GitRepository) FindActiveRunForSubject(ctx context.Context, repositoryID, agentID uuid.UUID, subjectKind, number string) (*gitdom.Run, error) {
	var rec gitRunRecord
	if err := s.db.GetContext(ctx, &rec, `SELECT `+gitRunCols+` FROM git_runs
		WHERE repository_id = $1 AND agent_id = $2 AND subject_kind = $3 AND subject_number = $4 AND status IN ('queued','running')
		ORDER BY created_at DESC LIMIT 1`, repositoryID.String(), agentID.String(), subjectKind, number); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, gitdom.ErrNotFound
		}
		return nil, fmt.Errorf("git repo: find active run: %w", err)
	}
	return rec.domain(), nil
}

// ListProjectRuns returns a project's most recent runs, newest first.
func (s *GitRepository) ListProjectRuns(ctx context.Context, projectID uuid.UUID, limit int) ([]*gitdom.ProjectRun, error) {
	var recs []struct {
		gitRunRecord
		FullPath string `db:"full_path"`
	}
	if err := s.db.SelectContext(ctx, &recs, `
		SELECT r.id, r.event_id, r.repository_id, r.agent_id, r.trigger, r.subject_kind, r.subject_number, r.head_sha,
			r.conversation_id, r.status, r.status_ref, r.created_at, r.finished_at, g.full_path
		FROM git_runs r JOIN git_repositories g ON g.id = r.repository_id
		WHERE g.project_id = $1 ORDER BY r.created_at DESC LIMIT $2`, projectID.String(), limit); err != nil {
		return nil, fmt.Errorf("git repo: list project runs: %w", err)
	}
	out := make([]*gitdom.ProjectRun, 0, len(recs))
	for _, r := range recs {
		out = append(out, &gitdom.ProjectRun{Run: *r.domain(), RepositoryPath: r.FullPath})
	}
	return out, nil
}

// ListTaskGit returns the change requests and branches linked to a task. The
// task must belong to the project, so another project's links never show.
func (s *GitRepository) ListTaskGit(ctx context.Context, projectID, taskID uuid.UUID) (*gitdom.TaskGit, error) {
	var crs []struct {
		gitCRRecord
		FullPath   string `db:"full_path"`
		ProviderID string `db:"provider_id"`
	}
	if err := s.db.SelectContext(ctx, &crs, `
		SELECT c.id, c.repository_id, c.number, c.title, c.state, c.draft, c.head_ref, c.head_sha, c.base_ref, c.author, c.html_url,
			c.merged_at, c.opened_by_agent_id, c.opened_conversation_id, c.created_at, c.updated_at, g.full_path, g.provider_id
		FROM git_task_links l
		JOIN git_change_requests c ON c.id = l.change_request_id
		JOIN git_repositories g ON g.id = c.repository_id
		JOIN tasks t ON t.id = l.task_id
		WHERE l.task_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL AND g.project_id = $2
		ORDER BY c.updated_at DESC`, taskID.String(), projectID.String()); err != nil {
		return nil, fmt.Errorf("git repo: list task change requests: %w", err)
	}
	var brs []struct {
		RepositoryID string `db:"repository_id"`
		Branch       string `db:"branch_name"`
		FullPath     string `db:"full_path"`
		ProviderID   string `db:"provider_id"`
	}
	if err := s.db.SelectContext(ctx, &brs, `
		SELECT b.repository_id, b.branch_name, g.full_path, g.provider_id
		FROM git_task_branches b
		JOIN git_repositories g ON g.id = b.repository_id
		JOIN tasks t ON t.id = b.task_id
		WHERE b.task_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL AND g.project_id = $2
		ORDER BY b.created_at DESC`, taskID.String(), projectID.String()); err != nil {
		return nil, fmt.Errorf("git repo: list task branches: %w", err)
	}
	out := &gitdom.TaskGit{ChangeRequests: []*gitdom.TaskChangeRequest{}, Branches: []*gitdom.TaskBranch{}}
	for _, c := range crs {
		out.ChangeRequests = append(out.ChangeRequests, &gitdom.TaskChangeRequest{ChangeRequest: *c.domain(), RepositoryPath: c.FullPath, ProviderID: c.ProviderID})
	}
	for _, b := range brs {
		rid, _ := uuid.Parse(b.RepositoryID)
		out.Branches = append(out.Branches, &gitdom.TaskBranch{RepositoryID: rid, RepositoryPath: b.FullPath, ProviderID: b.ProviderID, Branch: b.Branch})
	}
	return out, nil
}

// TaskInProject reports whether the task belongs to the project.
func (s *GitRepository) TaskInProject(ctx context.Context, projectID, taskID uuid.UUID) (bool, error) {
	var ok bool
	if err := s.db.GetContext(ctx, &ok, `SELECT EXISTS (SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL)`, taskID.String(), projectID.String()); err != nil {
		return false, fmt.Errorf("git repo: task in project: %w", err)
	}
	return ok, nil
}

// UnlinkTaskFromChangeRequest removes a task's link to a change request.
func (s *GitRepository) UnlinkTaskFromChangeRequest(ctx context.Context, taskID, changeRequestID uuid.UUID) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM git_task_links WHERE task_id = $1 AND change_request_id = $2`, taskID.String(), changeRequestID.String()); err != nil {
		return fmt.Errorf("git repo: unlink change request: %w", err)
	}
	return nil
}

// UnlinkTaskBranch removes a task's link to a branch.
func (s *GitRepository) UnlinkTaskBranch(ctx context.Context, taskID, repositoryID uuid.UUID, branch string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM git_task_branches WHERE task_id = $1 AND repository_id = $2 AND branch_name = $3`,
		taskID.String(), repositoryID.String(), branch); err != nil {
		return fmt.Errorf("git repo: unlink branch: %w", err)
	}
	return nil
}
