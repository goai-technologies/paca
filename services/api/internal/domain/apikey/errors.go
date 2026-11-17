package apikeydom

import "errors"

// Sentinel domain errors for the api key aggregate.
var (
	ErrNotFound    = errors.New("api key: not found")
	ErrRevoked     = errors.New("api key: revoked")
	ErrExpired     = errors.New("api key: expired")
	ErrNameInvalid = errors.New("api key: name must not be empty")
	ErrNameTooLong = errors.New("api key: name must not exceed 100 characters")
	ErrForbidden   = errors.New("api key: forbidden")
	// ErrInvalidCursor reports a malformed pagination cursor.
	ErrInvalidCursor = errors.New("api key: invalid cursor")
)
