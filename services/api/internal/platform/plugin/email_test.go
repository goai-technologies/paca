package plugin

import (
	"context"
	"net"
	"net/smtp"
	"strings"
	"testing"
)

func TestDialAndSendSMTP_BlocksPrivateTargets(t *testing.T) {
	// A live loopback listener proves the block happens before any connect.
	var lc net.ListenConfig
	ln, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			accepted <- struct{}{}
			_ = c.Close()
		}
	}()
	loopPort := ln.Addr().(*net.TCPAddr).Port

	for _, tc := range []struct {
		host string
		port int
		tls  bool
	}{
		{"127.0.0.1", loopPort, false},
		{"127.0.0.1", loopPort, true},
		{"localhost", loopPort, false},
		{"169.254.169.254", 80, false},
		{"10.0.0.1", 6379, false},
		{"::1", loopPort, false},
		{"::ffff:127.0.0.1", loopPort, false},
	} {
		err := dialAndSendSMTP(context.Background(), smtpSendRequest{
			Host: tc.host, Port: tc.port, UseTLS: tc.tls,
			From: "a@example.com", To: "b@example.com", TextBody: "x",
		})
		if err == nil || !strings.Contains(err.Error(), "private/internal") {
			t.Errorf("%s:%d tls=%v: want private/internal block, got %v", tc.host, tc.port, tc.tls, err)
		}
	}
	select {
	case <-accepted:
		t.Fatal("listener received a connection; guard was bypassed")
	default:
	}
}

func TestSmtpAuthFor_PicksAdvertisedMechanism(t *testing.T) {
	// Azure Communication Services advertises only LOGIN/XOAUTH2; a PLAIN-only
	// assumption is what broke the send with "Unrecognized authentication type".
	for _, tc := range []struct {
		name     string
		mech     []string
		wantErr  bool
		wantKind string
	}{
		{"plain preferred when offered", []string{"PLAIN", "LOGIN"}, false, "plain"},
		{"login only", []string{"LOGIN", "XOAUTH2"}, false, "login"},
		{"login after starttls advertisement", []string{"LOGIN"}, false, "login"},
		{"xoauth2 only is unsupported", []string{"XOAUTH2"}, true, ""},
		{"nothing advertised", nil, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			auth, err := smtpAuthFor(tc.mech, "user", "secret", "smtp.example.com")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error for mechanisms %v", tc.mech)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			_, isLogin := auth.(*loginAuth)
			if got := map[bool]string{true: "login", false: "plain"}[isLogin]; got != tc.wantKind {
				t.Fatalf("mechanism = %s, want %s", got, tc.wantKind)
			}
		})
	}
}

func TestLoginAuth_AnswersChallengesInOrder(t *testing.T) {
	auth := &loginAuth{username: "user", password: "secret"}
	mech, initial, err := auth.Start(&smtp.ServerInfo{Name: "smtp.example.com", TLS: true})
	if err != nil || mech != "LOGIN" || initial != nil {
		t.Fatalf("Start = %q, %v, %v; want LOGIN, nil, nil", mech, initial, err)
	}
	answer, err := auth.Next([]byte("Username:"), true)
	if err != nil || string(answer) != "user" {
		t.Fatalf("username challenge = %q, %v", answer, err)
	}
	answer, err = auth.Next([]byte("Password:"), true)
	if err != nil || string(answer) != "secret" {
		t.Fatalf("password challenge = %q, %v", answer, err)
	}
	if _, err := auth.Next(nil, false); err != nil {
		t.Fatalf("final call should be a no-op, got %v", err)
	}
	if _, _, err := auth.Start(&smtp.ServerInfo{Name: "smtp.example.com"}); err == nil {
		t.Fatalf("credentials must not be offered on an unencrypted connection")
	}
	if _, _, err := auth.Start(&smtp.ServerInfo{Name: "localhost"}); err != nil {
		t.Fatalf("loopback needs no TLS, got %v", err)
	}
	if answer, err := auth.Next([]byte("Password again:"), true); err == nil {
		t.Fatalf("unexpected challenge answered with %q; want an error", answer)
	}
}
