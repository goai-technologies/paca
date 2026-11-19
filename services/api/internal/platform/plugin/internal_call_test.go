package plugin

import "testing"

func TestParseInternalResponse(t *testing.T) {
	// The SDK serialises Response as {"status":…,"headers":…,"body":<base64 bytes>}.
	status, body, err := parseInternalResponse([]byte(`{"status":404,"headers":{"Content-Type":"application/json"},"body":"eyJvayI6ZmFsc2V9"}`))
	if err != nil || status != 404 || string(body) != `{"ok":false}` {
		t.Fatalf("status=%d body=%q err=%v", status, body, err)
	}
	if status, _, _ := parseInternalResponse([]byte(`{"body":""}`)); status != 200 {
		t.Errorf("a missing status means 200, got %d", status)
	}
	if _, _, err := parseInternalResponse([]byte(`not json`)); err == nil {
		t.Error("garbage must be an error")
	}
}
