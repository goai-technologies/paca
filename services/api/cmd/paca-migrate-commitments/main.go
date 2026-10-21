// paca-migrate-commitments moves every Commitment-typed task into one
// Commitments project and attaches its work through tasks.commitment_task_id,
// replacing the relates_to convention.
//
// It only talks to PACA's public API, so every change is validated and
// recorded exactly as if a person had done it in the UI. Dry run by default;
// --apply writes. A state file makes --apply resumable.
//
//	paca-migrate-commitments -base-url http://localhost:3100 -username admin -password ... \
//	    -also-attach OPS-12=OPS-1 [-apply] [-state migrate.json]
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	var (
		baseURL     = flag.String("base-url", envOr("PACA_BASE_URL", "http://localhost:3100"), "PACA base URL")
		apiKey      = flag.String("api-key", os.Getenv("PACA_API_KEY"), "API key (X-Api-Key); or use -username/-password")
		username    = flag.String("username", os.Getenv("PACA_USERNAME"), "login username")
		password    = flag.String("password", os.Getenv("PACA_PASSWORD"), "login password")
		apply       = flag.Bool("apply", false, "write changes (default: dry run, print the plan)")
		stateFile   = flag.String("state", "migrate-commitments.state.json", "progress file used to resume")
		projectName = flag.String("project-name", "Commitments", "name of the Commitments project")
		prefix      = flag.String("prefix", "COM", "ticket prefix of the Commitments project")
		workstream  = flag.String("workstream", "Delivery", "Workstream value written to every migrated commitment")
		sqlOut      = flag.String("created-at-sql", "migrate-commitments.created_at.sql", "where to write the optional created-date SQL")
		verifyOnly  = flag.Bool("verify", false, "only verify a finished migration against the state file")
		also        multiFlag
	)
	flag.Var(&also, "also-attach", "TICKET=COMMITMENT: attach a top-level ticket that is not linked (repeatable)")
	flag.Parse()

	ctx := context.Background()
	c := newClient(*baseURL)
	if *apiKey != "" {
		c.apiKey = *apiKey
	} else if *username != "" {
		if err := c.login(ctx, *username, *password); err != nil {
			fail(err)
		}
	} else {
		fail(fmt.Errorf("give -api-key or -username/-password"))
	}

	opt := options{ProjectName: *projectName, Prefix: *prefix, Workstream: *workstream, AlsoAttach: map[string]string{}}
	for _, kv := range also {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			fail(fmt.Errorf("-also-attach %q: want TICKET=COMMITMENT", kv))
		}
		opt.AlsoAttach[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}

	say := func(s string) { fmt.Fprintln(os.Stderr, s) }
	inv, err := readInventory(ctx, c, say)
	if err != nil {
		fail(err)
	}
	for _, p := range inv.Projects {
		if strings.EqualFold(p.TaskIDPrefix, opt.Prefix) {
			opt.TargetID = p.ID
		}
	}
	st, err := loadState(*stateFile)
	if err != nil {
		fail(err)
	}
	p := buildPlan(inv, opt)
	r := &runner{c: c, opt: opt, st: st, stateOut: *stateFile, log: say}

	if *verifyOnly {
		t, err := r.prepareTarget(ctx, inv, p)
		if err != nil {
			fail(err)
		}
		report(verifyReport(r.verify(ctx, inv, p, t)))
		return
	}

	printPlan(inv, p, opt)
	if len(p.Issues) > 0 {
		say(fmt.Sprintf("\n%d issue(s) need a decision before --apply.", len(p.Issues)))
		os.Exit(2)
	}
	if !*apply {
		say("\nDry run. Nothing was changed. Re-run with -apply to migrate.")
		return
	}

	t, err := r.prepareTarget(ctx, inv, p)
	if err != nil {
		fail(err)
	}
	for _, cp := range p.Commitments {
		if err := r.migrateOne(ctx, inv, t, cp); err != nil {
			fail(fmt.Errorf("%w\nProgress is in %s; fix the cause and re-run the same command to resume", err, *stateFile))
		}
	}
	if err := os.WriteFile(*sqlOut, []byte(createdAtSQL(p, st)), 0o600); err != nil {
		fail(err)
	}
	say(fmt.Sprintf("\nMigrated %d commitments into %s. Created-date SQL written to %s (optional, review before running).", len(p.Commitments), t.Project.TaskIDPrefix, *sqlOut))
	report(verifyReport(r.verify(ctx, inv, p, t)))
}

func printPlan(inv *inventory, p *plan, opt options) {
	fmt.Printf("Commitments project: %s (%s), workstream %s\n", opt.ProjectName, opt.Prefix, opt.Workstream)
	fmt.Printf("Statuses to ensure: ")
	for i, s := range p.Statuses {
		if i > 0 {
			fmt.Print(", ")
		}
		fmt.Printf("%s (%s)", s.Name, s.Category)
	}
	fmt.Printf("\nFields to ensure: ")
	for i, f := range p.Fields {
		if i > 0 {
			fmt.Print(", ")
		}
		fmt.Print(f.FieldKey)
	}
	fmt.Printf("\nMembers to add: ")
	for i, m := range p.Owners {
		if i > 0 {
			fmt.Print(", ")
		}
		fmt.Print(m.FullName)
	}
	fmt.Printf("\n\n%d commitments:\n", len(p.Commitments))
	total := 0
	for _, cp := range p.Commitments {
		total += len(cp.Attach)
		fmt.Printf("\n%s  %q  [%s]  %s\n", cp.OldRef, cp.Old.Title, cp.Status.Name, inv.Projects[cp.Old.ProjectID].Name)
		for _, a := range cp.Attach {
			extra := ""
			if a.DetachFirst {
				extra = ", detached from the commitment first"
			}
			fmt.Printf("    attach %-12s %s (%s%s)\n", a.Ref, truncate(a.Task.Title, 60), a.Reason, extra)
		}
		for _, s := range cp.Skipped {
			fmt.Printf("    note   %s\n", s)
		}
		if len(cp.Comments) > 0 {
			fmt.Printf("    copy   %d comment(s)\n", len(cp.Comments))
		}
		fmt.Printf("    remove %d relates_to link(s), retire %s\n", len(cp.RemoveLinks), cp.OldRef)
	}
	fmt.Printf("\n%d tickets will be attached in total.\n", total)
	for _, n := range p.Notes {
		fmt.Println("note: " + n)
	}
	for _, i := range p.Issues {
		fmt.Println("ISSUE: " + i)
	}
}

func verifyReport(problems []string) string {
	if len(problems) == 0 {
		return "Verification passed: every commitment is in place with the expected work, and every old one is retired."
	}
	return "Verification found problems:\n  " + strings.Join(problems, "\n  ")
}

func report(s string) { fmt.Println(s) }

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
