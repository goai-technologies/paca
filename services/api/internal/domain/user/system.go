package userdom

import "github.com/google/uuid"

// SystemActorUserID is the fixed UUID of the built-in agent-bot user
// (seeded by bootstrap.seedAgentBotUser). It is used to attribute automated
// actions that have no human actor — e.g. the automation-workflow engine
// reassigning a task — for pipelines (like NotificationConsumer) that require
// a valid actor_user_id.
var SystemActorUserID = uuid.MustParse("00000000-0000-0000-0000-000000000002")

// IsUnidentifiedSystemActor reports whether (actorID, agentID) is the
// system actor with no specific agent behind it. That identity is a technical
// placeholder (it cannot sign in and holds no API key) and, by design, is never itself a
// project member, so callers that need to attribute an action to a specific
// member (e.g. authoring a comment) should treat this case specially rather
// than surfacing a generic "member not found".
func IsUnidentifiedSystemActor(actorID uuid.UUID, agentID *uuid.UUID) bool {
	return agentID == nil && actorID == SystemActorUserID
}
