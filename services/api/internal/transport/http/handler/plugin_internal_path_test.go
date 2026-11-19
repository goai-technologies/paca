package handler_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	plugindom "github.com/Paca-AI/api/internal/domain/plugin"
	pluginrt "github.com/Paca-AI/api/internal/platform/plugin"
)

// A Git provider's /_git/* operations carry no manifest policy (a manifest may
// not even declare them), and an undeclared route runs with no auth. They are
// for core only (Runtime.CallInternal), so the public proxy must refuse every
// spelling of them before anything reaches the plugin, signed in or not.
func TestProxyRequest_InternalRoutesAreNotReachableFromOutside(t *testing.T) {
	svc := &mockPluginSvc{
		listPlugins: func(_ context.Context) ([]*plugindom.Plugin, error) {
			return []*plugindom.Plugin{{
				Name: "test.plugin", Enabled: true,
				Manifest: plugindom.PluginManifest{Backend: &plugindom.BackendManifest{
					Routes: []plugindom.PluginRoute{{Method: http.MethodPost, Path: "/echo", Middlewares: []plugindom.PluginRouteMiddleware{}}},
				}},
			}}, nil
		},
	}
	rt := pluginrt.NewRuntime(nil, pluginrt.HostServices{}, pluginrt.ResourceLimits{MaxCallDuration: time.Second, MaxRequestBodyBytes: 4096},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := newPluginProxyRouter(svc, rt)

	do := func(method, target string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), method, target, strings.NewReader("{}")))
		return w
	}

	for _, target := range []string{
		"/plugins/test.plugin/_git/describe",
		"/plugins/test.plugin/_git/mint_credential",
		"/plugins/test.plugin/_git",
		"/plugins/test.plugin/_git/",
		"/plugins/test.plugin/_GIT/describe",
		"/plugins/test.plugin/%5Fgit/describe",
		"/plugins/test.plugin/%5fGIT/describe",
		"/plugins/test.plugin/%255Fgit/describe",
		"/plugins/test.plugin//_git/describe",
		"/plugins/test.plugin/x/../_git/describe",
		"/plugins/test.plugin/projects/p1/_git/describe",
	} {
		for _, method := range []string{http.MethodPost, http.MethodGet} {
			w := do(method, target)
			if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "PLUGIN_NOT_FOUND") {
				t.Errorf("%s %s: got %d %s, want 404 PLUGIN_NOT_FOUND", method, target, w.Code, w.Body.String())
			}
		}
	}

	// Ordinary routes are untouched: they get past the guard (and fail later only
	// because no WASM module is loaded in this test).
	for _, target := range []string{
		"/plugins/test.plugin/echo",
		"/plugins/test.plugin/projects/p1/gitignore", // contains "git" but is not the reserved segment
		"/plugins/test.plugin/_github/hooks",
	} {
		if w := do(http.MethodPost, target); strings.Contains(w.Body.String(), "plugin route not found") {
			t.Errorf("%s was refused by the internal-route guard: %d %s", target, w.Code, w.Body.String())
		}
	}
}
