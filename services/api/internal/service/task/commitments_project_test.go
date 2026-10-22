package tasksvc_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	taskdom "github.com/Paca-AI/api/internal/domain/task"
	tasksvc "github.com/Paca-AI/api/internal/service/task"
)

type fixedCatalog struct{ id *uuid.UUID }

func (c fixedCatalog) CommitmentsProjectID(context.Context) (*uuid.UUID, error) { return c.id, nil }

type commitmentsWorld struct {
	repo        *fakeTaskRepo
	svc         *tasksvc.Service
	com         uuid.UUID // the Commitments project
	other       uuid.UUID // an ordinary project
	commitment  uuid.UUID // Commitment type in com
	taskInOther uuid.UUID // Task type in other
}

func newCommitmentsWorld(t *testing.T) *commitmentsWorld {
	t.Helper()
	w := &commitmentsWorld{repo: newFakeTaskRepo(), com: uuid.New(), other: uuid.New()}
	now := time.Now()
	addType := func(project uuid.UUID, name string, isDefault, isSystem bool) uuid.UUID {
		id := uuid.New()
		w.repo.types[id] = &taskdom.TaskType{ID: id, ProjectID: project, Name: name, IsDefault: isDefault, IsSystem: isSystem, CreatedAt: now, UpdatedAt: now}
		return id
	}
	w.commitment = addType(w.com, "Commitment", true, false)
	w.taskInOther = addType(w.other, "Task", true, false)
	w.svc = tasksvc.New(w.repo).WithCommitmentCatalog(fixedCatalog{id: &w.com})
	return w
}

func TestCommitmentsProjectAcceptsOnlyCommitments(t *testing.T) {
	w := newCommitmentsWorld(t)
	ctx := context.Background()
	bug := uuid.New()
	w.repo.types[bug] = &taskdom.TaskType{ID: bug, ProjectID: w.com, Name: "Bug"}

	if _, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.com, Title: "x", TaskTypeID: &bug}); !errors.Is(err, taskdom.ErrCommitmentsProjectOnlyCommitments) {
		t.Fatalf("Bug in the Commitments project: err = %v", err)
	}
	created, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.com, Title: "Ship it"})
	if err != nil {
		t.Fatalf("default type in the Commitments project: %v", err)
	}
	if created.TaskTypeID == nil || *created.TaskTypeID != w.commitment {
		t.Fatalf("created with type %v, want the Commitment type", created.TaskTypeID)
	}
	retype := &bug
	if _, err := w.svc.UpdateTask(ctx, w.com, created.ID, taskdom.UpdateTaskInput{TaskTypeID: &retype}); !errors.Is(err, taskdom.ErrCommitmentsProjectOnlyCommitments) {
		t.Fatalf("retype to Bug: err = %v", err)
	}
	if _, err := w.svc.CreateTaskType(ctx, taskdom.CreateTaskTypeInput{ProjectID: w.com, Name: "Story"}); !errors.Is(err, taskdom.ErrCommitmentsProjectOnlyCommitments) {
		t.Fatalf("new type in the Commitments project: err = %v", err)
	}
	if err := w.svc.DeleteTaskType(ctx, w.com, w.commitment); !errors.Is(err, taskdom.ErrCommitmentsProjectOnlyCommitments) {
		t.Fatalf("delete the Commitment type: err = %v", err)
	}
	if _, err := w.svc.UpdateTaskType(ctx, w.com, w.commitment, taskdom.UpdateTaskTypeInput{Name: "Goal"}); !errors.Is(err, taskdom.ErrCommitmentsProjectOnlyCommitments) {
		t.Fatalf("rename the Commitment type: err = %v", err)
	}
	if _, err := w.svc.SetDefaultTaskType(ctx, w.com, bug); !errors.Is(err, taskdom.ErrCommitmentsProjectOnlyCommitments) {
		t.Fatalf("make Bug the default: err = %v", err)
	}
	// Other projects are untouched by the rule.
	if _, err := w.svc.CreateTaskType(ctx, taskdom.CreateTaskTypeInput{ProjectID: w.other, Name: "Story"}); err != nil {
		t.Fatalf("new type elsewhere: %v", err)
	}
}

func TestHomeProjectRules(t *testing.T) {
	w := newCommitmentsWorld(t)
	ctx := context.Background()

	c, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.com, Title: "For other", HomeProjectID: &w.other})
	if err != nil {
		t.Fatalf("commitment with a project: %v", err)
	}
	if c.HomeProjectID == nil || *c.HomeProjectID != w.other {
		t.Fatalf("home project = %v, want %v", c.HomeProjectID, w.other)
	}
	if _, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.com, Title: "Self", HomeProjectID: &w.com}); !errors.Is(err, taskdom.ErrHomeProjectInvalid) {
		t.Fatalf("project = the Commitments project: err = %v", err)
	}
	if _, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.other, Title: "Ticket", HomeProjectID: &w.other}); !errors.Is(err, taskdom.ErrHomeProjectInvalid) {
		t.Fatalf("project on an ordinary ticket: err = %v", err)
	}
	gone := uuid.New()
	w.repo.deadProjects = map[uuid.UUID]bool{gone: true}
	if _, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.com, Title: "Gone", HomeProjectID: &gone}); !errors.Is(err, taskdom.ErrHomeProjectNotFound) {
		t.Fatalf("deleted project: err = %v", err)
	}

	// Change and clear it on an existing commitment.
	third := uuid.New()
	to := &third
	if _, err := w.svc.UpdateTask(ctx, w.com, c.ID, taskdom.UpdateTaskInput{HomeProjectID: &to}); err != nil {
		t.Fatalf("change project: %v", err)
	}
	var none *uuid.UUID
	updated, err := w.svc.UpdateTask(ctx, w.com, c.ID, taskdom.UpdateTaskInput{HomeProjectID: &none})
	if err != nil {
		t.Fatalf("clear project: %v", err)
	}
	if updated.HomeProjectID != nil {
		t.Fatalf("home project = %v after clearing", updated.HomeProjectID)
	}
}

func TestPrepareCommitmentsProject(t *testing.T) {
	repo := newFakeTaskRepo()
	project := uuid.New()
	now := time.Now()
	ids := map[string]uuid.UUID{}
	for _, ty := range []struct {
		name              string
		isDefault, system bool
	}{{"Task", true, false}, {"Bug", false, false}, {"Story", false, false}, {"Epic", false, true}} {
		id := uuid.New()
		ids[ty.name] = id
		repo.types[id] = &taskdom.TaskType{ID: id, ProjectID: project, Name: ty.name, IsDefault: ty.isDefault, IsSystem: ty.system, CreatedAt: now, UpdatedAt: now}
	}
	svc := tasksvc.New(repo)
	ctx := context.Background()

	// A project still using another type is refused, and nothing is removed.
	busy := uuid.New()
	bugID := ids["Bug"]
	repo.tasks[busy] = &taskdom.Task{ID: busy, ProjectID: project, TaskTypeID: &bugID, Title: "in use"}
	if err := svc.PrepareCommitmentsProject(ctx, project); !errors.Is(err, taskdom.ErrCommitmentsProjectTypeInUse) {
		t.Fatalf("type in use: err = %v", err)
	}
	if len(repo.types) != 4 {
		t.Fatalf("types after refusal = %d, want 4 untouched", len(repo.types))
	}

	delete(repo.tasks, busy)
	if err := svc.PrepareCommitmentsProject(ctx, project); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	types, _ := repo.ListTaskTypes(ctx, project)
	if len(types) != 1 || types[0].Name != "Commitment" || !types[0].IsDefault {
		t.Fatalf("types = %+v, want only a default Commitment type", types)
	}
	// Idempotent.
	if err := svc.PrepareCommitmentsProject(ctx, project); err != nil {
		t.Fatalf("prepare again: %v", err)
	}
	if types, _ := repo.ListTaskTypes(ctx, project); len(types) != 1 {
		t.Fatalf("types after second run = %d", len(types))
	}
}

func TestCommitmentsAreCreatedOnlyInTheCommitmentsProject(t *testing.T) {
	w := newCommitmentsWorld(t)
	ctx := context.Background()
	legacy := uuid.New()
	w.repo.types[legacy] = &taskdom.TaskType{ID: legacy, ProjectID: w.other, Name: "Commitment"}

	if _, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.other, Title: "x", TaskTypeID: &legacy}); !errors.Is(err, taskdom.ErrCommitmentOutsideCommitmentsProject) {
		t.Fatalf("Commitment outside the Commitments project: err = %v", err)
	}
	ticket, err := w.svc.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.other, Title: "ticket"})
	if err != nil {
		t.Fatalf("ordinary ticket: %v", err)
	}
	to := &legacy
	if _, err := w.svc.UpdateTask(ctx, w.other, ticket.ID, taskdom.UpdateTaskInput{TaskTypeID: &to}); !errors.Is(err, taskdom.ErrCommitmentOutsideCommitmentsProject) {
		t.Fatalf("retype to Commitment outside: err = %v", err)
	}

	// Before any Commitments project exists, nothing changes for anyone.
	free := tasksvc.New(w.repo)
	if _, err := free.CreateTask(ctx, taskdom.CreateTaskInput{ProjectID: w.other, Title: "legacy", TaskTypeID: &legacy}); err != nil {
		t.Fatalf("no Commitments project configured: %v", err)
	}
}
