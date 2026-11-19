package plugin

import (
	"context"
	"encoding/json"
	"fmt"
)

// CallInternal invokes one of a plugin's own routes on behalf of core code and
// returns the HTTP status and body the plugin answered with.
//
// It bypasses the HTTP router entirely: no manifest route lookup, no auth
// middleware, no browser involvement. That is the point — it is how core calls
// operations (such as a Git provider's `/_git/*` routes) that must never be
// reachable from outside. Callers are core services that have already decided
// the call is allowed; the plugin sees an empty caller identity.
func (r *Runtime) CallInternal(ctx context.Context, pluginName, method, path string, body []byte) (int, []byte, error) {
	payload, err := json.Marshal(HTTPRequest{Method: method, Path: path, Body: body})
	if err != nil {
		return 0, nil, fmt.Errorf("encode internal request: %w", err)
	}
	raw, err := r.HandleRequest(ctx, pluginName, payload)
	if err != nil {
		return 0, nil, err
	}
	return parseInternalResponse(raw)
}

// parseInternalResponse decodes the plugin SDK's response envelope
// ({"status", "headers", "body": base64}).
func parseInternalResponse(raw []byte) (int, []byte, error) {
	var env struct {
		Status int    `json:"status"`
		Body   []byte `json:"body"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return 0, nil, fmt.Errorf("decode plugin response: %w", err)
	}
	if env.Status == 0 {
		env.Status = 200
	}
	return env.Status, env.Body, nil
}
