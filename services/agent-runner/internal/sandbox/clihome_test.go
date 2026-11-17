package sandbox

import (
	"context"
	"strings"
	"testing"
)

func TestEnsureCLIHomeDirs_CreatesEveryDirInOneMkdir(t *testing.T) {
	backend := &fakeEnvironmentBackend{}
	dirs := []string{"/vol/.cli-home/a", "/vol/.cli-home/b"}
	if err := EnsureCLIHomeDirs(context.Background(), backend, "ref", dirs); err != nil {
		t.Fatal(err)
	}
	if len(backend.execCmds) != 1 {
		t.Fatalf("exec calls = %d, want 1: %v", len(backend.execCmds), backend.execCmds)
	}
	if got, want := strings.Join(backend.execCmds[0], " "), "mkdir -p /vol/.cli-home/a /vol/.cli-home/b"; got != want {
		t.Errorf("command = %q, want %q", got, want)
	}
}

func TestEnsureCLIHomeDirs_NoDirsIsNoop(t *testing.T) {
	backend := &fakeEnvironmentBackend{}
	if err := EnsureCLIHomeDirs(context.Background(), backend, "ref", nil); err != nil {
		t.Fatal(err)
	}
	if len(backend.execCmds) != 0 {
		t.Errorf("unexpected exec calls: %v", backend.execCmds)
	}
}

func TestEnsureCLIHomeDirs_FailurePropagates(t *testing.T) {
	failing := &failingBackend{fakeEnvironmentBackend: &fakeEnvironmentBackend{}}
	if err := EnsureCLIHomeDirs(context.Background(), failing, "ref", []string{"/vol/x"}); err == nil {
		t.Fatal("expected an error when mkdir fails")
	}
}

type failingBackend struct{ *fakeEnvironmentBackend }

func (f *failingBackend) ExecEnvironment(context.Context, string, []string) (string, int, error) {
	return "read-only filesystem", 1, nil
}
