package gitsvc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	gitdom "github.com/Paca-AI/api/internal/domain/git"
	plugindom "github.com/Paca-AI/api/internal/domain/plugin"
	"github.com/Paca-AI/api/internal/platform/gitprovider"
)

type fakePluginRepo struct {
	plugindom.PluginRepository
	plugins []*plugindom.Plugin
}

func (f fakePluginRepo) FindByCapability(context.Context, string) ([]*plugindom.Plugin, error) {
	return f.plugins, nil
}

// spiDoer answers describe with the given SPI version and counts the calls.
type spiDoer struct {
	version string
	calls   int
}

func (d *spiDoer) Do(_ context.Context, _, _, _ string, _ []byte) (int, []byte, error) {
	d.calls++
	res, _ := json.Marshal(gitprovider.Info{SPIVersion: d.version, ID: "p"})
	body, _ := json.Marshal(gitprovider.Envelope{OK: true, Result: res})
	return 200, body, nil
}

func TestSPIMajor(t *testing.T) {
	for v, want := range map[string]bool{
		"gitprovider.v1":     true,
		"gitprovider.v1.2":   true,
		"gitprovider.v2":     false,
		"gitprovider.v10":    false,
		"gitprovider":        false,
		"":                   false,
		"otherprovider.v1":   false,
		"v1":                 false,
		"gitprovider.v1beta": false,
	} {
		if got := speaksOurSPI(v); got != want {
			t.Errorf("speaksOurSPI(%q) = %v, want %v", v, got, want)
		}
	}
}

// A plugin installed with an empty version must still be checked: the map's
// zero value is the empty string.
func TestPluginProviders_AnEmptyPluginVersionIsStillVerified(t *testing.T) {
	repo := fakePluginRepo{plugins: []*plugindom.Plugin{{Name: "com.x.git", Version: "", Enabled: true}}}
	skewed := &spiDoer{version: "gitprovider.v2"}
	pp := NewPluginProviders(repo, skewed)
	if _, err := pp.Provider(context.Background(), "com.x.git"); !errors.Is(err, gitdom.ErrProviderUnavailable) {
		t.Fatalf("a v2 provider with no plugin version must be refused: %v", err)
	}
	if skewed.calls != 1 {
		t.Fatalf("it must have asked the provider: %d describes", skewed.calls)
	}
	ok := &spiDoer{version: "gitprovider.v1"}
	pp = NewPluginProviders(repo, ok)
	for i := 0; i < 2; i++ {
		if _, err := pp.Provider(context.Background(), "com.x.git"); err != nil {
			t.Fatal(err)
		}
	}
	if ok.calls != 1 {
		t.Fatalf("a verified empty version is remembered: %d describes", ok.calls)
	}
}

func TestPluginProviders_RefuseAProviderWithAnotherSPIMajor(t *testing.T) {
	repo := fakePluginRepo{plugins: []*plugindom.Plugin{{Name: "com.x.git", Version: "1.0.0", Enabled: true}}}

	skewed := &spiDoer{version: "gitprovider.v2"}
	pp := NewPluginProviders(repo, skewed)
	if _, err := pp.Provider(context.Background(), "com.x.git"); !errors.Is(err, gitdom.ErrProviderUnavailable) {
		t.Fatalf("a v2 provider must be refused: %v", err)
	}
	if _, err := pp.Describe(context.Background(), "com.x.git"); !errors.Is(err, gitdom.ErrProviderUnavailable) {
		t.Fatalf("and not describable either: %v", err)
	}
	if infos, _ := pp.List(context.Background()); len(infos) != 0 {
		t.Fatalf("a v2 provider must not be listed: %+v", infos)
	}

	ok := &spiDoer{version: "gitprovider.v1"}
	pp = NewPluginProviders(repo, ok)
	for i := 0; i < 3; i++ {
		if _, err := pp.Provider(context.Background(), "com.x.git"); err != nil {
			t.Fatalf("a v1 provider is fine: %v", err)
		}
	}
	if ok.calls != 1 {
		t.Fatalf("the version is checked once per plugin version, not per call: %d describes", ok.calls)
	}
	// A new plugin version is checked again.
	repo.plugins[0].Version = "1.1.0"
	if _, err := pp.Provider(context.Background(), "com.x.git"); err != nil || ok.calls != 2 {
		t.Fatalf("upgrade: %v, %d describes", err, ok.calls)
	}
	if infos, _ := pp.List(context.Background()); len(infos) != 1 {
		t.Fatalf("list: %+v", infos)
	}
}
