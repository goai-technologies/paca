package executor

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"github.com/Paca-AI/agent-runner/internal/executor/providercli"
)

func TestCLIHomeBootstrapScript_NeverDiscardsBeforeCopy(t *testing.T) {
	a, _ := providercli.Get("claude-code")
	s := cliHomeBootstrapScript(a, "claude-code")
	if !strings.Contains(s, `cp -an "`+sandboxWorkdir+`/.claude"/. "`+providercli.HomeRoot+`/claude-code"/ && rm -rf`) {
		t.Errorf("rm -rf must only follow a successful non-clobbering copy:\n%s", s)
	}
	if !strings.Contains(s, "CLAUDE_CONFIG_DIR") {
		t.Errorf("claude-code script is missing the legacy .claude.json handling:\n%s", s)
	}
	c, _ := providercli.Get("codex")
	if strings.Contains(cliHomeBootstrapScript(c, "codex"), "CLAUDE_CONFIG_DIR") {
		t.Error("legacy .claude.json handling must be claude-code only")
	}
}

func TestCLIHomeBootstrapScript_RunsOnRealFilesystem(t *testing.T) {
	// Behavioural check of the shell logic against a throwaway tree.
	dir := t.TempDir()
	run := func(script string) {
		t.Helper()
		if out, err := execSh(script); err != nil {
			t.Fatalf("script failed: %v\n%s", err, out)
		}
	}
	home, persist := dir+"/home", dir+"/vol/claude-code"
	run(`mkdir -p ` + home + `/.claude && echo tok > ` + home + `/.claude/.credentials.json && echo '{}' > ` + home + `/.claude.json`)
	a, _ := providercli.Get("claude-code")
	s := strings.NewReplacer(sandboxWorkdir, home, providercli.HomeRoot+"/claude-code", persist).Replace(cliHomeBootstrapScript(a, "claude-code"))
	run(s)
	run(s) // idempotent
	run(`test -L ` + home + `/.claude && test "$(cat ` + persist + `/.credentials.json)" = tok && test -e ` + persist + `/.claude.json && test -L ` + home + `/.claude.json`)
}

func execSh(script string) (string, error) {
	out, err := exec.CommandContext(context.Background(), "/bin/sh", "-c", script).CombinedOutput()
	return string(out), err
}
