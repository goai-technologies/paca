package projectdom

import (
	"context"

	"github.com/google/uuid"
)

// MemberRepository defines persistence operations for project members.
type MemberRepository interface {
	ListAllMembers(ctx context.Context, projectID uuid.UUID) ([]*ProjectMember, error)
	// ListMembers returns up to limit members ordered by name, starting
	// after the member cursorAfter (an opaque token from a previous page; nil
	// for the first page), plus whether more members follow.
	// CountMembers returns how many active members match filter, ignoring
	// any cursor.
	CountMembers(ctx context.Context, projectID uuid.UUID, filter MemberFilter) (int64, error)
	ListMembers(ctx context.Context, projectID uuid.UUID, limit int, cursorAfter *string, filter MemberFilter) ([]*ProjectMember, bool, error)
	// CountDistinctAgentsByProjects returns the number of distinct agents
	// with an active membership across all of projectIDs, in a single query
	// — used by the home page's workspace stats widget so an invited global
	// agent belonging to several projects is counted once, not once per
	// project. Human team-member counts come from userdom.Service.CountUsers
	// instead: they aren't project-scoped, so they don't need this table.
	CountDistinctAgentsByProjects(ctx context.Context, projectIDs []uuid.UUID) (int64, error)
	// FindMember returns the active member record of an account (a user, an
	// agent or a service account) in a project; ErrMemberNotFound when it has
	// none. This is the single account -> member lookup.
	FindMember(ctx context.Context, projectID, accountID uuid.UUID) (*ProjectMember, error)
	// FindMemberByID returns the active member record for the given
	// project_members.id.  Used to resolve an assignee member ID to a user ID.
	FindMemberByID(ctx context.Context, memberID uuid.UUID) (*ProjectMember, error)
	// AddMember inserts a project_members row (or restores a soft-deleted
	// one) and attaches roleIDs to the member inside the project, in one
	// transaction. roledom.ErrNotAttachable when a role does not exist or
	// cannot be attached in the project.
	AddMember(ctx context.Context, m *ProjectMember, roleIDs []uuid.UUID, createdBy *uuid.UUID) error
	RemoveMember(ctx context.Context, projectID, accountID uuid.UUID) error
	// UpdateMemberDescription changes a member's Jev-facing description by
	// their membership record ID — see ProjectMember.Description.
	UpdateMemberDescription(ctx context.Context, memberID uuid.UUID, description string) error
	// RemoveMemberByMemberID removes a member by their membership record ID.
	RemoveMemberByMemberID(ctx context.Context, memberID uuid.UUID) error
	// AddAgentMember inserts an agent as a project member and attaches
	// roleIDs to it inside the project, in one transaction.
	AddAgentMember(ctx context.Context, memberID, projectID, agentID uuid.UUID, roleIDs []uuid.UUID, createdBy *uuid.UUID) error
	// RemoveAgentMember soft-deletes the agent's membership record.
	RemoveAgentMember(ctx context.Context, projectID, agentID uuid.UUID) error
}
