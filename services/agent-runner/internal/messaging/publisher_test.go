package messaging

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

func newTestPublisher(t *testing.T) (*Publisher, *redis.Client) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { client.Close() })
	return NewPublisher(client), client
}

// subscribeAndPublish subscribes to channel, runs publish (expected to
// itself publish to that channel) in a goroutine, and returns the first
// message received.
//
// Subscribing before starting publish — rather than starting publish
// immediately and racing a 50ms sleep against subscribeOne's own setup, as
// this used to — guarantees the message can't be missed. Joining the
// publish goroutine before returning — rather than leaving it to report its
// own error via t.Errorf whenever it happens to finish — guarantees that
// error is surfaced from this goroutine, not from one that may still be
// running after the test function has already returned: under `go test
// -race`'s heavier scheduling, subscribeOne's old racy version could return
// before the publish goroutine did, letting t.Cleanup close the miniredis
// client out from under it and making its late t.Errorf panic with "Fail in
// goroutine after Test has completed".
func subscribeAndPublish(t *testing.T, client *redis.Client, channel string, publish func() error) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	sub := client.Subscribe(ctx, channel)
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- publish() }()

	var decoded map[string]any
	select {
	case msg := <-sub.Channel():
		if err := json.Unmarshal([]byte(msg.Payload), &decoded); err != nil {
			t.Fatalf("unmarshal message: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for a published message")
	}

	if err := <-done; err != nil {
		t.Fatalf("publish: %v", err)
	}
	return decoded
}

func TestPublishRealtime_ProjectScoped(t *testing.T) {
	pub, client := newTestPublisher(t)
	projectID := uuid.New()
	convID := uuid.New()

	msg := subscribeAndPublish(t, client, ChannelRealtime, func() error {
		return pub.PublishRealtime(context.Background(), projectID, convID,
			"agent.tool_call", map[string]any{"event_index": 5}, nil)
	})
	if msg["type"] != "agent.tool_call" {
		t.Errorf(`type = %v, want "agent.tool_call"`, msg["type"])
	}
	payload, ok := msg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload = %T, want an object", msg["payload"])
	}
	if payload["conversation_id"] != convID.String() {
		t.Errorf("conversation_id = %v, want %s", payload["conversation_id"], convID)
	}
	if payload["project_id"] != projectID.String() {
		t.Errorf("project_id = %v, want %s", payload["project_id"], projectID)
	}
	if _, present := payload["actor_account_id"]; present {
		t.Errorf("actor_account_id = %v, want absent for a project-scoped event", payload["actor_account_id"])
	}
	if payload["event_index"] != float64(5) { // JSON numbers decode as float64
		t.Errorf("event_index = %v, want 5", payload["event_index"])
	}
	// A project-shared conversation's events name what IAM must allow, so
	// services/realtime checks each viewer on this conversation.
	authz, ok := msg["authz"].(map[string]any)
	if !ok {
		t.Fatalf("authz = %T, want an object", msg["authz"])
	}
	if authz["action"] != "conversations:read" {
		t.Errorf("authz.action = %v, want conversations:read", authz["action"])
	}
	if want := "project/" + projectID.String() + "/conversation/" + convID.String(); authz["resource"] != want {
		t.Errorf("authz.resource = %v, want %s", authz["resource"], want)
	}
}

// TestPublishRealtime_GlobalChatOmitsProjectID mirrors the routing
// contract services/realtime's subscriber.ts implements: an agent.* event
// with no project_id falls through to routing by actor_account_id instead
// (a global agent's home-page/admin chat) — so project_id must be an
// entirely absent key, not present-but-empty, or subscriber.ts's
// `typeof projectId === "string" && projectId` check would need to also
// reject empty string correctly, which it does, but omission is what the
// Python producer does and this pins the Go side to match it exactly.
func TestPublishRealtime_GlobalChatOmitsProjectID(t *testing.T) {
	pub, client := newTestPublisher(t)
	convID := uuid.New()
	actorAccountID := uuid.New()

	msg := subscribeAndPublish(t, client, ChannelRealtime, func() error {
		return pub.PublishRealtime(context.Background(), uuid.Nil, convID,
			"agent.conversation.finished", nil, &actorAccountID)
	})
	payload := msg["payload"].(map[string]any)
	if _, present := payload["project_id"]; present {
		t.Errorf("project_id = %v, want entirely absent for a global-chat event", payload["project_id"])
	}
	if payload["actor_account_id"] != actorAccountID.String() {
		t.Errorf("actor_account_id = %v, want %s", payload["actor_account_id"], actorAccountID)
	}
	if _, present := msg["authz"]; present {
		t.Errorf("authz = %v, want absent: a global chat is routed to its owner's room", msg["authz"])
	}
}

// An owner-private conversation inside a project is routed to its owner's own
// room, so it carries no project authz either.
func TestPublishRealtime_OwnerPrivateProjectConversationHasNoAuthz(t *testing.T) {
	pub, client := newTestPublisher(t)
	owner := uuid.New()

	msg := subscribeAndPublish(t, client, ChannelRealtime, func() error {
		return pub.PublishRealtime(context.Background(), uuid.New(), uuid.New(),
			"agent.message", nil, &owner)
	})
	if _, present := msg["authz"]; present {
		t.Errorf("authz = %v, want absent for an owner-private conversation", msg["authz"])
	}
}

// TestPublishRealtime_NilConversationIDSendsEmptyString pins
// internal/acpbridge's status event shape — the one caller with no real
// conversation to report (an ACP bridge connecting/disconnecting is a
// per-agent event, not a per-conversation one). Unlike projectID's
// omit-when-nil handling, conversation_id must still be present as a
// literal empty string, matching Python's publish_realtime callers, which
// pass conversation_id="" here rather than None (str has no separate
// "unset" to omit).
func TestPublishRealtime_NilConversationIDSendsEmptyString(t *testing.T) {
	pub, client := newTestPublisher(t)

	msg := subscribeAndPublish(t, client, ChannelRealtime, func() error {
		return pub.PublishRealtime(context.Background(), uuid.Nil, uuid.Nil,
			"agent.acp_bridge.status", map[string]any{"agent_id": "a1", "connected": true}, nil)
	})
	payload := msg["payload"].(map[string]any)
	if _, present := msg["authz"]; present {
		t.Errorf("authz = %v, want absent: the bridge status has no conversation", msg["authz"])
	}
	if payload["conversation_id"] != "" {
		t.Errorf("conversation_id = %v, want empty string", payload["conversation_id"])
	}
	if _, present := payload["project_id"]; present {
		t.Errorf("project_id = %v, want absent", payload["project_id"])
	}
}

func TestPublishConversationStatus(t *testing.T) {
	pub, client := newTestPublisher(t)
	convID := uuid.New()
	ctx := context.Background()

	if err := pub.PublishConversationStatus(ctx, convID, "finished"); err != nil {
		t.Fatalf("PublishConversationStatus: %v", err)
	}

	entries, err := client.XRange(ctx, StreamAgentConversationStatus, "-", "+").Result()
	if err != nil {
		t.Fatalf("XRange: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("got %d stream entries, want 1", len(entries))
	}
	if entries[0].Values["conversation_id"] != convID.String() {
		t.Errorf("conversation_id = %v, want %s", entries[0].Values["conversation_id"], convID)
	}
	if entries[0].Values["status"] != "finished" {
		t.Errorf("status = %v, want finished", entries[0].Values["status"])
	}
}
