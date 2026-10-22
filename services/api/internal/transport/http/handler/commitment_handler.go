package handler

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/apierr"
	projectdom "github.com/Paca-AI/api/internal/domain/project"
	settingsdom "github.com/Paca-AI/api/internal/domain/settings"
	taskdom "github.com/Paca-AI/api/internal/domain/task"
	"github.com/Paca-AI/api/internal/platform/authz/iam"
	"github.com/Paca-AI/api/internal/transport/http/dto"
	"github.com/Paca-AI/api/internal/transport/http/middleware"
	"github.com/Paca-AI/api/internal/transport/http/presenter"
)

// commitmentProjectService is the slice of the project service the
// commitment handler needs: resolving a project id to its name and prefix.
type commitmentProjectService interface {
	GetByID(ctx context.Context, id uuid.UUID) (*projectdom.Project, error)
}

// commitmentSettingsService answers which project is the commitment catalog.
type commitmentSettingsService interface {
	Get(ctx context.Context) (*settingsdom.WorkspaceSettings, error)
}

// CommitmentHandler serves the workspace-wide commitment catalog: the open
// commitments any signed-in user may attach a ticket to, and the work
// attached to one commitment across every project.
//
// Both routes are deliberately NOT project-scoped. A ticket in any other
// project is attached to a commitment that lives in the Commitments project,
// and the person doing the attaching is usually not a member there — they
// need the catalog, not the project.
type CommitmentHandler struct {
	tasks    taskdom.Service
	projects commitmentProjectService
	settings commitmentSettingsService
	iam      *iam.Authorizer
}

// NewCommitmentHandler wires the handler.
func NewCommitmentHandler(tasks taskdom.Service, projects commitmentProjectService, settings commitmentSettingsService, az *iam.Authorizer) *CommitmentHandler {
	return &CommitmentHandler{tasks: tasks, projects: projects, settings: settings, iam: az}
}

// catalog resolves the configured Commitments project, its Commitment type
// and its statuses. ok is false (and the response already written) when the
// catalog is not configured.
func (h *CommitmentHandler) catalog(w http.ResponseWriter, r *http.Request) (project *projectdom.Project, commitmentType *taskdom.TaskType, statuses map[uuid.UUID]*taskdom.TaskStatus, ok bool) {
	ws, err := h.settings.Get(r.Context())
	if err != nil {
		presenter.Error(w, r, err)
		return nil, nil, nil, false
	}
	if ws.CommitmentsProjectID == nil {
		presenter.Error(w, r, taskdom.ErrCommitmentsProjectNotConfigured)
		return nil, nil, nil, false
	}
	project, err = h.projects.GetByID(r.Context(), *ws.CommitmentsProjectID)
	if err != nil {
		presenter.Error(w, r, err)
		return nil, nil, nil, false
	}
	types, err := h.tasks.ListTaskTypes(r.Context(), project.ID)
	if err != nil {
		presenter.Error(w, r, err)
		return nil, nil, nil, false
	}
	for _, t := range types {
		if strings.EqualFold(strings.TrimSpace(t.Name), taskdom.CommitmentTypeName) {
			commitmentType = t
			break
		}
	}
	if commitmentType == nil {
		presenter.Error(w, r, apierr.New(apierr.CodeCommitmentsProjectNotConfigured, "the Commitments project has no task type named \"Commitment\""))
		return nil, nil, nil, false
	}
	sts, err := h.tasks.ListTaskStatuses(r.Context(), project.ID)
	if err != nil {
		presenter.Error(w, r, err)
		return nil, nil, nil, false
	}
	statuses = make(map[uuid.UUID]*taskdom.TaskStatus, len(sts))
	for _, s := range sts {
		statuses[s.ID] = s
	}
	return project, commitmentType, statuses, true
}

// List handles GET /commitments?search=&include_closed=true.
//
// Open commitments only, unless include_closed is set: a closed commitment
// keeps the tickets it already has but is not offered for new ones. The
// catalog is small (tens of rows, never thousands), so this returns the whole
// filtered list rather than a cursor page.
func (h *CommitmentHandler) List(w http.ResponseWriter, r *http.Request) {
	project, commitmentType, statuses, ok := h.catalog(w, r)
	if !ok {
		return
	}
	filter := taskdom.TaskFilter{TaskTypeIDs: []uuid.UUID{commitmentType.ID}}
	if raw := strings.TrimSpace(r.URL.Query().Get("search")); raw != "" {
		filter.Search = &raw
	}
	includeClosed := r.URL.Query().Get("include_closed") == "true"

	const maxCatalog = 500
	items, _, err := h.tasks.ListTasks(r.Context(), project.ID, filter, maxCatalog, taskdom.TaskSort{})
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	out := make([]dto.CommitmentResponse, 0, len(items))
	homes := map[uuid.UUID]*projectdom.Project{} // home projects, looked up once each
	for _, t := range items {
		var st *taskdom.TaskStatus
		if t.StatusID != nil {
			st = statuses[*t.StatusID]
		}
		closed := st != nil && st.Category == taskdom.StatusCategoryDone
		if closed && !includeClosed {
			continue
		}
		row := dto.CommitmentFromEntity(t, project, st)
		if t.HomeProjectID != nil {
			if hp, ok := homes[*t.HomeProjectID]; ok {
				row.HomeProjectName, row.HomeProjectTaskIDPrefix = hp.Name, hp.TaskIDPrefix
			} else if hp, err := h.projects.GetByID(r.Context(), *t.HomeProjectID); err == nil {
				homes[hp.ID] = hp
				row.HomeProjectName, row.HomeProjectTaskIDPrefix = hp.Name, hp.TaskIDPrefix
			}
		}
		out = append(out, row)
	}
	presenter.OK(w, r, dto.CommitmentListResponse{
		Items:                out,
		CommitmentsProjectID: project.ID,
		TaskIDPrefix:         project.TaskIDPrefix,
	})
}

// Work handles GET /commitments/{commitmentId}/work: every ticket, in any
// project, attached to the commitment, grouped by project. Projects the
// caller may not read are dropped and counted in hidden_project_count, so a
// commitment never leaks titles across a permission boundary but the reader
// can still tell the list is incomplete.
func (h *CommitmentHandler) Work(w http.ResponseWriter, r *http.Request) {
	project, _, statuses, ok := h.catalog(w, r)
	if !ok {
		return
	}
	commitmentID, err := uuid.Parse(chi.URLParam(r, "commitmentId"))
	if err != nil {
		presenter.Error(w, r, apierr.New(apierr.CodeBadRequest, "invalid commitment id"))
		return
	}
	commitment, err := h.tasks.GetTask(r.Context(), project.ID, commitmentID)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}
	principal, err := middleware.IAMPrincipalFrom(r)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}

	work, err := h.tasks.ListCommitmentWork(r.Context(), commitmentID)
	if err != nil {
		presenter.Error(w, r, err)
		return
	}

	byProject := make(map[uuid.UUID][]*taskdom.Task)
	order := make([]uuid.UUID, 0)
	for _, t := range work {
		if _, seen := byProject[t.ProjectID]; !seen {
			order = append(order, t.ProjectID)
		}
		byProject[t.ProjectID] = append(byProject[t.ProjectID], t)
	}

	groups := make([]dto.CommitmentWorkGroup, 0, len(order))
	hidden := 0
	for _, pid := range order {
		p, err := h.projects.GetByID(r.Context(), pid)
		if err != nil {
			hidden++
			continue
		}
		// The same check the project's own task routes make (guards.Project).
		res, err := h.iam.Authorize(r.Context(), principal, string(iam.ActionTasksRead), "project/"+pid.String())
		if err != nil {
			presenter.Error(w, r, err)
			return
		}
		if !res.Allowed {
			hidden++
			continue
		}
		tasks := byProject[pid]
		sort.Slice(tasks, func(i, j int) bool { return tasks[i].TaskNumber < tasks[j].TaskNumber })
		rows := make([]dto.CommitmentWorkItem, 0, len(tasks))
		for _, t := range tasks {
			rows = append(rows, dto.CommitmentWorkItemFromEntity(t, p))
		}
		groups = append(groups, dto.CommitmentWorkGroup{
			ProjectID:    p.ID,
			ProjectName:  p.Name,
			TaskIDPrefix: p.TaskIDPrefix,
			Tasks:        rows,
		})
	}

	var st *taskdom.TaskStatus
	if commitment.StatusID != nil {
		st = statuses[*commitment.StatusID]
	}
	presenter.OK(w, r, dto.CommitmentWorkResponse{
		Commitment:         dto.CommitmentFromEntity(commitment, project, st),
		Projects:           groups,
		HiddenProjectCount: hidden,
	})
}
