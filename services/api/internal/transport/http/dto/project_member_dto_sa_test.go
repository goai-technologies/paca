package dto_test

import (
	"testing"

	"github.com/google/uuid"

	projectdom "github.com/Paca-AI/api/internal/domain/project"
	"github.com/Paca-AI/api/internal/transport/http/dto"
)

// A service account member is reported by its account id, with its account name
// as the display name; users and agents carry no service_account_id.
func TestProjectMemberFromEntity_ServiceAccount(t *testing.T) {
	account := uuid.New()
	sa := dto.ProjectMemberFromEntity(&projectdom.ProjectMember{
		ID: uuid.New(), AccountID: account, MemberType: "service_account", FullName: "CI bot",
	})
	if sa.ServiceAccountID == nil || *sa.ServiceAccountID != account || sa.FullName != "CI bot" || sa.MemberType != "service_account" {
		t.Fatalf("service account member = %+v", sa)
	}
	for _, mt := range []string{"human", "agent"} {
		if m := dto.ProjectMemberFromEntity(&projectdom.ProjectMember{MemberType: mt, AccountID: uuid.New()}); m.ServiceAccountID != nil {
			t.Errorf("%s member must not carry a service_account_id", mt)
		}
	}
}

// provider_cli agents expose their CLI provider so the web app can pick a logo.
func TestProjectMemberFromEntity_AgentCLIProvider(t *testing.T) {
	cli := "codex"
	m := dto.ProjectMemberFromEntity(&projectdom.ProjectMember{
		MemberType: "agent", AccountID: uuid.New(), AgentType: "provider_cli", AgentCLIProvider: &cli,
	})
	if m.AgentCLIProvider == nil || *m.AgentCLIProvider != "codex" {
		t.Fatalf("agent_cli_provider = %v", m.AgentCLIProvider)
	}
}
