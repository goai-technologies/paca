package main

import (
	"context"
	"fmt"
	"strings"
)

// readInventory pulls every live project with its types, statuses, fields,
// members and tasks, then the relates_to links and comments of each
// commitment. Read-only.
func readInventory(ctx context.Context, c *client, progress func(string)) (*inventory, error) {
	inv := &inventory{
		Projects: map[string]*project{},
		Types:    map[string]map[string]taskType{},
		Statuses: map[string]map[string]taskStatus{},
		Fields:   map[string][]customField{},
		Members:  map[string][]member{},
		Tasks:    map[string]*task{},
		Comments: map[string][]activity{},
	}
	projects, err := listPages[project](ctx, c, "/api/v1/projects")
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	for i := range projects {
		p := projects[i]
		inv.Projects[p.ID] = &p
		base := "/api/v1/projects/" + p.ID
		types, err := listItems[taskType](ctx, c, base+"/task-types")
		if err != nil {
			return nil, fmt.Errorf("%s task types: %w", p.Name, err)
		}
		inv.Types[p.ID] = map[string]taskType{}
		for _, t := range types {
			inv.Types[p.ID][t.ID] = t
		}
		statuses, err := listItems[taskStatus](ctx, c, base+"/task-statuses")
		if err != nil {
			return nil, fmt.Errorf("%s statuses: %w", p.Name, err)
		}
		inv.Statuses[p.ID] = map[string]taskStatus{}
		for _, s := range statuses {
			inv.Statuses[p.ID][s.ID] = s
		}
		if inv.Fields[p.ID], err = listItems[customField](ctx, c, base+"/custom-fields"); err != nil {
			return nil, fmt.Errorf("%s custom fields: %w", p.Name, err)
		}
		if inv.Members[p.ID], err = listCursor[member](ctx, c, base+"/members"); err != nil {
			return nil, fmt.Errorf("%s members: %w", p.Name, err)
		}
		tasks, err := listCursor[task](ctx, c, base+"/tasks")
		if err != nil {
			return nil, fmt.Errorf("%s tasks: %w", p.Name, err)
		}
		for i := range tasks {
			inv.Tasks[tasks[i].ID] = &tasks[i]
		}
		progress(fmt.Sprintf("read %s (%s): %d tasks", p.Name, p.TaskIDPrefix, len(tasks)))
	}

	seen := map[string]bool{}
	for _, t := range inv.Tasks {
		if !inv.isCommitment(t) {
			continue
		}
		base := fmt.Sprintf("/api/v1/projects/%s/tasks/%s", t.ProjectID, t.ID)
		links, err := listItems[taskLink](ctx, c, base+"/links")
		if err != nil {
			return nil, fmt.Errorf("%s links: %w", inv.refOf(t), err)
		}
		for _, l := range links {
			if l.LinkType != "relates_to" || seen[l.ID] {
				continue
			}
			seen[l.ID] = true
			inv.Links = append(inv.Links, l)
		}
		acts, err := listCursor[activity](ctx, c, base+"/activities")
		if err != nil {
			return nil, fmt.Errorf("%s activities: %w", inv.refOf(t), err)
		}
		for i := len(acts) - 1; i >= 0; i-- { // oldest first
			if strings.EqualFold(acts[i].ActivityType, "comment") {
				inv.Comments[t.ID] = append(inv.Comments[t.ID], acts[i])
			}
		}
	}
	return inv, nil
}
