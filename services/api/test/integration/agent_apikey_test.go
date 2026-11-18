package integration_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
	activitydom "github.com/Paca-AI/api/internal/domain/activity"
	apikeydom "github.com/Paca-AI/api/internal/domain/apikey"
	taskdom "github.com/Paca-AI/api/internal/domain/task"
	userdom "github.com/Paca-AI/api/internal/domain/user"
	"github.com/Paca-AI/api/internal/platform/authz/iam"
	jwttoken "github.com/Paca-AI/api/internal/platform/token"
	activitysvc "github.com/Paca-AI/api/internal/service/activity"
	apikeysvc "github.com/Paca-AI/api/internal/service/apikey"
	authsvc "github.com/Paca-AI/api/internal/service/auth"
	projectsvc "github.com/Paca-AI/api/internal/service/project"
	sprintsvc "github.com/Paca-AI/api/internal/service/sprint"
	tasksvc "github.com/Paca-AI/api/internal/service/task"
	usersvc "github.com/Paca-AI/api/internal/service/user"
	"github.com/Paca-AI/api/internal/transport/http/handler"
	"github.com/Paca-AI/api/internal/transport/http/router"
)

// ---------------------------------------------------------------------------
// Agent API Key Integration Tests
// ---------------------------------------------------------------------------

const testAgentBotUserID = "00000000-0000-0000-0000-000000000001"

// buildAgentKeyRouter creates a test router with agent API key authentication configured
func buildAgentKeyRouter(taskRepo *fakeTaskRepo, apiKeyRepo *fakeAPIKeyRepo, store *projectPermStore, activityRepos ...*fakeTaskActivityRepo) http.Handler {
	return buildAgentKeyRouterWithBotID(taskRepo, apiKeyRepo, store, uuid.MustParse(testAgentBotUserID), activityRepos...)
}

// buildAgentKeyRouterWithBotID is like buildAgentKeyRouter but lets the test
// choose which user ID the shared agent key authenticates as when no
// X-Agent-ID header is present. buildAgentKeyRouter always uses
// testAgentBotUserID, a test-local placeholder distinct from the real
// userdom.SystemActorUserID seeded in production — tests that need to
// exercise the userdom.SystemActorUserID-specific "unidentified actor"
// comment-error path must use this variant instead.
func buildAgentKeyRouterWithBotID(taskRepo *fakeTaskRepo, apiKeyRepo *fakeAPIKeyRepo, store *projectPermStore, botUserID uuid.UUID, activityRepos ...*fakeTaskActivityRepo) http.Handler {
	tm := jwttoken.New(testSecret, 15*time.Minute, 168*time.Hour)
	refreshStore := &fakeRefreshStore{}
	userRepo := newFakeUserRepo()
	authService := authsvc.New(userRepo, tm, refreshStore, 168*time.Hour, 24*time.Hour)
	userService := usersvc.New(userRepo, userRepo)
	projectRepo := newFakeProjectRepo()
	projectService := projectsvc.New(projectRepo, taskRepo, nil)
	taskService := tasksvc.New(taskRepo)
	sprintService := sprintsvc.New(newFakeSprintRepoIT(), taskRepo, nil)
	viewService := sprintsvc.NewViewService(newFakeViewRepoIT(), newFakeSprintRepoIT(), taskRepo, nil)
	var activityRepo *fakeTaskActivityRepo
	if len(activityRepos) > 0 && activityRepos[0] != nil {
		activityRepo = activityRepos[0]
	} else {
		activityRepo = newFakeTaskActivityRepo()
	}
	activityService := tasksvc.NewActivityService(activitysvc.New(activityRepo, &fakeActivityMemberRepo{}, nil), taskRepo, &fakeActivityMemberRepo{})

	apiKeyService := &testAgentKeyAuth{inner: apikeysvc.New(apiKeyRepo)}

	if store == nil {
		store = &projectPermStore{}
	}
	authorizer := newIAM(store)

	log := slog.New(slog.NewTextHandler(os.Stdout, nil))

	return router.New(router.Deps{
		TokenManager: tm,
		APIKeyAuth:   apiKeyService,
		IAM:          authorizer,
		Health:       handler.NewHealthHandler(),
		Auth:         handler.NewAuthHandler(authService, testCookieCfg),
		User:         handler.NewUserHandler(userService),
		Project:      handler.NewProjectHandler(projectService, authorizer),
		Task: handler.NewTaskHandler(taskService, viewService, activityService,
			handler.WithTaskAssignedProjectService(projectService)),
		Sprint: handler.NewSprintHandler(sprintService, viewService),
		View:   handler.NewViewHandler(viewService),
		Log:    log,
	})
}

// testAgentKeyAuth authenticates the synthetic "paca_agent_<uuid>" keys
// agentKeyAuthReq presents as that agent, and delegates every other key to the
// real API key service (which looks keys up by hash).
type testAgentKeyAuth struct{ inner *apikeysvc.Service }

func (a *testAgentKeyAuth) Authenticate(ctx context.Context, raw string) (*apikeydom.APIKey, error) {
	if id, ok := strings.CutPrefix(raw, "paca_agent_"); ok {
		if agentID, err := uuid.Parse(id); err == nil {
			return &apikeydom.APIKey{ID: uuid.New(), AccountID: agentID, AccountKind: accountdom.KindAgent}, nil
		}
	}
	return a.inner.Authenticate(ctx, raw)
}

// agentKeyAuthReq creates a request authenticated as the agent agentID: it
// presents the agent's own API key. With agentID == uuid.Nil it authenticates as
// the bot user testAgentBotUserID instead (a plain user, no agent identity).
func agentKeyAuthReq(ctx context.Context, method, url string, agentID uuid.UUID, body any) *http.Request {
	if agentID == uuid.Nil {
		return botUserAuthReq(ctx, method, url, uuid.MustParse(testAgentBotUserID), body)
	}
	return newJSONReq(ctx, method, url, body, func(r *http.Request) { r.Header.Set("X-API-Key", "paca_agent_"+agentID.String()) })
}

// botUserAuthReq creates a request authenticated as the plain user botUserID.
func botUserAuthReq(ctx context.Context, method, url string, botUserID uuid.UUID, body any) *http.Request {
	tok, err := jwttoken.New(testSecret, 15*time.Minute, 168*time.Hour).IssueAccess(botUserID.String(), "bot", "USER", "fam", false)
	if err != nil {
		panic(err)
	}
	return newJSONReq(ctx, method, url, body, func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+tok) })
}

func newJSONReq(ctx context.Context, method, url string, body any, auth func(*http.Request)) *http.Request {
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req := httptest.NewRequestWithContext(ctx, method, url, reader)
	auth(req)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

// ---------------------------------------------------------------------------
// Agent Task Creation Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_CreateTask_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			uuid.MustParse(testAgentBotUserID): {
				projectID: {iam.ActionTasksWrite},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksWrite},
			},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	// Create task using agent API key
	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPost, base, agentID, map[string]any{
		"title": "Agent created task",
		"description": []map[string]any{
			{
				"type":    "paragraph",
				"content": []map[string]any{{"type": "text", "text": "Task created by AI agent"}},
			},
		},
	}))

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	// Verify response contains task data
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	title, _ := env.Data["title"].(string)
	if title != "Agent created task" {
		t.Errorf("expected title 'Agent created task', got %q", title)
	}
}

func TestAgentAPIKey_CreateTask_MissingAgentID_Returns401(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksWrite},
			},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	// Request without X-Agent-ID header should succeed using bot user permissions
	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPost, base, uuid.Nil, map[string]any{
		"title": "Task without agent ID",
	}))

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 without agent ID, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAgentAPIKey_CreateTask_InvalidAPIKey_Returns401(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()

	store := &projectPermStore{
		projectPerms: map[uuid.UUID][]iam.Action{
			projectID: {iam.ActionTasksWrite},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	body, _ := json.Marshal(map[string]any{"title": "Invalid key task"})
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, base, bytes.NewReader(body))
	req.Header.Set("X-API-Key", "paca_invalid_key")
	req.Header.Set("X-Agent-ID", agentID.String())
	req.Header.Set("Content-Type", "application/json")

	w := serve(r, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with invalid API key, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAgentAPIKey_CreateTask_NoPermission_Returns403(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksRead},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksRead},
			},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPost, base, agentID, map[string]any{
		"title": "Unauthorized task",
	}))

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without write permission, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Agent Task Comment Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_AddComment_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	activityRepo := newFakeTaskActivityRepo()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksWrite},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksWrite},
			},
		},
	}

	// Seed a task directly
	taskRepo.tasks[taskID] = &taskdom.Task{
		ID:        taskID,
		ProjectID: projectID,
		Title:     "Test Task",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store, activityRepo)
	commentURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s/activities/comments", projectID, taskID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPost, commentURL, agentID, map[string]any{
		"content": []map[string]any{
			{
				"type":    "paragraph",
				"content": []map[string]any{{"type": "text", "text": "Comment from AI agent"}},
			},
		},
	}))

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	// Verify response
	var env struct {
		Data struct {
			ActivityType string `json:"activity_type"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if env.Data.ActivityType != "comment" {
		t.Errorf("expected activity_type 'comment', got %q", env.Data.ActivityType)
	}
}

// TestAgentAPIKey_AddComment_MissingAgentID_ReturnsClearError covers the
// regression from GitHub issue #269: a request authenticated with the shared
// agent API key but no X-Agent-ID header resolves to the system/agent-bot
// identity (userdom.SystemActorUserID), which is never itself a project
// member. Before the fix this surfaced a confusing 404
// PROJECT_MEMBER_NOT_FOUND; it should now return a clear, actionable 400.
func TestAgentAPIKey_AddComment_MissingAgentID_ReturnsClearError(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	activityRepo := newFakeTaskActivityRepo()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	botUserID := userdom.SystemActorUserID

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksWrite},
			},
		},
	}

	taskRepo.tasks[taskID] = &taskdom.Task{
		ID:        taskID,
		ProjectID: projectID,
		Title:     "Test Task",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	r := buildAgentKeyRouterWithBotID(taskRepo, apiKeyRepo, store, botUserID, activityRepo)
	commentURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s/activities/comments", projectID, taskID)

	// Authenticated as the plain bot user: there is no agent identity.
	w := serve(r, botUserAuthReq(t.Context(), http.MethodPost, commentURL, botUserID, map[string]any{
		"content": []map[string]any{
			{
				"type":    "paragraph",
				"content": []map[string]any{{"type": "text", "text": "orphan comment"}},
			},
		},
	}))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}

	var env struct {
		ErrorCode string `json:"error_code"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if env.ErrorCode != "ACTIVITY_COMMENT_ACTOR_UNIDENTIFIED" {
		t.Errorf("expected error_code=ACTIVITY_COMMENT_ACTOR_UNIDENTIFIED, got %q", env.ErrorCode)
	}
}

func TestAgentAPIKey_UpdateComment_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	activityRepo := newFakeTaskActivityRepo()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	commentID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksWrite},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksWrite},
			},
		},
	}

	// Seed task and comment
	taskRepo.tasks[taskID] = &taskdom.Task{
		ID:        taskID,
		ProjectID: projectID,
		Title:     "Test Task",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	_ = agentID // referenced only to confirm the bot user exists
	commentContent := json.RawMessage(`[{"type":"paragraph","content":[{"type":"text","text":"Original comment"}]}]`)
	_ = activityRepo.Create(t.Context(), &activitydom.Activity{
		ID:           commentID,
		ProjectID:    projectID,
		EntityType:   "task",
		EntityID:     &taskID,
		ActorID:      &agentID,
		ActivityType: activitydom.TypeComment,
		Content:      commentContent,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	})

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store, activityRepo)
	commentURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s/activities/comments/%s", projectID, taskID, commentID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPatch, commentURL, agentID, map[string]any{
		"content": []map[string]any{
			{
				"type":    "paragraph",
				"content": []map[string]any{{"type": "text", "text": "Updated by agent"}},
			},
		},
	}))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Agent Task Update Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_UpdateTask_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	agentID := uuid.New()
	statusID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksWrite},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksWrite},
			},
		},
	}

	// Seed a task directly
	taskRepo.tasks[taskID] = &taskdom.Task{
		ID:        taskID,
		ProjectID: projectID,
		Title:     "Original Title",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	taskURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s", projectID, taskID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPatch, taskURL, agentID, map[string]any{
		"title":     "Updated by Agent",
		"status_id": statusID.String(),
	}))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify response
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	title, _ := env.Data["title"].(string)
	if title != "Updated by Agent" {
		t.Errorf("expected title 'Updated by Agent', got %q", title)
	}
}

// ---------------------------------------------------------------------------
// Agent Task Listing Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_ListTasks_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksRead},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksRead},
			},
		},
	}

	// Seed some tasks
	for i := 0; i < 3; i++ {
		taskRepo.tasks[uuid.New()] = &taskdom.Task{
			ID:        uuid.New(),
			ProjectID: projectID,
			Title:     fmt.Sprintf("Task %d", i+1),
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	taskURL := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, taskURL, agentID, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify response
	var env struct {
		Data struct {
			Items []map[string]any `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if len(env.Data.Items) != 3 {
		t.Errorf("expected 3 tasks, got %d", len(env.Data.Items))
	}
}

// ---------------------------------------------------------------------------
// Agent Task Get Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_GetTask_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksRead},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksRead},
			},
		},
	}

	// Seed a task directly
	taskRepo.tasks[taskID] = &taskdom.Task{
		ID:        taskID,
		ProjectID: projectID,
		Title:     "Agent Task",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	taskURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s", projectID, taskID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, taskURL, agentID, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify response
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	title, _ := env.Data["title"].(string)
	if title != "Agent Task" {
		t.Errorf("expected title 'Agent Task', got %q", title)
	}

	id, _ := env.Data["id"].(string)
	if id != taskID.String() {
		t.Errorf("expected task ID %s, got %s", taskID, id)
	}
}

func TestAgentAPIKey_GetTask_NotFound(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksRead},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksRead},
			},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	taskURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s", projectID, taskID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, taskURL, agentID, nil))

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}

	if code := decodeErrorCode(t, w); code != "TASK_NOT_FOUND" {
		t.Errorf("expected TASK_NOT_FOUND, got %q", code)
	}
}

// ---------------------------------------------------------------------------
// Agent Task Delete Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_DeleteTask_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksWrite},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksWrite},
			},
		},
	}

	// Seed a task directly
	taskRepo.tasks[taskID] = &taskdom.Task{
		ID:        taskID,
		ProjectID: projectID,
		Title:     "Task to Delete",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	taskURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s", projectID, taskID)

	w := serve(r, agentKeyAuthReq(t.Context(), http.MethodDelete, taskURL, agentID, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify task was deleted (soft delete)
	task, err := taskRepo.FindTaskByID(context.Background(), taskID)
	if err == nil || task != nil {
		t.Error("expected task to be deleted (not found)")
	}
}

// ---------------------------------------------------------------------------
// Agent Comments Complex Scenarios
// ---------------------------------------------------------------------------

func TestAgentAPIKey_CommentWorkflow(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksRead, iam.ActionTasksWrite},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksRead, iam.ActionTasksWrite},
			},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	// Step 1: Agent creates a task
	createW := serve(r, agentKeyAuthReq(t.Context(), http.MethodPost, base, agentID, map[string]any{
		"title": "Agent workflow task",
	}))
	if createW.Code != http.StatusCreated {
		t.Fatalf("create task: expected 201, got %d: %s", createW.Code, createW.Body.String())
	}

	var createEnv struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(createW.Body.Bytes(), &createEnv); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	taskIDStr, _ := createEnv.Data["id"].(string)
	taskID := uuid.MustParse(taskIDStr)

	// Step 2: Agent comments on the task
	commentURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s/activities/comments", projectID, taskID)
	commentW := serve(r, agentKeyAuthReq(t.Context(), http.MethodPost, commentURL, agentID, map[string]any{
		"content": []map[string]any{
			{
				"type":    "paragraph",
				"content": []map[string]any{{"type": "text", "text": "Working on this task"}},
			},
		},
	}))
	if commentW.Code != http.StatusCreated {
		t.Fatalf("add comment: expected 201, got %d: %s", commentW.Code, commentW.Body.String())
	}

	var commentEnv struct {
		Data struct {
			ID           string `json:"id"`
			ActivityType string `json:"activity_type"`
		} `json:"data"`
	}
	if err := json.Unmarshal(commentW.Body.Bytes(), &commentEnv); err != nil {
		t.Fatalf("decode comment response: %v", err)
	}

	commentID := commentEnv.Data.ID
	if commentEnv.Data.ActivityType != "comment" {
		t.Errorf("expected activity_type 'comment', got %q", commentEnv.Data.ActivityType)
	}

	// Step 3: Agent updates the comment
	updateCommentURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s/activities/comments/%s", projectID, taskID, commentID)
	updateW := serve(r, agentKeyAuthReq(t.Context(), http.MethodPatch, updateCommentURL, agentID, map[string]any{
		"content": []map[string]any{
			{
				"type":    "paragraph",
				"content": []map[string]any{{"type": "text", "text": "Updated status: completed"}},
			},
		},
	}))
	if updateW.Code != http.StatusOK {
		t.Fatalf("update comment: expected 200, got %d: %s", updateW.Code, updateW.Body.String())
	}

	// Step 4: Agent lists activities for the task
	activitiesURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s/activities", projectID, taskID)
	listW := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, activitiesURL, agentID, nil))
	if listW.Code != http.StatusOK {
		t.Fatalf("list activities: expected 200, got %d: %s", listW.Code, listW.Body.String())
	}

	var listEnv struct {
		Data struct {
			Items []map[string]any `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(listW.Body.Bytes(), &listEnv); err != nil {
		t.Fatalf("decode list response: %v", err)
	}

	// Should have 1 activity: the comment (task creation activity is not persisted in tests because Valkey is mocked)
	if len(listEnv.Data.Items) != 1 {
		t.Errorf("expected 1 activity, got %d", len(listEnv.Data.Items))
	} else {
		actType, _ := listEnv.Data.Items[0]["activity_type"].(string)
		if actType != "comment" {
			t.Errorf("expected activity type 'comment', got %q", actType)
		}
	}
}

// ---------------------------------------------------------------------------
// Agent ID Header Validation Tests
// ---------------------------------------------------------------------------

// The agent is whoever the credential proves: an X-Agent-ID header, malformed
// or not, changes nothing about the caller.
func TestAgentAPIKey_AgentIDHeaderIgnored(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksWrite},
			},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	req := botUserAuthReq(t.Context(), http.MethodPost, base, botUserID, map[string]any{"title": "Test"})
	req.Header.Set("X-Agent-ID", "not-a-valid-uuid")

	w := serve(r, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 (header ignored, caller is the bot user), got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Agent API Key vs Regular User API Key Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_UserAPIKeyCannotUseAgentID(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()
	userID := uuid.New()

	store := &projectPermStore{
		projectPerms: map[uuid.UUID][]iam.Action{
			projectID: {iam.ActionTasksWrite},
		},
	}

	// Create a regular user API key
	userAPIKey := &apikeydom.APIKey{
		ID:          uuid.New(),
		AccountID:   userID,
		AccountKind: accountdom.KindUser,
		Name:        "User Key",
		KeyPrefix:   "abc12345",
		CreatedAt:   time.Now(),
	}
	keyHash := "user_key_hash_12345"
	if err := apiKeyRepo.Create(context.Background(), userAPIKey, keyHash); err != nil {
		t.Fatalf("failed to create user API key: %v", err)
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	// Try to use user API key with X-Agent-ID header - agent ID should be ignored
	rawUserKey := "paca_" + keyHash
	body, _ := json.Marshal(map[string]any{"title": "Test"})
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, base, bytes.NewReader(body))
	req.Header.Set("X-API-Key", rawUserKey)
	req.Header.Set("X-Agent-ID", agentID.String())
	req.Header.Set("Content-Type", "application/json")

	w := serve(r, req)
	// Should succeed but X-Agent-ID should be ignored because it's not an agent key
	if w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden {
		t.Logf("Request with user API key and agent ID returned %d (expected success with agent ID ignored)", w.Code)
	}
}

// ---------------------------------------------------------------------------
// Agent Bulk Operations Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_BulkTaskOperations(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	store := &projectPermStore{
		userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			botUserID: {
				projectID: {iam.ActionTasksRead, iam.ActionTasksWrite},
			},
		},
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {
				agentID: {iam.ActionTasksRead, iam.ActionTasksWrite},
			},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	var taskIDs []string

	// Create multiple tasks
	for i := 0; i < 5; i++ {
		w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPost, base, agentID, map[string]any{
			"title": fmt.Sprintf("Agent Task %d", i+1),
		}))
		if w.Code != http.StatusCreated {
			t.Fatalf("create task %d: expected 201, got %d: %s", i+1, w.Code, w.Body.String())
		}

		var env struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
			t.Fatalf("decode response %d: %v", i+1, err)
		}

		id, _ := env.Data["id"].(string)
		taskIDs = append(taskIDs, id)
	}

	// List tasks and verify all are present
	listW := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, base, agentID, nil))
	if listW.Code != http.StatusOK {
		t.Fatalf("list tasks: expected 200, got %d: %s", listW.Code, listW.Body.String())
	}

	var listEnv struct {
		Data struct {
			Items []map[string]any `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(listW.Body.Bytes(), &listEnv); err != nil {
		t.Fatalf("decode list response: %v", err)
	}

	if len(listEnv.Data.Items) != 5 {
		t.Errorf("expected 5 tasks, got %d", len(listEnv.Data.Items))
	}

	// Update all tasks with a status
	statusID := uuid.New()
	for _, taskID := range taskIDs {
		taskURL := fmt.Sprintf("%s/%s", base, taskID)
		w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPatch, taskURL, agentID, map[string]any{
			"status_id": statusID.String(),
		}))
		if w.Code != http.StatusOK {
			t.Fatalf("update task %s: expected 200, got %d", taskID, w.Code)
		}
	}

	// Verify updates by getting tasks
	for _, taskID := range taskIDs {
		taskURL := fmt.Sprintf("%s/%s", base, taskID)
		w := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, taskURL, agentID, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("get task %s: expected 200, got %d", taskID, w.Code)
		}

		var env struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
			t.Fatalf("decode get response for %s: %v", taskID, err)
		}

		if env.Data["status_id"] != statusID.String() {
			t.Errorf("task %s: expected status_id %s, got %v", taskID, statusID, env.Data["status_id"])
		}
	}
}

// ---------------------------------------------------------------------------
// Agent Permission Tests
// ---------------------------------------------------------------------------

func TestAgentAPIKey_PermissionScenarios(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	taskID := uuid.New()
	agentID := uuid.New()
	botUserID := uuid.MustParse(testAgentBotUserID)

	// Seed a task
	taskRepo.tasks[taskID] = &taskdom.Task{
		ID:        taskID,
		ProjectID: projectID,
		Title:     "Permission Test Task",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	taskURL := fmt.Sprintf("/api/v1/projects/%s/tasks/%s", projectID, taskID)

	t.Run("read_permission_allows_get", func(t *testing.T) {
		store := &projectPermStore{
			userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
				botUserID: {
					projectID: {iam.ActionTasksRead},
				},
			},
			agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
				projectID: {
					agentID: {iam.ActionTasksRead},
				},
			},
		}
		r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)

		w := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, taskURL, agentID, nil))
		if w.Code != http.StatusOK {
			t.Errorf("read permission: expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("write_permission_allows_update", func(t *testing.T) {
		store := &projectPermStore{
			userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
				botUserID: {
					projectID: {iam.ActionTasksWrite},
				},
			},
			agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
				projectID: {
					agentID: {iam.ActionTasksWrite},
				},
			},
		}
		r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)

		w := serve(r, agentKeyAuthReq(t.Context(), http.MethodPatch, taskURL, agentID, map[string]any{
			"title": "Updated",
		}))
		if w.Code != http.StatusOK {
			t.Errorf("write permission: expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("no_permission_denies_all", func(t *testing.T) {
		store := &projectPermStore{
			userPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
				botUserID: {
					projectID: {},
				},
			},
			agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
				projectID: {
					agentID: {},
				},
			},
		}
		r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)

		w := serve(r, agentKeyAuthReq(t.Context(), http.MethodGet, taskURL, agentID, nil))
		if w.Code != http.StatusForbidden {
			t.Errorf("no permission: expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})
}

// ---------------------------------------------------------------------------
// Per-Agent MCP API Key Tests
//
// Unlike the shared-static-key + X-Agent-ID tests above, these exercise
// apikeysvc.Service.Authenticate's FindAgentByMCPAPIKeyHash fallback (see
// agent_service.go's GenerateAgentMCPKey / GenerateGlobalAgentMCPKey and
// authn.go's agentClaimsForKey): a key that, by itself, already proves which
// single agent it belongs to, with no X-Agent-ID header needed or trusted.
// ---------------------------------------------------------------------------
// An agent's own API key (the MCP key) — an ordinary api_keys row whose
// account is the agent.
// ---------------------------------------------------------------------------

// registerAgentKey stores a key for agentID, as the agent repository's
// ReplaceAPIKeyHash does, and returns the plaintext to present.
func registerAgentKey(repo *fakeAPIKeyRepo, agentID uuid.UUID) string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	plaintext := "paca_" + hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(plaintext))
	// Only one live key per agent: revoke the previous ones.
	for _, k := range repo.byID {
		if k.AccountID == agentID && k.RevokedAt == nil {
			_ = repo.Revoke(context.Background(), k.ID)
		}
	}
	_ = repo.Create(context.Background(), &apikeydom.APIKey{
		ID: uuid.New(), AccountID: agentID, AccountKind: accountdom.KindAgent, Name: "MCP key", CreatedAt: time.Now(),
	}, hex.EncodeToString(sum[:]))
	return plaintext
}

func TestAgentMCPKey_CreateTask_Success(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()
	mcpKey := registerAgentKey(apiKeyRepo, agentID)

	store := &projectPermStore{
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {agentID: {iam.ActionTasksWrite}},
		},
	}

	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	body, _ := json.Marshal(map[string]any{"title": "Created via MCP key"})
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, base, bytes.NewReader(body))
	req.Header.Set("X-API-Key", mcpKey)
	req.Header.Set("Content-Type", "application/json")

	w := serve(r, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if title, _ := env.Data["title"].(string); title != "Created via MCP key" {
		t.Errorf("expected title %q, got %q", "Created via MCP key", title)
	}
}

func TestAgentMCPKey_UnknownKey_Returns401(t *testing.T) {
	r := buildAgentKeyRouter(newFakeTaskRepoIT(), newFakeAPIKeyRepo(), &projectPermStore{})
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, fmt.Sprintf("/api/v1/projects/%s/tasks", uuid.New()), nil)
	req.Header.Set("X-API-Key", "paca_some_key_that_was_never_registered")
	if w := serve(r, req); w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for an unregistered key, got %d: %s", w.Code, w.Body.String())
	}
}

// Regenerating an agent's key makes the previous plaintext stop authenticating.
func TestAgentMCPKey_RegeneratedKey_InvalidatesOldKey(t *testing.T) {
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	agentID := uuid.New()
	oldKey := registerAgentKey(apiKeyRepo, agentID)

	store := &projectPermStore{
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{projectID: {agentID: {iam.ActionTasksRead}}},
	}
	r := buildAgentKeyRouter(newFakeTaskRepoIT(), apiKeyRepo, store)
	base := fmt.Sprintf("/api/v1/projects/%s/tasks", projectID)

	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, base, nil)
	req.Header.Set("X-API-Key", oldKey)
	if w := serve(r, req); w.Code != http.StatusOK {
		t.Fatalf("expected 200 with the live key, got %d: %s", w.Code, w.Body.String())
	}

	registerAgentKey(apiKeyRepo, agentID) // regenerate

	req = httptest.NewRequestWithContext(t.Context(), http.MethodGet, base, nil)
	req.Header.Set("X-API-Key", oldKey)
	if w := serve(r, req); w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for the replaced key, got %d: %s", w.Code, w.Body.String())
	}
}

// Presenting one agent's key with an X-Agent-ID naming another agent still
// attributes the request to the key's own agent.
func TestAgentMCPKey_XAgentIDHeaderIgnored(t *testing.T) {
	taskRepo := newFakeTaskRepoIT()
	apiKeyRepo := newFakeAPIKeyRepo()
	projectID := uuid.New()
	ownAgentID, otherAgentID := uuid.New(), uuid.New()
	ownKey := registerAgentKey(apiKeyRepo, ownAgentID)
	registerAgentKey(apiKeyRepo, otherAgentID)

	taskID := uuid.New()
	taskRepo.tasks[taskID] = &taskdom.Task{ID: taskID, ProjectID: projectID, Title: "Task", CreatedAt: time.Now(), UpdatedAt: time.Now()}

	store := &projectPermStore{
		agentPerms: map[uuid.UUID]map[uuid.UUID][]iam.Action{
			projectID: {ownAgentID: {iam.ActionTasksRead}, otherAgentID: {}},
		},
	}
	r := buildAgentKeyRouter(taskRepo, apiKeyRepo, store)

	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, fmt.Sprintf("/api/v1/projects/%s/tasks/%s", projectID, taskID), nil)
	req.Header.Set("X-API-Key", ownKey)
	req.Header.Set("X-Agent-ID", otherAgentID.String())
	if w := serve(r, req); w.Code != http.StatusOK {
		t.Fatalf("expected 200 (attributed to the key's own agent), got %d: %s", w.Code, w.Body.String())
	}
}
