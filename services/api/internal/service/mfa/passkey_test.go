package mfasvc

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/google/uuid"

	mfadom "github.com/Paca-AI/api/internal/domain/mfa"
	"github.com/Paca-AI/api/internal/platform/totp"
)

const testOrigin = "https://paca.example.com"

type memPasskeys struct {
	mu   sync.Mutex
	list []mfadom.Passkey
}

func (m *memPasskeys) ListPasskeys(_ context.Context, id uuid.UUID) ([]mfadom.Passkey, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []mfadom.Passkey
	for _, p := range m.list {
		if p.UserID == id {
			out = append(out, p)
		}
	}
	return out, nil
}
func (m *memPasskeys) HasPasskeys(ctx context.Context, id uuid.UUID) (bool, error) {
	l, err := m.ListPasskeys(ctx, id)
	return len(l) > 0, err
}
func (m *memPasskeys) AddPasskey(_ context.Context, p *mfadom.Passkey) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.list = append(m.list, *p)
	return nil
}
func (m *memPasskeys) UpdatePasskeyCredential(_ context.Context, id uuid.UUID, c []byte, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.list {
		if m.list[i].ID == id {
			m.list[i].Credential, m.list[i].LastUsedAt = c, &at
		}
	}
	return nil
}
func (m *memPasskeys) DeletePasskey(_ context.Context, uid, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, p := range m.list {
		if p.ID == id && p.UserID == uid {
			m.list = append(m.list[:i], m.list[i+1:]...)
			return nil
		}
	}
	return mfadom.ErrPasskeyNotFound
}
func (m *memPasskeys) DeleteUserPasskeys(_ context.Context, uid uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	kept := m.list[:0]
	for _, p := range m.list {
		if p.UserID != uid {
			kept = append(kept, p)
		}
	}
	m.list = kept
	return nil
}

type memCeremonies struct{ m map[string][]byte }

func (c *memCeremonies) Put(_ context.Context, k string, d []byte, _ time.Duration) error {
	c.m[k] = d
	return nil
}
func (c *memCeremonies) Take(_ context.Context, k string) ([]byte, error) {
	d := c.m[k]
	delete(c.m, k)
	return d, nil
}

func newPasskeySvc(t *testing.T) (*Service, *memStore, *memPasskeys) {
	t.Helper()
	svc, st, _ := newSvc(t)
	pk := &memPasskeys{}
	rp, ok := RelyingPartyFromURL(testOrigin, "", "Paca")
	if !ok {
		t.Fatal("relying party")
	}
	if _, err := svc.WithPasskeys(pk, &memCeremonies{m: map[string][]byte{}}, rp); err != nil {
		t.Fatal(err)
	}
	return svc, st, pk
}

// softKey is a minimal software authenticator: ES256, "none" attestation,
// user verification always performed.
type softKey struct {
	priv   *ecdsa.PrivateKey
	credID []byte
	count  uint32
}

func newSoftKey(t *testing.T) *softKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	return &softKey{priv: k, credID: id}
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func clientData(t *testing.T, typ, challenge string) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func rpHash() []byte { h := sha256.Sum256([]byte("paca.example.com")); return h[:] }

// register answers a creation options document.
func (k *softKey) register(t *testing.T, options json.RawMessage) []byte {
	t.Helper()
	var o struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(options, &o); err != nil {
		t.Fatal(err)
	}
	// Bytes is the uncompressed point: 0x04, then X and Y as 32 bytes each.
	point, err := k.priv.PublicKey.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	cose, err := cbor.Marshal(map[int]any{
		1: 2, 3: -7, -1: 1,
		-2: point[1:33],
		-3: point[33:65],
	})
	if err != nil {
		t.Fatal(err)
	}
	var auth bytes.Buffer
	auth.Write(rpHash())
	auth.WriteByte(0x45) // UP | UV | AT
	_ = binary.Write(&auth, binary.BigEndian, k.count)
	auth.Write(make([]byte, 16)) // AAGUID
	_ = binary.Write(&auth, binary.BigEndian, uint16(len(k.credID)))
	auth.Write(k.credID)
	auth.Write(cose)
	att, err := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": auth.Bytes()})
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(map[string]any{
		"id": b64(k.credID), "rawId": b64(k.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData(t, "webauthn.create", o.PublicKey.Challenge)),
			"attestationObject": b64(att),
		},
	})
	return out
}

// assert answers a request options document.
func (k *softKey) assert(t *testing.T, options json.RawMessage) []byte {
	t.Helper()
	var o struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(options, &o); err != nil {
		t.Fatal(err)
	}
	k.count++
	var auth bytes.Buffer
	auth.Write(rpHash())
	auth.WriteByte(0x05) // UP | UV
	_ = binary.Write(&auth, binary.BigEndian, k.count)
	cd := clientData(t, "webauthn.get", o.PublicKey.Challenge)
	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, auth.Bytes()...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, k.priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(map[string]any{
		"id": b64(k.credID), "rawId": b64(k.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON": b64(cd), "authenticatorData": b64(auth.Bytes()), "signature": b64(sig),
		},
	})
	return out
}

func TestRelyingPartyFromURL(t *testing.T) {
	rp, ok := RelyingPartyFromURL("https://paca.example.com:8443/", "", "Paca")
	if !ok || rp.ID != "paca.example.com" || len(rp.Origins) != 1 || rp.Origins[0] != "https://paca.example.com:8443" {
		t.Fatalf("got %+v ok=%v", rp, ok)
	}
	if rp, _ := RelyingPartyFromURL("https://a.example.com", "example.com", "Paca"); rp.ID != "example.com" {
		t.Fatalf("override ignored: %+v", rp)
	}
	for _, bad := range []string{"", "paca.example.com", "://x"} {
		if _, ok := RelyingPartyFromURL(bad, "", "Paca"); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestPasskeysUnavailableWithoutRelyingParty(t *testing.T) {
	svc, _, _ := newSvc(t)
	u := admin()
	if svc.PasskeysAvailable() {
		t.Fatal("available without WithPasskeys")
	}
	if _, err := svc.BeginPasskeyRegistration(context.Background(), u); !errors.Is(err, mfadom.ErrPasskeyUnavailable) {
		t.Fatalf("got %v", err)
	}
	// And a login is not gated on a factor that can't be used.
	if err := svc.CheckLogin(context.Background(), u, "", "1.1.1.1"); err != nil {
		t.Fatalf("CheckLogin: %v", err)
	}
}

func TestPasskeyRegisterAndLogin(t *testing.T) {
	svc, st, pk := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	key := newSoftKey(t)

	// Registration.
	opts, err := svc.BeginPasskeyRegistration(ctx, u)
	if err != nil {
		t.Fatalf("begin registration: %v", err)
	}
	p, err := svc.FinishPasskeyRegistration(ctx, u, "  Laptop  ", key.register(t, opts))
	if err != nil {
		t.Fatalf("finish registration: %v", err)
	}
	if p.Name != "Laptop" || len(pk.list) != 1 {
		t.Fatalf("stored %+v (%d)", p, len(pk.list))
	}
	// The challenge is single use.
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "x", key.register(t, opts)); !errors.Is(err, mfadom.ErrPasskeyInvalid) {
		t.Fatalf("replayed registration: got %v", err)
	}
	// The same authenticator can't be registered twice.
	opts2, _ := svc.BeginPasskeyRegistration(ctx, u)
	var o2 struct {
		PublicKey struct {
			Exclude []struct{ ID string } `json:"excludeCredentials"`
		} `json:"publicKey"`
	}
	_ = json.Unmarshal(opts2, &o2)
	if len(o2.PublicKey.Exclude) != 1 || o2.PublicKey.Exclude[0].ID != b64(key.credID) {
		t.Fatalf("existing credential not excluded: %+v", o2)
	}

	// A passkey alone makes the account owe a second factor, and it reports it.
	if err := svc.CheckLogin(ctx, u, "", "1.1.1.1"); !errors.Is(err, mfadom.ErrRequired) {
		t.Fatalf("CheckLogin: got %v, want ErrRequired", err)
	}
	if err := svc.CheckLogin(ctx, u, "123456", "1.1.1.1"); !errors.Is(err, mfadom.ErrRequired) {
		t.Fatalf("a code must not pass for a passkey-only account: got %v", err)
	}
	if m, _ := svc.Methods(ctx, u); len(m) != 1 || m[0] != mfadom.MethodPasskey {
		t.Fatalf("methods = %v", m)
	}

	// Sign-in.
	login, err := svc.BeginPasskeyLogin(ctx, u, "chal-1")
	if err != nil {
		t.Fatalf("begin login: %v", err)
	}
	if err := svc.VerifyPasskeyLogin(ctx, u, "chal-1", key.assert(t, login), "1.1.1.1"); err != nil {
		t.Fatalf("verify login: %v", err)
	}
	if pk.list[0].LastUsedAt == nil {
		t.Fatal("last_used_at not recorded")
	}
	// The assertion can't be replayed: its challenge is spent.
	if err := svc.VerifyPasskeyLogin(ctx, u, "chal-1", key.assert(t, login), "1.1.1.1"); !errors.Is(err, mfadom.ErrInvalidCode) {
		t.Fatalf("replayed assertion: got %v", err)
	}
	// An unknown authenticator is refused.
	login, _ = svc.BeginPasskeyLogin(ctx, u, "chal-2")
	if err := svc.VerifyPasskeyLogin(ctx, u, "chal-2", newSoftKey(t).assert(t, login), "1.1.1.1"); !errors.Is(err, mfadom.ErrInvalidCode) {
		t.Fatalf("foreign key: got %v", err)
	}
	// A challenge begun for one login can't be answered for another.
	login, _ = svc.BeginPasskeyLogin(ctx, u, "chal-3")
	if err := svc.VerifyPasskeyLogin(ctx, u, "chal-other", key.assert(t, login), "1.1.1.1"); !errors.Is(err, mfadom.ErrInvalidCode) {
		t.Fatalf("wrong ceremony: got %v", err)
	}

	// The IP allow-list still applies to a passkey sign-in.
	st.cidrs[u.ID] = []string{"10.0.0.0/8"}
	login, _ = svc.BeginPasskeyLogin(ctx, u, "chal-4")
	if err := svc.VerifyPasskeyLogin(ctx, u, "chal-4", key.assert(t, login), "203.0.113.9"); !errors.Is(err, mfadom.ErrIPNotAllowed) {
		t.Fatalf("outside allow-list: got %v", err)
	}
}

func TestPasskeySatisfiesMFAPolicy(t *testing.T) {
	svc, st, pk := newPasskeySvc(t)
	ctx := context.Background()
	st.policy = mfadom.Policy{PrivilegedRoles: []string{mfadom.AllRoles}, RequireMFA: true}
	u := admin()

	if err := svc.CheckLogin(ctx, u, "", "1.1.1.1"); !errors.Is(err, mfadom.ErrSetupRequired) {
		t.Fatalf("unenrolled: got %v", err)
	}
	if need, _ := svc.SetupRequired(ctx, u); !need {
		t.Fatal("setup should be required before any factor")
	}

	key := newSoftKey(t)
	opts, _ := svc.BeginPasskeyRegistration(ctx, u)
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "", key.register(t, opts)); err != nil {
		t.Fatal(err)
	}
	if pk.list[0].Name != "Passkey" {
		t.Fatalf("default name = %q", pk.list[0].Name)
	}
	if need, _ := svc.SetupRequired(ctx, u); need {
		t.Fatal("a passkey satisfies the policy; password-only TOTP setup must stay closed")
	}
	if err := svc.CheckLogin(ctx, u, "", "1.1.1.1"); !errors.Is(err, mfadom.ErrRequired) {
		t.Fatalf("enrolled: got %v, want ErrRequired", err)
	}
}

func TestPasskeyAndTOTPCoexist(t *testing.T) {
	svc, _, _ := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	sec, _ := enrol(t, svc, u)
	now := svc.now()
	svc.now = func() time.Time { return now.Add(totp.Period) }
	key := newSoftKey(t)
	opts, _ := svc.BeginPasskeyRegistration(ctx, u)
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", key.register(t, opts)); err != nil {
		t.Fatal(err)
	}
	if m, _ := svc.Methods(ctx, u); len(m) != 2 {
		t.Fatalf("methods = %v", m)
	}
	// TOTP still works as before.
	code, _ := totp.Code(sec, svc.now())
	if err := svc.CheckLogin(ctx, u, code, "1.1.1.1"); err != nil {
		t.Fatalf("TOTP with a passkey registered: %v", err)
	}
	if err := svc.CheckLogin(ctx, u, "", "1.1.1.1"); !errors.Is(err, mfadom.ErrRequired) {
		t.Fatalf("got %v", err)
	}
}

func TestDeletePasskeyNeedsAPasskeyAssertion(t *testing.T) {
	svc, _, pk := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	keys := []*softKey{newSoftKey(t), newSoftKey(t)}
	for _, k := range keys {
		opts, _ := svc.BeginPasskeyRegistration(ctx, u)
		if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", k.register(t, opts)); err != nil {
			t.Fatal(err)
		}
	}
	target := pk.list[0].ID

	// No challenge begun: nothing to answer.
	if err := svc.DeletePasskey(ctx, u, target, []byte(`{}`)); !errors.Is(err, mfadom.ErrPasskeyInvalid) {
		t.Fatalf("no challenge: got %v", err)
	}
	// A key the account doesn't hold can't authorise it. The failure is not a
	// 401-style ErrInvalidCode: this happens on a signed-in session.
	opts, err := svc.BeginPasskeyVerification(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	err = svc.DeletePasskey(ctx, u, target, newSoftKey(t).assert(t, opts))
	if !errors.Is(err, mfadom.ErrPasskeyInvalid) || errors.Is(err, mfadom.ErrInvalidCode) || len(pk.list) != 2 {
		t.Fatalf("foreign key: got %v (%d left)", err, len(pk.list))
	}
	// The other passkey authorises removing this one; the challenge is single use.
	opts, _ = svc.BeginPasskeyVerification(ctx, u)
	answer := keys[1].assert(t, opts)
	if err := svc.DeletePasskey(ctx, u, target, answer); err != nil || len(pk.list) != 1 {
		t.Fatalf("delete: %v (%d left)", err, len(pk.list))
	}
	if err := svc.DeletePasskey(ctx, u, pk.list[0].ID, answer); !errors.Is(err, mfadom.ErrPasskeyInvalid) || len(pk.list) != 1 {
		t.Fatalf("replayed assertion: got %v (%d left)", err, len(pk.list))
	}
	// A passkey may authorise its own removal.
	opts, _ = svc.BeginPasskeyVerification(ctx, u)
	if err := svc.DeletePasskey(ctx, u, pk.list[0].ID, keys[1].assert(t, opts)); err != nil || len(pk.list) != 0 {
		t.Fatalf("self-removal: %v (%d left)", err, len(pk.list))
	}
}

func TestDeletePasskeyIsScopedToTheUser(t *testing.T) {
	svc, _, pk := newPasskeySvc(t)
	ctx := context.Background()
	u, other := admin(), admin()
	key := newSoftKey(t)
	opts, _ := svc.BeginPasskeyRegistration(ctx, u)
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", key.register(t, opts)); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeletePasskey(ctx, u, uuid.New(), []byte(`{}`)); !errors.Is(err, mfadom.ErrPasskeyInvalid) {
		t.Fatalf("unknown id without proof: got %v", err)
	}
	// other has no passkeys, so cannot even start a verification.
	if _, err := svc.BeginPasskeyVerification(ctx, other); !errors.Is(err, mfadom.ErrPasskeyNotFound) {
		t.Fatalf("verification offered to an account with no passkeys: %v", err)
	}
	if len(pk.list) != 1 {
		t.Fatalf("passkeys = %d", len(pk.list))
	}
}

func TestResetRemovesPasskeys(t *testing.T) {
	svc, _, pk := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	opts, _ := svc.BeginPasskeyRegistration(ctx, u)
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", newSoftKey(t).register(t, opts)); err != nil {
		t.Fatal(err)
	}
	if err := svc.Reset(ctx, u.ID); err != nil || len(pk.list) != 0 {
		t.Fatalf("reset: %v (%d left)", err, len(pk.list))
	}
}

func TestPasskeyOptionsAskForUserVerification(t *testing.T) {
	svc, _, _ := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	key := newSoftKey(t)

	creation, _ := svc.BeginPasskeyRegistration(ctx, u)
	var c struct {
		PublicKey struct {
			AuthenticatorSelection struct {
				UserVerification string `json:"userVerification"`
			} `json:"authenticatorSelection"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(creation, &c); err != nil || c.PublicKey.AuthenticatorSelection.UserVerification != "preferred" {
		t.Fatalf("registration options: %s (%v)", creation, err)
	}
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", key.register(t, creation)); err != nil {
		t.Fatal(err)
	}
	request, err := svc.BeginPasskeyLogin(ctx, u, "chal")
	if err != nil {
		t.Fatal(err)
	}
	var r struct {
		PublicKey struct {
			UserVerification string `json:"userVerification"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(request, &r); err != nil || r.PublicKey.UserVerification != "preferred" {
		t.Fatalf("login options: %s (%v)", request, err)
	}
}

// A deployment that loses PUBLIC_URL must not quietly drop the second factor
// of an account whose only factor is a passkey.
func TestPasskeyAccountFailsClosedWhenRelyingPartyIsGone(t *testing.T) {
	svc, st, pk := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	key := newSoftKey(t)
	opts, _ := svc.BeginPasskeyRegistration(ctx, u)
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", key.register(t, opts)); err != nil {
		t.Fatal(err)
	}

	// Same database, restarted without PUBLIC_URL.
	down, _, _ := newSvc(t)
	down.store = st
	down.WithPasskeyStore(pk)
	if down.PasskeysAvailable() {
		t.Fatal("passkeys should be off")
	}
	if err := down.CheckLogin(ctx, u, "", "1.1.1.1"); !errors.Is(err, mfadom.ErrRequired) {
		t.Fatalf("password alone must not suffice: got %v", err)
	}
	if err := down.CheckLogin(ctx, u, "123456", "1.1.1.1"); !errors.Is(err, mfadom.ErrRequired) {
		t.Fatalf("a code must not stand in for the passkey: got %v", err)
	}
	// It does not advertise a method it cannot answer, nor start one.
	if m, _ := down.Methods(ctx, u); len(m) != 0 {
		t.Fatalf("methods = %v", m)
	}
	if _, err := down.BeginPasskeyLogin(ctx, u, "c"); !errors.Is(err, mfadom.ErrPasskeyUnavailable) {
		t.Fatalf("begin login: got %v", err)
	}
	if _, err := down.BeginPasskeyVerification(ctx, u); !errors.Is(err, mfadom.ErrPasskeyUnavailable) {
		t.Fatalf("begin verification: got %v", err)
	}
	// Policy does not offer password-only TOTP setup to someone who has a factor.
	st.policy = mfadom.Policy{PrivilegedRoles: []string{mfadom.AllRoles}, RequireMFA: true}
	if need, _ := down.SetupRequired(ctx, u); need {
		t.Fatal("setup must stay closed for an account that has a passkey")
	}
	// An admin reset is the way back in.
	if err := down.Reset(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	st.policy = mfadom.Policy{}
	if err := down.CheckLogin(ctx, u, "", "1.1.1.1"); err != nil {
		t.Fatalf("after reset: %v", err)
	}
}

// Removing a passkey asks for user verification; signing in only prefers it.
func TestPasskeyRemovalRequiresUserVerification(t *testing.T) {
	svc, _, _ := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	key := newSoftKey(t)
	creation, _ := svc.BeginPasskeyRegistration(ctx, u)
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", key.register(t, creation)); err != nil {
		t.Fatal(err)
	}
	request, err := svc.BeginPasskeyVerification(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	var r struct {
		PublicKey struct {
			UserVerification string `json:"userVerification"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(request, &r); err != nil || r.PublicKey.UserVerification != "required" {
		t.Fatalf("verification options: %s (%v)", request, err)
	}
}

// One unreadable credential record must not break the others.
func TestUnreadablePasskeyIsSkipped(t *testing.T) {
	svc, _, pk := newPasskeySvc(t)
	ctx := context.Background()
	u := admin()
	key := newSoftKey(t)
	creation, _ := svc.BeginPasskeyRegistration(ctx, u)
	if _, err := svc.FinishPasskeyRegistration(ctx, u, "k", key.register(t, creation)); err != nil {
		t.Fatal(err)
	}
	pk.list = append(pk.list, mfadom.Passkey{ID: uuid.New(), UserID: u.ID, Credential: []byte("{not json")})

	request, err := svc.BeginPasskeyLogin(ctx, u, "chal")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.VerifyPasskeyLogin(ctx, u, "chal", key.assert(t, request), "127.0.0.1"); err != nil {
		t.Fatalf("login with a corrupt sibling record: %v", err)
	}
}
