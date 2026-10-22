package commitmentmigration

import (
	"context"
	"testing"

	"github.com/google/uuid"

	taskdom "github.com/Paca-AI/api/internal/domain/task"
)

func TestRunHonoursOffAndRejectsUnknownModes(t *testing.T) {
	res, err := Run(context.Background(), Deps{Mode: "off"})
	if err != nil || res.Skipped == "" {
		t.Fatalf("off: res=%+v err=%v", res, err)
	}
	if _, err := Run(context.Background(), Deps{Mode: "sometimes"}); err == nil {
		t.Fatal("an unknown mode must be refused, not treated as auto")
	}
}

func TestFindTargetPrefersTheConfiguredProject(t *testing.T) {
	configured := uuid.New()
	inv := &inventory{Projects: map[string]*project{
		configured.String(): {ID: configured.String(), Name: "Promises", TaskIDPrefix: "PRM"},
		"b":                 {ID: "b", Name: "Commitments", TaskIDPrefix: "CMT"},
		"c":                 {ID: "c", Name: "Something", TaskIDPrefix: "com"},
	}}
	if got := findTarget(inv, &configured); got == nil || got.TaskIDPrefix != "PRM" {
		t.Fatalf("configured: %+v", got)
	}
	if got := findTarget(inv, nil); got == nil || got.ID != "c" {
		t.Fatalf("by prefix (any case): %+v", got)
	}
	delete(inv.Projects, "c")
	if got := findTarget(inv, nil); got == nil || got.ID != "b" {
		t.Fatalf("by name: %+v", got)
	}
	delete(inv.Projects, "b")
	delete(inv.Projects, configured.String())
	if got := findTarget(inv, nil); got != nil {
		t.Fatalf("none: %+v", got)
	}
}

func TestMergeOptionsAppendsOnlyMissingValues(t *testing.T) {
	red := "#f00"
	have := []taskdom.CustomFieldOption{{Value: "Delivery", Color: &red}, {Value: "Internal"}}
	merged, changed := mergeOptions(have, []taskdom.CustomFieldOption{{Value: " delivery "}, {Value: "PPE"}})
	if !changed || len(merged) != 3 || merged[2].Value != "PPE" || merged[0].Color != &red {
		t.Fatalf("merged=%+v changed=%v", merged, changed)
	}
	if _, changed := mergeOptions(have, []taskdom.CustomFieldOption{{Value: "INTERNAL"}}); changed {
		t.Fatal("a case-insensitive match is not a new option")
	}
}

func TestStatusKeyKeepsCategoriesApart(t *testing.T) {
	if statusKey("Ready for Release", "done") == statusKey("ready for release ", "inprogress") {
		t.Fatal("same name in different categories must map to different statuses")
	}
	if statusKey("Ready for Release", "done") != statusKey(" ready FOR release", "done") {
		t.Fatal("name match is case- and space-insensitive")
	}
}
