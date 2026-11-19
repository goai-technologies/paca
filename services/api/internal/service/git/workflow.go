package gitsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	gitdom "github.com/Paca-AI/api/internal/domain/git"
	"github.com/Paca-AI/api/internal/platform/gitprovider"
)

// WithAgentDirectory lets settings be validated against the project's agents.
func (s *Service) WithAgentDirectory(d AgentDirectory) *Service {
	s.dir = d
	return s
}

// GetProjectSettings returns a project's Git workflow settings (defaults when unset).
func (s *Service) GetProjectSettings(ctx context.Context, projectID uuid.UUID) (*gitdom.ProjectSettings, error) {
	return s.store.GetProjectSettings(ctx, projectID)
}

// SetProjectSettings stores a project's Git workflow settings. The default
// responder must be an agent of the project.
func (s *Service) SetProjectSettings(ctx context.Context, st *gitdom.ProjectSettings) (*gitdom.ProjectSettings, error) {
	if st.MinActorPermission == "" {
		st.MinActorPermission = gitdom.DefaultMinActorPermission
	}
	min := gitprovider.Permission(st.MinActorPermission)
	if !min.Valid() || min == gitprovider.PermissionNone {
		return nil, fmt.Errorf("%w: min_actor_permission must be read, triage, write, maintain or admin", gitdom.ErrInvalidInput)
	}
	if st.DefaultResponderAgentID != nil {
		if s.dir == nil {
			return nil, gitdom.ErrProviderUnavailable
		}
		agents, err := s.dir.ProjectAgents(ctx, st.ProjectID)
		if err != nil {
			return nil, err
		}
		found := false
		for _, a := range agents {
			found = found || a.ID == *st.DefaultResponderAgentID
		}
		if !found {
			return nil, fmt.Errorf("%w: the default responder must be an agent of this project", gitdom.ErrInvalidInput)
		}
	}
	if err := s.store.UpsertProjectSettings(ctx, st); err != nil {
		return nil, err
	}
	return s.store.GetProjectSettings(ctx, st.ProjectID)
}

// TriggerView is one trigger as an agent's settings page shows it.
type TriggerView struct {
	Kind    gitdom.TriggerKind `json:"kind"`
	Enabled bool               `json:"enabled"`
	// Explicit is false while the agent still has the trigger's default.
	Explicit bool `json:"explicit"`
	// Supported is whether any installed provider can deliver this trigger.
	Supported bool            `json:"supported"`
	Config    json.RawMessage `json:"config"`
}

// ListAgentTriggers returns every trigger with the agent's effective setting.
func (s *Service) ListAgentTriggers(ctx context.Context, agentID uuid.UUID) ([]TriggerView, error) {
	rows, err := s.store.ListAgentTriggers(ctx, agentID)
	if err != nil {
		return nil, err
	}
	byKind := map[gitdom.TriggerKind]*gitdom.AgentTrigger{}
	for _, r := range rows {
		byKind[r.Kind] = r
	}
	infos, err := s.providers.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]TriggerView, 0, len(gitdom.TriggerKinds))
	for _, k := range gitdom.TriggerKinds {
		v := TriggerView{Kind: k, Enabled: k.EnabledByDefault(), Config: json.RawMessage(`{}`)}
		for _, info := range infos {
			v.Supported = v.Supported || info.Capabilities.SupportsTrigger(gitprovider.TriggerKind(k))
		}
		if r, ok := byKind[k]; ok {
			v.Enabled, v.Explicit = r.Enabled, true
			if len(r.Config) > 0 {
				v.Config = r.Config
			}
		}
		out = append(out, v)
	}
	return out, nil
}

const (
	maxFilterEntries = 50
	maxFilterLen     = 200
)

// SetAgentTrigger switches one trigger on or off for an agent and stores its
// filters. Only auto_review has filters.
func (s *Service) SetAgentTrigger(ctx context.Context, agentID uuid.UUID, kind gitdom.TriggerKind, enabled bool, config json.RawMessage) error {
	if !kind.Valid() {
		return fmt.Errorf("%w: unknown trigger %q", gitdom.ErrInvalidInput, kind)
	}
	cfg := json.RawMessage(`{}`)
	if len(strings.TrimSpace(string(config))) > 0 && string(config) != "null" {
		if kind != gitdom.TriggerAutoReview {
			return fmt.Errorf("%w: only auto_review has filters", gitdom.ErrInvalidInput)
		}
		var f autoReviewConfig
		dec := json.NewDecoder(strings.NewReader(string(config)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&f); err != nil {
			return fmt.Errorf("%w: filters must be {\"branches\": [...], \"authors\": [...]}", gitdom.ErrInvalidInput)
		}
		for _, list := range [][]string{f.Branches, f.Authors} {
			if len(list) > maxFilterEntries {
				return fmt.Errorf("%w: too many filter entries", gitdom.ErrInvalidInput)
			}
			for i, e := range list {
				list[i] = strings.TrimSpace(e)
				if list[i] == "" || len(list[i]) > maxFilterLen {
					return fmt.Errorf("%w: filter entries must be 1-%d characters", gitdom.ErrInvalidInput, maxFilterLen)
				}
			}
		}
		norm, _ := json.Marshal(f)
		cfg = norm
	}
	return s.store.UpsertAgentTrigger(ctx, &gitdom.AgentTrigger{AgentID: agentID, Kind: kind, Enabled: enabled, Config: cfg})
}

// ListProjectRuns returns a project's recent agent runs, newest first.
func (s *Service) ListProjectRuns(ctx context.Context, projectID uuid.UUID, limit int) ([]*gitdom.ProjectRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return s.store.ListProjectRuns(ctx, projectID, limit)
}
