package events

import (
	"context"

	"github.com/google/uuid"
)

// requestActor is who caused the events a request produces, carried on the
// request context so a service can Fanout an attributed event without every
// method growing actor parameters.
type requestActor struct {
	accountID uuid.UUID
	origin    Origin
}

type requestActorKey struct{}

// WithRequestActor returns ctx carrying the authenticated caller: its account
// id and the origin it acts from (OriginAgent for an agent, OriginUser for
// anything else). The HTTP authn middleware sets it on every authenticated
// request. Background workers never set it, so their events stay
// system-attributed.
func WithRequestActor(ctx context.Context, accountID uuid.UUID, origin Origin) context.Context {
	return context.WithValue(ctx, requestActorKey{}, requestActor{accountID: accountID, origin: origin})
}

// RequestOrigin returns the origin of the request's caller, or "" when ctx
// carries none (a background job).
func RequestOrigin(ctx context.Context) Origin {
	a, _ := ctx.Value(requestActorKey{}).(requestActor)
	return a.origin
}

// withContextActor fills an event's actor and origin from the request context
// when its producer left both unset. A producer that sets either — the task
// and doc activity services, which carry an explicit origin — is left
// untouched.
func withContextActor(ctx context.Context, e Event) Event {
	if e.ActorID != nil || e.Origin != "" {
		return e
	}
	a, ok := ctx.Value(requestActorKey{}).(requestActor)
	if !ok {
		return e
	}
	if a.accountID != uuid.Nil {
		accountID := a.accountID
		e.ActorID = &accountID
	}
	e.Origin = a.origin
	return e
}
