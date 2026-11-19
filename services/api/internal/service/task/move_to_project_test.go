package tasksvc_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	taskdom "github.com/Paca-AI/api/internal/domain/task"
	tasksvc "github.com/Paca-AI/api/internal/service/task"
)

func TestMoveToProject_SameProjectRejected(t *testing.T) {
	repo := newFakeTaskRepo()
	svc := tasksvc.New(repo)
	ctx := context.Background()
	p := uuid.New()
	task := seedMovableTask(repo, p, "Root")
	_, err := svc.MoveToProject(ctx, p, task.ID, p)
	if !errors.Is(err, taskdom.ErrTaskMoveSameProject) {
		t.Fatalf("got %v, want ErrTaskMoveSameProject", err)
	}
}

func TestMoveToProject_CommitmentsProjectRejected(t *testing.T) {
	repo := newFakeTaskRepo()
	com := uuid.New()
	svc := tasksvc.New(repo).WithCommitmentCatalog(fixedCatalog{id: &com})
	ctx := context.Background()
	src := uuid.New()
	task := seedMovableTask(repo, src, "Root")

	_, err := svc.MoveToProject(ctx, src, task.ID, com)
	if !errors.Is(err, taskdom.ErrTaskMoveCommitmentsProject) {
		t.Fatalf("into commitments: got %v", err)
	}

	comTask := seedMovableTask(repo, com, "Commitment card")
	_, err = svc.MoveToProject(ctx, com, comTask.ID, src)
	if !errors.Is(err, taskdom.ErrTaskMoveCommitmentsProject) {
		t.Fatalf("out of commitments: got %v", err)
	}
}

func TestMoveToProject_TargetNotFound(t *testing.T) {
	repo := newFakeTaskRepo()
	svc := tasksvc.New(repo)
	ctx := context.Background()
	src := uuid.New()
	task := seedMovableTask(repo, src, "Root")
	missing := uuid.New()
	repo.deadProjects = map[uuid.UUID]bool{missing: true}
	_, err := svc.MoveToProject(ctx, src, task.ID, missing)
	if !errors.Is(err, taskdom.ErrTaskMoveTargetNotFound) {
		t.Fatalf("got %v, want ErrTaskMoveTargetNotFound", err)
	}
}

func TestMoveToProject_MovesSubtreeAndDetachesRoot(t *testing.T) {
	repo := newFakeTaskRepo()
	svc := tasksvc.New(repo)
	ctx := context.Background()
	src := uuid.New()
	dst := uuid.New()

	root := seedMovableTask(repo, src, "Root")
	outsideParent := seedMovableTask(repo, src, "Outside parent")
	root.ParentTaskID = &outsideParent.ID
	_ = repo.UpdateTask(ctx, root)

	child := seedMovableTask(repo, src, "Child")
	child.ParentTaskID = &root.ID
	_ = repo.UpdateTask(ctx, child)

	grand := seedMovableTask(repo, src, "Grandchild")
	grand.ParentTaskID = &child.ID
	_ = repo.UpdateTask(ctx, grand)

	moved, err := svc.MoveToProject(ctx, src, root.ID, dst)
	if err != nil {
		t.Fatalf("MoveToProject: %v", err)
	}
	if moved.ProjectID != dst {
		t.Fatalf("root project = %s, want %s", moved.ProjectID, dst)
	}
	if moved.ParentTaskID != nil {
		t.Fatalf("root parent should be cleared, got %v", moved.ParentTaskID)
	}

	gotChild, err := repo.FindTaskByID(ctx, child.ID)
	if err != nil {
		t.Fatalf("child: %v", err)
	}
	if gotChild.ProjectID != dst {
		t.Fatalf("child project = %s, want %s", gotChild.ProjectID, dst)
	}
	if gotChild.ParentTaskID == nil || *gotChild.ParentTaskID != root.ID {
		t.Fatalf("child parent = %v, want root", gotChild.ParentTaskID)
	}

	gotGrand, err := repo.FindTaskByID(ctx, grand.ID)
	if err != nil {
		t.Fatalf("grand: %v", err)
	}
	if gotGrand.ProjectID != dst {
		t.Fatalf("grandchild project = %s, want %s", gotGrand.ProjectID, dst)
	}

	still, err := repo.FindTaskByID(ctx, outsideParent.ID)
	if err != nil {
		t.Fatalf("outside parent: %v", err)
	}
	if still.ProjectID != src {
		t.Fatalf("outside parent should stay in source, got %s", still.ProjectID)
	}
}

func seedMovableTask(repo *fakeTaskRepo, projectID uuid.UUID, title string) *taskdom.Task {
	t := &taskdom.Task{
		ID:        uuid.New(),
		ProjectID: projectID,
		Title:     title,
	}
	_ = repo.CreateTask(context.Background(), t)
	return t
}
