package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"

	agentdom "github.com/Paca-AI/api/internal/domain/agent"
)

func TestAgentLists_PageByNameFilterAndSearch(t *testing.T) {
	f := newScopeFx(t)
	ctx := context.Background()
	repo := NewAgentRepository(f.db)

	name := func(id uuid.UUID, n, desc string) {
		pgExec(t, f.db, `UPDATE accounts SET name = $2, description = $3 WHERE id = $1`, id, n, desc)
	}
	// Three project agents, one invited global agent and one global agent that
	// is not in the project at all.
	proj := map[string]uuid.UUID{}
	for _, n := range []string{"Bravo", "alpha", "Charlie"} {
		id := f.fx.agent(&f.p, false)
		f.fx.member(f.p, id, false)
		name(id, n, "")
		proj[n] = id
	}
	invited := f.fx.agent(nil, false)
	f.fx.member(f.p, invited, false)
	name(invited, "Delta", "reviews pull requests")
	standalone := f.fx.agent(nil, false)
	name(standalone, "Echo", "")

	collect := func(filter agentdom.AgentFilter, size int) []string {
		var out []string
		var cursor *string
		for pages := 0; ; pages++ {
			if pages > 6 {
				t.Fatal("pagination did not terminate")
			}
			page, more, err := repo.ListAgents(ctx, f.p, filter, cursor, size)
			if err != nil {
				t.Fatal(err)
			}
			for _, a := range page {
				out = append(out, a.Name)
			}
			if !more {
				return out
			}
			c := agentdom.EncodeAgentCursor(page[len(page)-1])
			cursor = &c
		}
	}

	if got := collect(agentdom.AgentFilter{}, 2); fmt.Sprint(got) != "[alpha Bravo Charlie Delta]" {
		t.Fatalf("project agents = %v, want name order incl. the invited global agent", got)
	}
	if got := collect(agentdom.AgentFilter{Scope: agentdom.AgentScopeProject}, 2); len(got) != 3 {
		t.Fatalf("project scope = %v", got)
	}
	if got := collect(agentdom.AgentFilter{Scope: agentdom.AgentScopeGlobal}, 2); fmt.Sprint(got) != "[Delta]" {
		t.Fatalf("global scope = %v", got)
	}
	if got := collect(agentdom.AgentFilter{Search: " ALP "}, 5); fmt.Sprint(got) != "[alpha]" {
		t.Fatalf("name search = %v", got)
	}
	if got := collect(agentdom.AgentFilter{Search: "pull REQUESTS"}, 5); fmt.Sprint(got) != "[Delta]" {
		t.Fatalf("description search = %v", got)
	}
	if got := collect(agentdom.AgentFilter{IDs: []uuid.UUID{proj["Bravo"], standalone}}, 5); fmt.Sprint(got) != "[Bravo]" {
		t.Fatalf("ids lookup = %v (an agent outside the project must not appear)", got)
	}
	if all, err := repo.ListAllAgents(ctx, f.p, ""); err != nil || len(all) != 4 {
		t.Fatalf("ListAllAgents = %d, %v", len(all), err)
	}
	bad := "nope"
	if _, _, err := repo.ListAgents(ctx, f.p, agentdom.AgentFilter{}, &bad, 2); !errors.Is(err, agentdom.ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}

	// Global agents: both the invited and the standalone one, paged by name.
	var globals []string
	var cursor *string
	for pages := 0; ; pages++ {
		if pages > 4 {
			t.Fatal("pagination did not terminate")
		}
		page, more, err := repo.ListGlobalAgents(ctx, agentdom.AgentFilter{}, cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range page {
			globals = append(globals, a.Name)
		}
		if !more {
			break
		}
		c := agentdom.EncodeAgentCursor(page[len(page)-1])
		cursor = &c
	}
	if fmt.Sprint(globals) != "[Delta Echo]" {
		t.Fatalf("global agents = %v", globals)
	}
	if found, _, err := repo.ListGlobalAgents(ctx, agentdom.AgentFilter{Search: "echo"}, nil, 10); err != nil || len(found) != 1 {
		t.Fatalf("global search = %d, %v", len(found), err)
	}
	if all, err := repo.ListAllGlobalAgents(ctx); err != nil || len(all) != 2 {
		t.Fatalf("ListAllGlobalAgents = %d, %v", len(all), err)
	}
}
