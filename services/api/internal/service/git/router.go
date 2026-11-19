package gitsvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	gitdom "github.com/Paca-AI/api/internal/domain/git"
	"github.com/Paca-AI/api/internal/platform/gitprovider"
)

// AgentRef is an agent a project can route events to.
type AgentRef struct {
	ID     uuid.UUID
	Handle string
	Name   string
}

// AgentDirectory is what the router needs to know about agents.
type AgentDirectory interface {
	// ProjectAgents lists the agents available in a project (its own and the
	// global agents invited into it).
	ProjectAgents(ctx context.Context, projectID uuid.UUID) ([]AgentRef, error)
	// ConversationStatus returns a conversation's status (queued, running,
	// paused, finished, failed, stopped).
	ConversationStatus(ctx context.Context, conversationID uuid.UUID) (string, error)
}

// RunStarter starts an agent conversation from a Git event.
type RunStarter interface {
	StartRun(ctx context.Context, projectID, agentID uuid.UUID, message string) (conversationID uuid.UUID, err error)
}

// runStatusPrefix starts the name of the check/status Paca shows for a run.
const runStatusPrefix = "Paca / "

// RouterOptions tunes the router; zero values take the defaults.
type RouterOptions struct {
	Batch         int           // events per pass (20)
	MinAge        time.Duration // an event waits this long so bursts route together (10s)
	DeferDelay    time.Duration // how long a busy agent's event waits before the next try (20s)
	MaxEventAge   time.Duration // an event still waiting after this is dropped (30m)
	CIFailureCap  int           // CI-failure runs per change request and agent (3)
	PermissionTTL time.Duration // how long an actor's permission is remembered (5m)
	RunTimeout    time.Duration // a run with no conversation status after this is failed (6h)
}

func (o RouterOptions) withDefaults() RouterOptions {
	if o.Batch <= 0 {
		o.Batch = 20
	}
	if o.MinAge < 0 {
		o.MinAge = 0
	} else if o.MinAge == 0 {
		o.MinAge = 10 * time.Second
	}
	if o.DeferDelay <= 0 {
		o.DeferDelay = 20 * time.Second
	}
	if o.MaxEventAge <= 0 {
		o.MaxEventAge = 30 * time.Minute
	}
	if o.CIFailureCap <= 0 {
		o.CIFailureCap = 3
	}
	if o.PermissionTTL <= 0 {
		o.PermissionTTL = 5 * time.Minute
	}
	if o.RunTimeout <= 0 {
		o.RunTimeout = 6 * time.Hour
	}
	return o
}

// Router turns received Git events into agent runs (docs/ai-agent/git-agent-workflow.md §7)
// and keeps each run's visible state on the platform current.
type Router struct {
	svc    *Service
	agents AgentDirectory
	runs   RunStarter
	opt    RouterOptions
	log    *slog.Logger

	mu    sync.Mutex
	perms map[permKey]cachedPerm
}

type permKey struct {
	repo  uuid.UUID
	login string
}

type cachedPerm struct {
	perm    gitprovider.Permission
	expires time.Time
}

// NewRouter returns a Router.
func NewRouter(svc *Service, agents AgentDirectory, runs RunStarter, opt RouterOptions, log *slog.Logger) *Router {
	if log == nil {
		log = slog.Default()
	}
	return &Router{svc: svc, agents: agents, runs: runs, opt: opt.withDefaults(), log: log, perms: map[permKey]cachedPerm{}}
}

// Run routes events and finalizes runs until ctx is cancelled.
func (r *Router) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 5 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.safeTick(ctx)
		}
	}
}

func (r *Router) safeTick(ctx context.Context) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("git router panic", "panic", fmt.Sprint(p))
		}
	}()
	r.Tick(ctx)
}

// Tick runs one pass: route the events that are ready, then finalize the runs
// whose conversation ended. It reports how many events it handled.
func (r *Router) Tick(ctx context.Context) int {
	events, err := r.svc.store.ClaimInboxEvents(ctx, r.opt.Batch, r.opt.MinAge)
	if err != nil {
		r.log.Error("git router: claim events", "error", err)
	}
	for _, in := range events {
		r.process(ctx, in)
	}
	r.finalize(ctx)
	return len(events)
}

// ── routing ──────────────────────────────────────────────────────────────────

type decision struct {
	agent   AgentRef
	trigger gitdom.TriggerKind
}

// outcome is how one event ended up.
type outcome struct {
	started  int
	deferred bool
	ignored  []string
	failed   []string
}

func (o *outcome) ignore(format string, args ...any) {
	o.ignored = append(o.ignored, fmt.Sprintf(format, args...))
}

func (r *Router) process(ctx context.Context, in *gitdom.InboxEvent) {
	finish := func(st gitdom.InboxStatus, reason string) {
		if err := r.svc.store.FinishInboxEvent(ctx, in.EventID, in.RepositoryID, st, truncate(reason, 400)); err != nil {
			r.log.Error("git router: finish event", "event", in.EventID, "error", err)
		}
	}
	retry := func(err error) {
		r.log.Warn("git router: will retry event", "event", in.EventID, "error", err)
		if time.Since(in.ReceivedAt) > r.opt.MaxEventAge {
			finish(gitdom.InboxFailed, "gave up retrying: "+err.Error())
			return
		}
		_ = r.svc.store.ReleaseInboxEvent(ctx, in.EventID, in.RepositoryID, r.opt.DeferDelay)
	}

	var ev gitprovider.Event
	if err := json.Unmarshal(in.Payload, &ev); err != nil {
		finish(gitdom.InboxFailed, "unreadable event payload")
		return
	}
	repo, err := r.svc.store.FindRepository(ctx, in.RepositoryID)
	if errors.Is(err, gitdom.ErrNotFound) {
		finish(gitdom.InboxIgnored, "repository was unlinked")
		return
	}
	if err != nil {
		retry(err)
		return
	}

	out := &outcome{}
	decs, err := r.decide(ctx, in, repo, &ev, out)
	if err != nil {
		retry(err)
		return
	}
	for _, d := range decs {
		if err := r.launch(ctx, in, repo, &ev, d, out); err != nil {
			if isTransient(err) {
				retry(err)
				return
			}
			out.failed = append(out.failed, fmt.Sprintf("%s: %v", d.agent.Handle, err))
		}
	}
	switch {
	case out.deferred:
		if time.Since(in.ReceivedAt) > r.opt.MaxEventAge {
			finish(gitdom.InboxIgnored, "the agent stayed busy; dropped")
			return
		}
		_ = r.svc.store.ReleaseInboxEvent(ctx, in.EventID, in.RepositoryID, r.opt.DeferDelay)
	case len(out.failed) > 0 && out.started == 0:
		finish(gitdom.InboxFailed, strings.Join(out.failed, "; "))
	case out.started > 0:
		finish(gitdom.InboxRouted, fmt.Sprintf("%d agent run(s) started", out.started))
	default:
		finish(gitdom.InboxIgnored, strings.Join(out.ignored, "; "))
	}
}

func isTransient(err error) bool {
	var pe *gitprovider.Error
	return errors.As(err, &pe) && pe.Retryable()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

var agentHintRE = regexp.MustCompile(`(?i)\bagent:([a-z0-9][a-z0-9_.-]*)`)

// decide works out which agents the event should start, and why not when none.
func (r *Router) decide(ctx context.Context, in *gitdom.InboxEvent, repo *gitdom.Repository, ev *gitprovider.Event, out *outcome) ([]decision, error) {
	settings, err := r.svc.store.GetProjectSettings(ctx, repo.ProjectID)
	if err != nil {
		return nil, err
	}
	if settings.Paused {
		out.ignore("Git automation is paused for this project")
		return nil, nil
	}
	agents, err := r.agents.ProjectAgents(ctx, repo.ProjectID)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]AgentRef, len(agents))
	for _, a := range agents {
		byID[a.ID] = a
	}

	// Loop prevention: bots never start runs, except CI reporting on a pull
	// request an agent owns (a check is a bot by nature).
	if ev.Actor.Kind == gitprovider.ActorBot && ev.Kind != gitprovider.EventCheck {
		out.ignore("event caused by a bot")
		return nil, nil
	}

	var wanted []decision
	add := func(a AgentRef, t gitdom.TriggerKind) { wanted = append(wanted, decision{agent: a, trigger: t}) }

	endpointAgent, err := r.endpointAgent(ctx, in.EndpointKey)
	if err != nil {
		return nil, err
	}

	switch ev.Kind {
	case gitprovider.EventComment, gitprovider.EventReview:
		if ev.Subject == nil {
			out.ignore("event without a subject")
			return nil, nil
		}
		if ev.Kind == gitprovider.EventComment && ev.Action != "created" {
			out.ignore("edited comments do not start runs")
			return nil, nil
		}
		trigger, addressed := addressedTrigger(ev)
		if addressed {
			a, ok, err := r.responder(ctx, repo, ev, settings, byID, agents, endpointAgent)
			if err != nil {
				return nil, err
			}
			if !ok {
				out.ignore("addressed, but the project has no responder agent")
				return nil, nil
			}
			add(a, trigger)
			break
		}
		if ev.Subject.Kind != gitprovider.SubjectChangeRequest {
			out.ignore("not addressed to an agent")
			return nil, nil
		}
		if ev.Kind == gitprovider.EventReview && strings.TrimSpace(ev.Text) == "" {
			out.ignore("empty review body (its inline comments arrive as separate events)")
			return nil, nil
		}
		owner, err := r.crOwner(ctx, repo, ev.Subject.Number, byID)
		if err != nil {
			return nil, err
		}
		if owner == nil {
			out.ignore("not addressed to an agent and not on an agent's pull request")
			return nil, nil
		}
		add(*owner, gitdom.TriggerOwnCRFeedback)

	case gitprovider.EventReviewRequest, gitprovider.EventAssignment:
		if ev.Subject == nil {
			out.ignore("event without a subject")
			return nil, nil
		}
		t := gitdom.TriggerReviewRequest
		if ev.Kind == gitprovider.EventAssignment {
			t = gitdom.TriggerAssignment
		}
		a, ok, err := r.responder(ctx, repo, ev, settings, byID, agents, endpointAgent)
		if err != nil {
			return nil, err
		}
		if !ok {
			out.ignore("no responder agent")
			return nil, nil
		}
		add(a, t)

	case gitprovider.EventLabel:
		if ev.Subject == nil {
			out.ignore("event without a subject")
			return nil, nil
		}
		a, ok, err := r.labelTarget(ctx, repo, ev.Label, settings, byID, agents, endpointAgent)
		if err != nil {
			return nil, err
		}
		if !ok {
			out.ignore("label %q does not name an agent", ev.Label)
			return nil, nil
		}
		add(a, gitdom.TriggerLabel)

	case gitprovider.EventCheck:
		if ev.Check == nil || ev.Check.Conclusion != "failure" {
			out.ignore("check did not fail")
			return nil, nil
		}
		if strings.HasPrefix(ev.Check.Name, runStatusPrefix) {
			// The status Paca itself shows for a run: reacting to its failure
			// would start a run about a failed run, forever.
			out.ignore("check is Paca's own run status")
			return nil, nil
		}
		if ev.Subject == nil || ev.Subject.Kind != gitprovider.SubjectChangeRequest {
			out.ignore("failing check is not on a pull request")
			return nil, nil
		}
		owner, err := r.crOwner(ctx, repo, ev.Subject.Number, byID)
		if err != nil {
			return nil, err
		}
		if owner == nil {
			out.ignore("failing check on a pull request no agent opened")
			return nil, nil
		}
		cr, err := r.svc.store.FindChangeRequest(ctx, repo.ID, ev.Subject.Number)
		if err != nil {
			return nil, err
		}
		if cr.State != "open" {
			out.ignore("pull request is not open")
			return nil, nil
		}
		if cr.HeadSHA != "" && ev.Check.SHA != "" && cr.HeadSHA != ev.Check.SHA {
			out.ignore("check ran on a commit that is no longer the head")
			return nil, nil
		}
		n, err := r.svc.store.CountRuns(ctx, repo.ID, owner.ID, gitdom.TriggerCIFailure, string(gitprovider.SubjectChangeRequest), ev.Subject.Number)
		if err != nil {
			return nil, err
		}
		if n >= r.opt.CIFailureCap {
			out.ignore("CI-failure run cap (%d) reached for this pull request", r.opt.CIFailureCap)
			return nil, nil
		}
		add(*owner, gitdom.TriggerCIFailure)

	case gitprovider.EventChangeRequest:
		if ev.Subject == nil || (ev.Action != "opened" && ev.Action != "ready" && ev.Action != "synchronized") {
			out.ignore("no trigger for change request action %q", ev.Action)
			return nil, nil
		}
		if ev.Subject.Draft && ev.Action != "ready" {
			out.ignore("draft pull requests are not auto-reviewed")
			return nil, nil
		}
		cr, _ := r.svc.store.FindChangeRequest(ctx, repo.ID, ev.Subject.Number)
		for _, a := range agents {
			cfg, on, err := r.triggerConfig(ctx, a.ID, gitdom.TriggerAutoReview)
			if err != nil {
				return nil, err
			}
			if !on || (cr != nil && cr.OpenedByAgentID != nil && *cr.OpenedByAgentID == a.ID) {
				continue
			}
			if !autoReviewMatches(cfg, ev) {
				continue
			}
			add(a, gitdom.TriggerAutoReview)
		}
		if len(wanted) == 0 {
			out.ignore("no agent auto-reviews this pull request")
			return nil, nil
		}

	default:
		out.ignore("no trigger for %s events", ev.Kind)
		return nil, nil
	}

	// Keep only decisions whose trigger the agent has switched on.
	var enabled []decision
	for _, d := range wanted {
		if _, on, err := r.triggerConfig(ctx, d.agent.ID, d.trigger); err != nil {
			return nil, err
		} else if !on {
			out.ignore("%s has the %s trigger switched off", d.agent.Handle, d.trigger)
			continue
		}
		enabled = append(enabled, d)
	}

	// Who may start a run: a person with enough access. CI reporting on an
	// agent's own pull request and a reviewer agent on a same-repository pull
	// request are exempt; a fork's author is not.
	var permitted []decision
	for _, d := range enabled {
		need := gitprovider.Permission(settings.MinActorPermission)
		if !need.Valid() {
			need = gitprovider.Permission(gitdom.DefaultMinActorPermission)
		}
		exempt := d.trigger == gitdom.TriggerCIFailure ||
			(d.trigger == gitdom.TriggerAutoReview && (ev.Subject == nil || ev.Subject.Head == nil || !ev.Subject.Head.FromFork))
		if !exempt {
			perm, err := r.actorPermission(ctx, repo, d.agent, ev)
			if err != nil {
				return nil, err
			}
			if !perm.AtLeast(need) {
				out.ignore("%s lacks %s access", ev.Actor.Login, need)
				continue
			}
		}
		permitted = append(permitted, d)
	}
	return dedupe(permitted), nil
}

// dedupe keeps one decision per (agent, trigger).
func dedupe(in []decision) []decision {
	seen := map[string]bool{}
	var out []decision
	for _, d := range in {
		k := d.agent.ID.String() + "/" + string(d.trigger)
		if !seen[k] {
			seen[k] = true
			out = append(out, d)
		}
	}
	return out
}

// addressedTrigger reports whether the provider says an identity was addressed,
// and by which route.
func addressedTrigger(ev *gitprovider.Event) (gitdom.TriggerKind, bool) {
	for _, a := range ev.Addressed {
		switch a.Via {
		case gitprovider.ViaMention:
			return gitdom.TriggerMention, true
		case gitprovider.ViaReviewRequest:
			return gitdom.TriggerReviewRequest, true
		case gitprovider.ViaAssignment:
			return gitdom.TriggerAssignment, true
		case gitprovider.ViaLabel:
			return gitdom.TriggerLabel, true
		}
	}
	return "", false
}

// endpointAgent is the agent whose own identity received the event, if any.
func (r *Router) endpointAgent(ctx context.Context, key string) (*uuid.UUID, error) {
	ep, err := r.svc.store.FindWebhookEndpoint(ctx, key)
	if errors.Is(err, gitdom.ErrNotFound) || (err == nil && ep.IdentityID == nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	id, found, err := r.svc.store.FindAgentForIdentity(ctx, *ep.IdentityID)
	if err != nil || !found {
		return nil, err
	}
	return &id, nil
}

// responder picks the agent that answers something addressed to the bot:
// the agent owning the identity, an "agent:<handle>" hint, the agent that last
// spoke on the subject, then the project's default responder.
func (r *Router) responder(ctx context.Context, repo *gitdom.Repository, ev *gitprovider.Event, st *gitdom.ProjectSettings,
	byID map[uuid.UUID]AgentRef, agents []AgentRef, endpoint *uuid.UUID) (AgentRef, bool, error) {
	if endpoint != nil {
		a, ok := byID[*endpoint]
		return a, ok, nil
	}
	if m := agentHintRE.FindStringSubmatch(ev.Text); m != nil {
		for _, a := range agents {
			if strings.EqualFold(a.Handle, m[1]) {
				return a, true, nil
			}
		}
	}
	if ev.Subject != nil {
		ic, err := r.svc.store.LatestIndexedForSubject(ctx, repo.ID, string(ev.Subject.Kind), ev.Subject.Number)
		if err != nil && !errors.Is(err, gitdom.ErrNotFound) {
			return AgentRef{}, false, err
		}
		if err == nil && ic.AgentID != nil {
			if a, ok := byID[*ic.AgentID]; ok {
				return a, true, nil
			}
		}
	}
	if st.DefaultResponderAgentID != nil {
		a, ok := byID[*st.DefaultResponderAgentID]
		return a, ok, nil
	}
	return AgentRef{}, false, nil
}

// labelTarget maps the label "paca" to the responder and "paca:<handle>" to that agent.
func (r *Router) labelTarget(ctx context.Context, repo *gitdom.Repository, label string, st *gitdom.ProjectSettings,
	byID map[uuid.UUID]AgentRef, agents []AgentRef, endpoint *uuid.UUID) (AgentRef, bool, error) {
	l := strings.ToLower(strings.TrimSpace(label))
	switch {
	case l == "paca":
		return r.responder(ctx, repo, &gitprovider.Event{}, st, byID, agents, endpoint)
	case strings.HasPrefix(l, "paca:"):
		handle := strings.TrimPrefix(l, "paca:")
		for _, a := range agents {
			if strings.EqualFold(a.Handle, handle) {
				return a, true, nil
			}
		}
	}
	return AgentRef{}, false, nil
}

// crOwner is the agent that opened the pull request through Paca.
func (r *Router) crOwner(ctx context.Context, repo *gitdom.Repository, number string, byID map[uuid.UUID]AgentRef) (*AgentRef, error) {
	cr, err := r.svc.store.FindChangeRequest(ctx, repo.ID, number)
	if errors.Is(err, gitdom.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if cr.OpenedByAgentID == nil {
		return nil, nil
	}
	a, ok := byID[*cr.OpenedByAgentID]
	if !ok {
		return nil, nil
	}
	return &a, nil
}

// triggerConfig returns an agent's setting for a trigger: its filters and
// whether it is on (explicit row, else the trigger's default).
func (r *Router) triggerConfig(ctx context.Context, agentID uuid.UUID, kind gitdom.TriggerKind) (json.RawMessage, bool, error) {
	rows, err := r.svc.store.ListAgentTriggers(ctx, agentID)
	if err != nil {
		return nil, false, err
	}
	for _, t := range rows {
		if t.Kind == kind {
			return t.Config, t.Enabled, nil
		}
	}
	return nil, kind.EnabledByDefault(), nil
}

type autoReviewConfig struct {
	Branches []string `json:"branches"`
	Authors  []string `json:"authors"`
}

// autoReviewMatches applies an agent's auto-review filters to a pull request
// event. An empty filter matches everything; a bot author must be listed.
func autoReviewMatches(raw json.RawMessage, ev *gitprovider.Event) bool {
	var cfg autoReviewConfig
	_ = json.Unmarshal(raw, &cfg)
	author := ev.Actor.Login
	if ev.Subject != nil && ev.Subject.Author != "" {
		author = ev.Subject.Author
	}
	if ev.Actor.Kind == gitprovider.ActorBot && !containsFold(cfg.Authors, author) {
		return false
	}
	if len(cfg.Authors) > 0 && !containsFold(cfg.Authors, author) {
		return false
	}
	if len(cfg.Branches) > 0 {
		base := ""
		if ev.Subject != nil {
			base = ev.Subject.Base
		}
		if !containsFold(cfg.Branches, base) {
			return false
		}
	}
	return true
}

func containsFold(list []string, v string) bool {
	for _, s := range list {
		if strings.EqualFold(strings.TrimSpace(s), v) {
			return true
		}
	}
	return false
}

// actorPermission is the actor's access to the repository, from the event if
// the provider vouched for it, else asked of the platform and remembered.
func (r *Router) actorPermission(ctx context.Context, repo *gitdom.Repository, agent AgentRef, ev *gitprovider.Event) (gitprovider.Permission, error) {
	if ev.Actor.Permission.Valid() && ev.Actor.Permission != gitprovider.PermissionNone {
		return ev.Actor.Permission, nil
	}
	key := permKey{repo: repo.ID, login: strings.ToLower(ev.Actor.Login)}
	r.mu.Lock()
	if c, ok := r.perms[key]; ok && time.Now().Before(c.expires) {
		r.mu.Unlock()
		return c.perm, nil
	}
	r.mu.Unlock()

	t, err := r.svc.resolve(ctx, Scope{ProjectID: repo.ProjectID, RepositoryID: repo.ID, AgentID: agent.ID})
	if err != nil {
		return gitprovider.PermissionNone, err
	}
	perm, err := t.api.GetActorPermission(ctx, gitprovider.ActorPermissionRequest{Target: t.target, Login: ev.Actor.Login})
	if gitprovider.IsCode(err, gitprovider.CodeNotFound) || gitprovider.IsCode(err, gitprovider.CodeForbidden) {
		perm, err = gitprovider.PermissionNone, nil
	}
	if err != nil {
		return gitprovider.PermissionNone, err
	}
	r.mu.Lock()
	r.perms[key] = cachedPerm{perm: perm, expires: time.Now().Add(r.opt.PermissionTTL)}
	r.mu.Unlock()
	return perm, nil
}

// ── starting a run ───────────────────────────────────────────────────────────

func (r *Router) launch(ctx context.Context, in *gitdom.InboxEvent, repo *gitdom.Repository, ev *gitprovider.Event, d decision, out *outcome) error {
	subjectKind, number := "", ""
	if ev.Subject != nil {
		subjectKind, number = string(ev.Subject.Kind), ev.Subject.Number
	}

	// One run per agent and subject at a time. An event that arrived before the
	// running run started is already covered (the run reads the whole thread);
	// a later one waits for the run to end and then starts its own.
	if number != "" {
		active, err := r.svc.store.FindActiveRunForSubject(ctx, repo.ID, d.agent.ID, subjectKind, number)
		if err == nil {
			if !in.ReceivedAt.After(active.CreatedAt) {
				out.ignore("%s is already working on it and will see this", d.agent.Handle)
			} else {
				out.deferred = true
			}
			return nil
		}
		if !errors.Is(err, gitdom.ErrNotFound) {
			return err
		}
	}

	headSHA := ""
	if ev.Subject != nil && ev.Subject.Head != nil {
		headSHA = ev.Subject.Head.SHA
	}
	if ev.Check != nil && ev.Check.SHA != "" {
		headSHA = ev.Check.SHA
	}
	run := &gitdom.Run{EventID: in.EventID, RepositoryID: repo.ID, AgentID: d.agent.ID, Trigger: d.trigger,
		SubjectKind: subjectKind, SubjectNumber: number, HeadSHA: headSHA, Status: gitdom.RunRunning}
	created, err := r.svc.store.CreateRun(ctx, run)
	if errors.Is(err, gitdom.ErrRunActive) {
		// Another event (or replica) started a run on this subject in the
		// meantime: wait for it, as for an active run found above.
		out.deferred = true
		return nil
	}
	if err != nil {
		return err
	}
	if !created {
		out.ignore("%s already has a run for this event", d.agent.Handle)
		return nil
	}

	info, _ := r.svc.providers.Describe(ctx, repo.ProviderID)
	perm := ev.Actor.Permission
	if cached, ok := r.cachedPermission(repo.ID, ev.Actor.Login); ok {
		perm = cached
	}
	if cr, err := r.svc.store.FindChangeRequest(ctx, repo.ID, number); err == nil && cr.HeadSHA != "" {
		headSHA = cr.HeadSHA
	}
	message := buildPrompt(promptInput{ProjectID: repo.ProjectID, Repo: repo, Event: ev, Trigger: d.trigger,
		Terms: info.Terms, HeadSHA: headSHA, AgentName: d.agent.Name, Permission: perm})

	conv, err := r.runs.StartRun(ctx, repo.ProjectID, d.agent.ID, message)
	if err != nil {
		run.Status = gitdom.RunFailed
		_ = r.svc.store.UpdateRun(ctx, run)
		return fmt.Errorf("start agent run: %w", err)
	}
	run.ConversationID = &conv
	_ = r.svc.store.UpdateRun(ctx, run)
	out.started++

	r.acknowledge(ctx, repo, d.agent, ev, run)
	return nil
}

func (r *Router) cachedPermission(repo uuid.UUID, login string) (gitprovider.Permission, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.perms[permKey{repo: repo, login: strings.ToLower(login)}]
	return c.perm, ok && time.Now().Before(c.expires)
}

// acknowledge shows on the platform that the agent picked the event up: an
// "eyes" reaction on the comment and a run status. Best effort: a platform that
// refuses must not undo a run that already started.
func (r *Router) acknowledge(ctx context.Context, repo *gitdom.Repository, agent AgentRef, ev *gitprovider.Event, run *gitdom.Run) {
	sc := Scope{ProjectID: repo.ProjectID, RepositoryID: repo.ID, AgentID: agent.ID, ConversationID: run.ConversationID}
	t, err := r.svc.resolve(ctx, sc)
	if err != nil {
		return
	}
	info, err := r.svc.providers.Describe(ctx, repo.ProviderID)
	if err != nil {
		return
	}
	if info.Capabilities.Reactions && ev.Location != nil && ev.Location.CommentID != "" && ev.Kind == gitprovider.EventComment {
		_ = t.api.React(ctx, gitprovider.ReactRequest{Target: t.target, CommentID: ev.Location.CommentID, Emoji: "eyes"})
	}
	r.setRunStatus(ctx, sc, t, agent, run, gitprovider.RunInProgress, "Working on it")
}

func (r *Router) setRunStatus(ctx context.Context, sc Scope, t *opTarget, agent AgentRef, run *gitdom.Run, state gitprovider.RunState, summary string) {
	// A check run belongs to a commit; an issue has none to attach one to.
	if run.SubjectNumber == "" || (run.SubjectKind == string(gitprovider.SubjectIssue) && run.HeadSHA == "") {
		return
	}
	url := ""
	if r.svc.publicURL != "" && run.ConversationID != nil {
		url = fmt.Sprintf("%s/projects/%s/conversations/%s", r.svc.publicURL, sc.ProjectID, *run.ConversationID)
	}
	res, err := t.api.SetStatus(ctx, gitprovider.SetStatusRequest{Target: t.target,
		Subject: gitprovider.SubjectRef{Kind: gitprovider.SubjectKind(run.SubjectKind), Number: run.SubjectNumber},
		SHA:     run.HeadSHA, State: state, Title: runStatusPrefix + agent.Name, Summary: summary, URL: url, StatusRef: run.StatusRef})
	r.svc.auditOp(ctx, sc, t.repo, "run.status."+string(state), subjectLabel(gitprovider.SubjectKind(run.SubjectKind), run.SubjectNumber), err)
	if err == nil && res.StatusRef != "" && res.StatusRef != run.StatusRef {
		run.StatusRef = res.StatusRef
		_ = r.svc.store.UpdateRun(ctx, run)
	}
}

// ── finishing runs ───────────────────────────────────────────────────────────

// finalize closes the runs whose conversation ended and shows the result.
func (r *Router) finalize(ctx context.Context) {
	runs, err := r.svc.store.ListActiveRuns(ctx)
	if err != nil {
		r.log.Error("git router: list active runs", "error", err)
		return
	}
	for _, run := range runs {
		status, state, summary := r.runOutcome(ctx, run)
		if status.Active() {
			continue
		}
		run.Status = status
		if err := r.svc.store.UpdateRun(ctx, run); err != nil {
			r.log.Error("git router: update run", "run", run.ID, "error", err)
			continue
		}
		r.showFinal(ctx, run, state, summary)
	}
}

func (r *Router) runOutcome(ctx context.Context, run *gitdom.Run) (gitdom.RunStatus, gitprovider.RunState, string) {
	if run.ConversationID == nil {
		if time.Since(run.CreatedAt) > 5*time.Minute {
			return gitdom.RunFailed, gitprovider.RunFailure, "The run could not be started."
		}
		return gitdom.RunRunning, "", ""
	}
	st, err := r.agents.ConversationStatus(ctx, *run.ConversationID)
	if err != nil {
		if errors.Is(err, gitdom.ErrNotFound) {
			return gitdom.RunCancelled, gitprovider.RunCancelled, "The conversation was deleted."
		}
		return gitdom.RunRunning, "", ""
	}
	switch st {
	case "finished":
		return gitdom.RunSucceeded, gitprovider.RunSuccess, "Done."
	case "failed":
		return gitdom.RunFailed, gitprovider.RunFailure, "The run failed."
	case "stopped":
		return gitdom.RunCancelled, gitprovider.RunCancelled, "The run was stopped."
	}
	if time.Since(run.CreatedAt) > r.opt.RunTimeout {
		return gitdom.RunFailed, gitprovider.RunFailure, "The run timed out."
	}
	return gitdom.RunRunning, "", ""
}

func (r *Router) showFinal(ctx context.Context, run *gitdom.Run, state gitprovider.RunState, summary string) {
	repo, err := r.svc.store.FindRepository(ctx, run.RepositoryID)
	if err != nil {
		return
	}
	agents, err := r.agents.ProjectAgents(ctx, repo.ProjectID)
	if err != nil {
		return
	}
	name := "agent"
	for _, a := range agents {
		if a.ID == run.AgentID {
			name = a.Name
		}
	}
	sc := Scope{ProjectID: repo.ProjectID, RepositoryID: repo.ID, AgentID: run.AgentID, ConversationID: run.ConversationID}
	t, err := r.svc.resolve(ctx, sc)
	if err != nil {
		return
	}
	r.setRunStatus(ctx, sc, t, AgentRef{ID: run.AgentID, Name: name}, run, state, summary)
}
