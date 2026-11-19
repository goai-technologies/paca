package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadSandboxPodReadyTimeout(t *testing.T) {
	for key, value := range map[string]string{
		"DATABASE_URL": "postgres://test", "VALKEY_URL": "redis://test",
		"ENCRYPTION_KEY": strings.Repeat("a", 64), "AGENT_SERVER_IMAGE": "test:latest",
		"INTERNAL_API_KEY": "test", "AGENT_RUNNER_ALLOWED_AGENT_IDS": "*",
		"SANDBOX_NAMESPACE": "paca-sandbox",
	} {
		t.Setenv(key, value)
	}
	for _, tc := range []struct {
		name, backend, raw string
		want               time.Duration
		wantErr            bool
	}{
		{"unset uses backend default", "kubernetes", "", 0, false},
		{"five minutes", "kubernetes", "5m", 5 * time.Minute, false},
		{"legacy wait", "kubernetes", "60s", time.Minute, false},
		{"compound duration", "kubernetes", "2m30s", 150 * time.Second, false},
		{"malformed", "kubernetes", "later", 0, true},
		{"missing unit", "kubernetes", "300", 0, true},
		{"zero", "kubernetes", "0s", 0, true},
		{"negative", "kubernetes", "-1m", 0, true},
		{"overflow", "kubernetes", "999999999999999999h", 0, true},
		{"docker ignores Kubernetes setting", "docker", "invalid", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SANDBOX_BACKEND", tc.backend)
			t.Setenv("SANDBOX_POD_READY_TIMEOUT", tc.raw)
			settings, err := Load()
			if tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), "SANDBOX_POD_READY_TIMEOUT") {
					t.Fatalf("Load() error = %v, want timeout validation error", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if settings.SandboxPodReadyTimeout != tc.want {
				t.Fatalf("timeout = %s, want %s", settings.SandboxPodReadyTimeout, tc.want)
			}
		})
	}
}

func TestValidatePortRange(t *testing.T) {
	cases := []struct {
		name       string
		start, end int
		wantErr    bool
	}{
		{"both zero disables the feature", 0, 0, false},
		{"valid range", 2200, 2299, false},
		{"start equals end", 2200, 2200, false},
		{"only start set", 2200, 0, true},
		{"only end set", 0, 2299, true},
		{"end before start", 2299, 2200, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePortRange("SSH_BASTION_PORT_RANGE", tc.start, tc.end)
			if tc.wantErr && err == nil {
				t.Errorf("validatePortRange(%d, %d) = nil, want error", tc.start, tc.end)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("validatePortRange(%d, %d) = %v, want nil", tc.start, tc.end, err)
			}
		})
	}
}
