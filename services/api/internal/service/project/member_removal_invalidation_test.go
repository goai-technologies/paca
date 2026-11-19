package projectsvc

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"

	projectdom "github.com/Paca-AI/api/internal/domain/project"
)

// countingInvalidator counts Invalidate calls, which recordingInvalidator
// cannot: a removal passes no role ids.
type countingInvalidator struct{ calls int }

func (c *countingInvalidator) Invalidate(...string) { c.calls++ }

// removalRepo lets each removal path succeed or fail on demand.
type removalRepo struct {
	*memberServiceRepoMock
	member *projectdom.ProjectMember
	err    error
}

func (r *removalRepo) RemoveMember(context.Context, uuid.UUID, uuid.UUID) error { return r.err }
func (r *removalRepo) RemoveAgentMember(_ context.Context, _, _ uuid.UUID) error {
	return r.err
}
func (r *removalRepo) RemoveMemberByMemberID(context.Context, uuid.UUID) error { return r.err }
func (r *removalRepo) FindMemberByID(context.Context, uuid.UUID) (*projectdom.ProjectMember, error) {
	return r.member, nil
}

// Removing a member takes their project roles away, so the policy cache is
// told (which announces the change to services/realtime) on every removal
// path, and only once the removal succeeded.
func TestRemovingAMemberAnnouncesTheChange(t *testing.T) {
	projectID, memberID := uuid.New(), uuid.New()
	member := &projectdom.ProjectMember{ID: memberID, ProjectID: projectID, UserID: uuid.New()}
	base := &memberServiceRepoMock{
		findByID: func(_ context.Context, id uuid.UUID) (*projectdom.Project, error) {
			return &projectdom.Project{ID: id}, nil
		},
		findMember: func(context.Context, uuid.UUID, uuid.UUID) (*projectdom.ProjectMember, error) {
			return member, nil
		},
	}
	removals := map[string]func(*Service) error{
		"RemoveMember": func(s *Service) error {
			return s.RemoveMember(context.Background(), projectID, member.UserID)
		},
		"RemoveMemberByMemberID": func(s *Service) error {
			return s.RemoveMemberByMemberID(context.Background(), projectID, memberID)
		},
		"RemoveAgentMember": func(s *Service) error {
			return s.RemoveAgentMember(context.Background(), projectID, uuid.New())
		},
	}
	for name, remove := range removals {
		t.Run(name, func(t *testing.T) {
			inv := &countingInvalidator{}
			svc := New(&removalRepo{memberServiceRepoMock: base, member: member}, nil, nil).WithRoleInvalidator(inv)
			assert.NoError(t, remove(svc))
			assert.Equal(t, 1, inv.calls)
		})
		t.Run(name+" failing announces nothing", func(t *testing.T) {
			inv := &countingInvalidator{}
			svc := New(&removalRepo{memberServiceRepoMock: base, member: member, err: errors.New("db down")}, nil, nil).WithRoleInvalidator(inv)
			assert.Error(t, remove(svc))
			assert.Zero(t, inv.calls)
		})
	}
}
