package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// client is a thin, synchronous PACA API client. It knows the response
// envelope ({success, data, error}) and the two list shapes PACA uses:
// cursor pages ({items, next_cursor}) and numbered pages ({items, page,
// page_size, total}). Everything the migration does goes through the public
// API so that validation, history and permissions are exactly what the UI gets.
type client struct {
	base   string
	http   *http.Client
	apiKey string
	bearer string
}

type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("PACA %d %s: %s", e.Status, e.Code, e.Message)
}

func newClient(base string) *client {
	return &client{base: strings.TrimRight(base, "/"), http: &http.Client{Timeout: 60 * time.Second}}
}

// login exchanges a username and password for the access_token cookie PACA
// sets, which the server also accepts as a Bearer token.
func (c *client) login(ctx context.Context, username, password string) error {
	body, _ := json.Marshal(map[string]string{"username": username, "password": password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/v1/auth/login", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("login: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	for _, ck := range resp.Cookies() {
		if ck.Name == "access_token" && ck.Value != "" {
			c.bearer = ck.Value
			return nil
		}
	}
	return errors.New("login: no access_token cookie in response")
}

func (c *client) do(ctx context.Context, method, path string, in any, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("X-Api-Key", c.apiKey)
	} else if c.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	var env struct {
		Success   bool            `json:"success"`
		Data      json.RawMessage `json:"data"`
		Error     string          `json:"error"`
		ErrorCode string          `json:"error_code"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("%s %s: HTTP %d, not JSON: %s", method, path, resp.StatusCode, truncate(string(raw), 200))
	}
	if resp.StatusCode >= 300 || !env.Success {
		return &apiError{Status: resp.StatusCode, Code: env.ErrorCode, Message: env.Error}
	}
	if out != nil && len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("%s %s: decode: %w", method, path, err)
		}
	}
	return nil
}

func (c *client) get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

// listCursor drains a cursor-paginated collection ({items, next_cursor}).
func listCursor[T any](ctx context.Context, c *client, path string) ([]T, error) {
	var all []T
	cursor := ""
	for {
		u := path
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		u += sep + "page_size=100"
		if cursor != "" {
			u += "&cursor=" + url.QueryEscape(cursor)
		}
		var page struct {
			Items      []T     `json:"items"`
			NextCursor *string `json:"next_cursor"`
		}
		if err := c.get(ctx, u, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Items...)
		if page.NextCursor == nil || *page.NextCursor == "" || len(page.Items) == 0 {
			return all, nil
		}
		cursor = *page.NextCursor
	}
}

// listItems reads a collection served whole ({items: [...]}) or as a bare array.
func listItems[T any](ctx context.Context, c *client, path string) ([]T, error) {
	var raw json.RawMessage
	if err := c.get(ctx, path, &raw); err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var arr []T
		return arr, json.Unmarshal(trimmed, &arr)
	}
	var page struct {
		Items []T `json:"items"`
	}
	return page.Items, json.Unmarshal(trimmed, &page)
}

// listPages drains a page-numbered collection ({items, page, page_size, total}).
func listPages[T any](ctx context.Context, c *client, path string) ([]T, error) {
	var all []T
	for page := 1; ; page++ {
		var out struct {
			Items []T `json:"items"`
			Total int `json:"total"`
		}
		if err := c.get(ctx, fmt.Sprintf("%s?page=%d&page_size=100", path, page), &out); err != nil {
			return nil, err
		}
		all = append(all, out.Items...)
		if len(out.Items) < 100 || len(all) >= out.Total {
			return all, nil
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
