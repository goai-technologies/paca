package dto

import (
	"fmt"
	"time"

	"github.com/google/uuid"

	projectdom "github.com/Paca-AI/api/internal/domain/project"
	taskdom "github.com/Paca-AI/api/internal/domain/task"
)

// CommitmentResponse is one row of the commitment catalog: enough for a
// picker to render "COM-12 · Launch the customer portal · In
// Progress" and for a reader to open it. The description is deliberately
// absent — the catalog is readable by every signed-in user, the commitment's
// project may not be.
type CommitmentResponse struct {
	ID             uuid.UUID      `json:"id"`
	ProjectID      uuid.UUID      `json:"project_id"`
	TaskIDPrefix   string         `json:"task_id_prefix"`
	TaskNumber     int64          `json:"task_number"`
	Ref            string         `json:"ref"`
	Title          string         `json:"title"`
	StatusID       *uuid.UUID     `json:"status_id,omitempty"`
	StatusName     string         `json:"status_name,omitempty"`
	StatusCategory string         `json:"status_category,omitempty"`
	IsClosed       bool           `json:"is_closed"`
	DueDate        *time.Time     `json:"due_date,omitempty"`
	CustomFields   map[string]any `json:"custom_fields"`
}

// CommitmentListResponse is the body for GET /commitments.
type CommitmentListResponse struct {
	Items                []CommitmentResponse `json:"items"`
	CommitmentsProjectID uuid.UUID            `json:"commitments_project_id"`
	TaskIDPrefix         string               `json:"task_id_prefix"`
}

// CommitmentWorkItem is one ticket attached to a commitment, with the
// identity of its own project so the reader can render "OPS-3" and link
// to the right place.
type CommitmentWorkItem struct {
	ID           uuid.UUID  `json:"id"`
	ProjectID    uuid.UUID  `json:"project_id"`
	TaskIDPrefix string     `json:"task_id_prefix"`
	TaskNumber   int64      `json:"task_number"`
	Ref          string     `json:"ref"`
	Title        string     `json:"title"`
	TaskTypeID   *uuid.UUID `json:"task_type_id,omitempty"`
	StatusID     *uuid.UUID `json:"status_id,omitempty"`
	ParentTaskID *uuid.UUID `json:"parent_task_id,omitempty"`
	DueDate      *time.Time `json:"due_date,omitempty"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// CommitmentWorkGroup is the attached tickets of one project.
type CommitmentWorkGroup struct {
	ProjectID    uuid.UUID            `json:"project_id"`
	ProjectName  string               `json:"project_name"`
	TaskIDPrefix string               `json:"task_id_prefix"`
	Tasks        []CommitmentWorkItem `json:"tasks"`
}

// CommitmentWorkResponse is the body for GET /commitments/{id}/work.
type CommitmentWorkResponse struct {
	Commitment         CommitmentResponse    `json:"commitment"`
	Projects           []CommitmentWorkGroup `json:"projects"`
	HiddenProjectCount int                   `json:"hidden_project_count"`
}

func taskRef(prefix string, number int64) string {
	if prefix == "" {
		return fmt.Sprintf("#%d", number)
	}
	return fmt.Sprintf("%s-%d", prefix, number)
}

// CommitmentFromEntity maps a Commitment-typed task to its catalog row.
func CommitmentFromEntity(t *taskdom.Task, p *projectdom.Project, st *taskdom.TaskStatus) CommitmentResponse {
	cf := t.CustomFields
	if cf == nil {
		cf = map[string]any{}
	}
	out := CommitmentResponse{
		ID:           t.ID,
		ProjectID:    t.ProjectID,
		TaskIDPrefix: p.TaskIDPrefix,
		TaskNumber:   t.TaskNumber,
		Ref:          taskRef(p.TaskIDPrefix, t.TaskNumber),
		Title:        t.Title,
		StatusID:     t.StatusID,
		DueDate:      t.DueDate,
		CustomFields: cf,
	}
	if st != nil {
		out.StatusName = st.Name
		out.StatusCategory = string(st.Category)
		out.IsClosed = st.Category == taskdom.StatusCategoryDone
	}
	return out
}

// CommitmentWorkItemFromEntity maps an attached ticket to its row.
func CommitmentWorkItemFromEntity(t *taskdom.Task, p *projectdom.Project) CommitmentWorkItem {
	return CommitmentWorkItem{
		ID:           t.ID,
		ProjectID:    t.ProjectID,
		TaskIDPrefix: p.TaskIDPrefix,
		TaskNumber:   t.TaskNumber,
		Ref:          taskRef(p.TaskIDPrefix, t.TaskNumber),
		Title:        t.Title,
		TaskTypeID:   t.TaskTypeID,
		StatusID:     t.StatusID,
		ParentTaskID: t.ParentTaskID,
		DueDate:      t.DueDate,
		UpdatedAt:    t.UpdatedAt,
	}
}
