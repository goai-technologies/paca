package middleware

import (
	"net/http"

	"github.com/Paca-AI/api/internal/apierr"
	"github.com/Paca-AI/api/internal/platform/authz/iam"
	"github.com/Paca-AI/api/internal/transport/http/presenter"
)

// EnforceActions writes the rejection itself and reports whether the caller
// passes every check (see RequireActions).
func EnforceActions(w http.ResponseWriter, r *http.Request, a *iam.Authorizer, checks ...ActionCheck) bool {
	allowed, err := authorizeAll(r, a, checks)
	return proceedIfAllowed(w, r, allowed, err)
}

// proceedIfAllowed turns a check's result into a response: nothing (and true)
// when the request may proceed, otherwise the matching error (and false).
func proceedIfAllowed(w http.ResponseWriter, r *http.Request, allowed bool, err error) bool {
	switch {
	case err != nil:
		presenter.Error(w, r, err)
		return false
	case !allowed:
		presenter.Error(w, r, apierr.New(apierr.CodeForbidden, "insufficient permissions"))
		return false
	}
	return true
}
