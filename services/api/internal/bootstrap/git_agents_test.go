package bootstrap

import (
	"context"
	"testing"

	"github.com/google/uuid"

	agentdom "github.com/Paca-AI/api/internal/domain/agent"
)

type fakeAgentFinder struct {
	agents map[uuid.UUID]*agentdom.Agent
	convs  map[uuid.UUID]*agentdom.AgentConversation
}

func (f fakeAgentFinder) FindAgentByID(_ context.Context, id uuid.UUID) (*agentdom.Agent, error) {
	if a, ok := f.agents[id]; ok {
		return a, nil
	}
	return nil, agentdom.ErrAgentNotFound
}

func (f fakeAgentFinder) FindConversationByID(_ context.Context, id uuid.UUID) (*agentdom.AgentConversation, error) {
	if c, ok := f.convs[id]; ok {
		return c, nil
	}
	return nil, agentdom.ErrConversationNotFound
}

func TestGitAgentLookup(t *testing.T) {
	project, other := uuid.New(), uuid.New()
	mine := &agentdom.Agent{ID: uuid.New(), ProjectID: project, AgentScope: agentdom.AgentScopeProject, Name: "Dev"}
	foreign := &agentdom.Agent{ID: uuid.New(), ProjectID: other, AgentScope: agentdom.AgentScopeProject, Name: "Other"}
	global := &agentdom.Agent{ID: uuid.New(), AgentScope: agentdom.AgentScopeGlobal, Name: "Global"}
	l := gitAgentLookup{repo: fakeAgentFinder{agents: map[uuid.UUID]*agentdom.Agent{mine.ID: mine, foreign.ID: foreign, global.ID: global}}}

	if name, ok, err := l.AgentInProject(t.Context(), project, mine.ID); err != nil || !ok || name != "Dev" {
		t.Errorf("own agent: %q %v %v", name, ok, err)
	}
	for label, id := range map[string]uuid.UUID{"another project's agent": foreign.ID, "a global agent": global.ID, "an unknown id": uuid.New()} {
		if _, ok, err := l.AgentInProject(t.Context(), project, id); err != nil || ok {
			t.Errorf("%s must not resolve: %v %v", label, ok, err)
		}
	}
}

func TestGitAgentLookup_NamesAndVouchesForConversations(t *testing.T) {
	project, agent, other := uuid.New(), uuid.New(), uuid.New()
	conv := &agentdom.AgentConversation{ID: uuid.New(), AgentID: agent, ProjectID: project}
	l := gitAgentLookup{repo: fakeAgentFinder{
		agents: map[uuid.UUID]*agentdom.Agent{agent: {ID: agent, Name: "Dev"}},
		convs:  map[uuid.UUID]*agentdom.AgentConversation{conv.ID: conv},
	}}
	if got := l.AgentName(t.Context(), agent); got != "Dev" {
		t.Errorf("name = %q", got)
	}
	if got := l.AgentName(t.Context(), other); got != "" {
		t.Errorf("unknown agent name = %q", got)
	}
	if !l.OwnsConversation(t.Context(), project, agent, conv.ID) {
		t.Error("the owner's conversation must be vouched for")
	}
	if l.OwnsConversation(t.Context(), project, other, conv.ID) || l.OwnsConversation(t.Context(), other, agent, conv.ID) || l.OwnsConversation(t.Context(), project, agent, uuid.New()) {
		t.Error("another agent's, another project's or an unknown conversation must not be vouched for")
	}
}
