package commitmentmigration

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// Wire shapes, trimmed to the fields the migration reads or writes.

type project struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	TaskIDPrefix string         `json:"task_id_prefix"`
	Settings     map[string]any `json:"settings"`
}

type taskType struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsDefault bool   `json:"is_default"`
}

type taskStatus struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Color    *string `json:"color"`
	Position int     `json:"position"`
}

type fieldOption struct {
	Value string  `json:"value"`
	Color *string `json:"color,omitempty"`
}

type customField struct {
	ID          string        `json:"id"`
	FieldKey    string        `json:"field_key"`
	DisplayName string        `json:"display_name"`
	FieldType   string        `json:"field_type"`
	Options     []fieldOption `json:"options"`
	IsRequired  bool          `json:"is_required"`
}

type member struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Username   string `json:"username"`
	FullName   string `json:"full_name"`
	MemberType string `json:"member_type"`
}

type role struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type task struct {
	ID               string          `json:"id"`
	ProjectID        string          `json:"project_id"`
	TaskNumber       int64           `json:"task_number"`
	Title            string          `json:"title"`
	TaskTypeID       *string         `json:"task_type_id"`
	StatusID         *string         `json:"status_id"`
	ParentTaskID     *string         `json:"parent_task_id"`
	CommitmentTaskID *string         `json:"commitment_task_id"`
	Description      json.RawMessage `json:"description"`
	Importance       int             `json:"importance"`
	StoryPoints      *int            `json:"story_points"`
	AssigneeIDs      []string        `json:"assignee_ids"`
	ReporterID       *string         `json:"reporter_id"`
	CustomFields     map[string]any  `json:"custom_fields"`
	StartDate        *time.Time      `json:"start_date"`
	DueDate          *time.Time      `json:"due_date"`
	Tags             []string        `json:"tags"`
	CreatedAt        time.Time       `json:"created_at"`
}

type taskLink struct {
	ID           string `json:"id" db:"id"`
	SourceTaskID string `json:"source_task_id" db:"source_task_id"`
	TargetTaskID string `json:"target_task_id" db:"target_task_id"`
	LinkType     string `json:"link_type" db:"link_type"`
}

type activity struct {
	ID           string          `json:"id"`
	ActivityType string          `json:"activity_type"`
	ActorName    string          `json:"actor_name"`
	Content      json.RawMessage `json:"content"`
	CreatedAt    time.Time       `json:"created_at"`
}

// commitmentTypeName is matched the way PACA's own service and every reader
// match it: trimmed, any case.
const commitmentTypeName = "commitment"

func isCommitmentType(name string) bool {
	return strings.EqualFold(strings.TrimSpace(name), commitmentTypeName)
}

func ref(prefix string, n int64) string {
	return prefix + "-" + strconv.FormatInt(n, 10)
}
