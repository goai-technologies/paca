package sandbox

import (
	"context"
	"fmt"
	"strings"
)

// EnsureCLIHomeDirs creates dirs (the provider CLIs' persisted home
// directories, e.g. providercli.HomeRoot/<provider>) on an environment's
// workspace volume in one mkdir -p. services/agent-server's image bakes
// ~/.claude, ~/.codex, ~/.cursor and ~/.gemini as symlinks onto those
// directories, but the volume is mounted at runtime, so the targets can't
// exist in the image. Without them a login made from the environment
// terminal before any conversation has run would hit a dangling symlink.
// Idempotent; safe to call on every create/start.
func EnsureCLIHomeDirs(ctx context.Context, backend EnvironmentBackend, backendRef string, dirs []string) error {
	if len(dirs) == 0 {
		return nil
	}
	cmd := append([]string{"mkdir", "-p"}, dirs...)
	if err := execEnvironmentOK(ctx, backend, backendRef, cmd); err != nil {
		return fmt.Errorf("sandbox: create cli home dirs (%s): %w", strings.Join(dirs, " "), err)
	}
	return nil
}
