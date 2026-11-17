package middleware

import (
	"errors"
	"net/http"

	"github.com/Paca-AI/api/internal/apierr"
	"github.com/Paca-AI/api/internal/platform/authz/iam"
)

// ActionCheck is one IAM question a gate asks: may the caller perform Action
// on the resource Resource names?
type ActionCheck struct {
	Action   iam.Action
	Resource ResourceResolver
}

// RequireAction admits the caller when the IAM authorizer allows action on
// the resource res resolves for the request. A denial is 403 FORBIDDEN, an
// unauthenticated caller 401, a malformed resource id 400 (via res), and an
// authorizer failure 500 — never an allow.
func RequireAction(a *iam.Authorizer, action iam.Action, res ResourceResolver) func(http.Handler) http.Handler {
	return RequireActions(a, ActionCheck{Action: action, Resource: res})
}

// RequireActions is RequireAction for several checks that must ALL pass (the
// AND semantics every gate has). Every resource is resolved before the
// authorizer is consulted, so a malformed id is a 400 without a store lookup.
func RequireActions(a *iam.Authorizer, checks ...ActionCheck) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			allowed, err := authorizeAll(r, a, checks)
			if proceedIfAllowed(w, r, allowed, err) {
				next.ServeHTTP(w, r)
			}
		})
	}
}

// RequireAnyActions admits the caller who passes every check of at least one
// group. Groups are tried in order; a group whose resource cannot be resolved
// is skipped, and if no group admits the caller the first such error is
// returned instead of a plain 403. Use it only where two different resources
// legitimately open the same route; a single-resource route uses
// RequireActions.
func RequireAnyActions(a *iam.Authorizer, groups ...[]ActionCheck) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var firstResolveErr error
			for _, group := range groups {
				allowed, err := authorizeAll(r, a, group)
				if re, ok := err.(resourceError); ok {
					if firstResolveErr == nil {
						firstResolveErr = re.err
					}
					continue
				}
				if err != nil || allowed {
					if proceedIfAllowed(w, r, allowed, err) {
						next.ServeHTTP(w, r)
					}
					return
				}
			}
			proceedIfAllowed(w, r, false, firstResolveErr)
		})
	}
}

// IAMPrincipalFrom turns the request's authenticated Principal into an IAM
// principal: the caller is exactly the account it authenticated as (a user, an
// agent or a service account), never anything inferred from another source.
func IAMPrincipalFrom(r *http.Request) (iam.Principal, error) {
	p, ok := PrincipalFrom(r)
	if !ok {
		return iam.Principal{}, apierr.New(apierr.CodeUnauthenticated, "unauthenticated")
	}
	return iam.Principal{Type: string(p.Kind), ID: p.AccountID.String()}, nil
}

// resourceError marks a resolver failure so RequirePublicProjectOrActions can
// tell it apart from an authorizer failure.
type resourceError struct{ err error }

func (e resourceError) Error() string { return e.err.Error() }
func (e resourceError) Unwrap() error { return e.err }

// authorizeAll reports whether the caller passes every check. The result
// follows evaluate's contract: (true, nil) allowed, (false, nil) denied,
// (false, err) not judgeable — with resolver failures wrapped in
// resourceError (the presenter still finds the apierr inside via errors.As).
func authorizeAll(r *http.Request, a *iam.Authorizer, checks []ActionCheck) (bool, error) {
	p, err := IAMPrincipalFrom(r)
	if err != nil {
		return false, err
	}
	if a == nil {
		return false, apierr.New(apierr.CodeInternalError, "authorization not configured")
	}
	if len(checks) == 0 {
		return false, nil // a gate with nothing to check admits no one
	}
	resources := make([]string, len(checks))
	for i, c := range checks {
		if c.Resource == nil {
			return false, apierr.New(apierr.CodeInternalError, "authorization not configured")
		}
		res, err := c.Resource(r)
		if errors.Is(err, ErrNoResource) {
			continue // nothing to authorize for this check on this request
		}
		if err != nil {
			return false, resourceError{err: err}
		}
		resources[i] = res
	}
	for i, c := range checks {
		if resources[i] == "" {
			continue // skipped via ErrNoResource
		}
		result, err := a.Authorize(r.Context(), p, string(c.Action), resources[i])
		if err != nil {
			return false, err
		}
		if !result.Allowed {
			return false, nil
		}
	}
	return true, nil
}
