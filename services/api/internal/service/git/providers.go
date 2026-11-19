package gitsvc

import (
	"context"
	"strings"
	"sync"

	gitdom "github.com/Paca-AI/api/internal/domain/git"
	plugindom "github.com/Paca-AI/api/internal/domain/plugin"
	"github.com/Paca-AI/api/internal/platform/gitprovider"
)

// DoerFunc adapts a function to gitprovider.Doer; production passes
// plugin.Runtime.CallInternal.
type DoerFunc func(ctx context.Context, pluginName, method, path string, body []byte) (int, []byte, error)

// Do implements gitprovider.Doer.
func (f DoerFunc) Do(ctx context.Context, pluginName, method, path string, body []byte) (int, []byte, error) {
	return f(ctx, pluginName, method, path, body)
}

// PluginProviders finds Git providers among the enabled plugins that declare
// the git-provider capability.
type PluginProviders struct {
	plugins plugindom.PluginRepository
	doer    gitprovider.Doer

	mu       sync.Mutex
	verified map[string]string // plugin name → plugin version whose SPI major matched
}

// NewPluginProviders returns a Providers backed by the plugin registry and runtime.
func NewPluginProviders(plugins plugindom.PluginRepository, doer gitprovider.Doer) *PluginProviders {
	return &PluginProviders{plugins: plugins, doer: doer, verified: map[string]string{}}
}

// spiMajor is the compatibility part of an SPI version: "gitprovider.v1" and
// "gitprovider.v1.2" are both "v1".
func spiMajor(v string) string {
	rest := strings.TrimPrefix(v, "gitprovider.")
	major, _, _ := strings.Cut(rest, ".")
	return major
}

// speaksOurSPI reports whether a provider's reported version has the major
// version core implements.
func speaksOurSPI(v string) bool {
	return strings.HasPrefix(v, "gitprovider.") && spiMajor(v) == spiMajor(gitprovider.SPIVersion)
}

// verify asks a provider plugin for its SPI version once per installed plugin
// version, refusing one whose major version core does not speak: its wire
// shapes could be decoded into accepted but wrong results.
func (p *PluginProviders) verify(ctx context.Context, name, version string) error {
	p.mu.Lock()
	// A plugin with an empty version is "verified at version empty", not
	// "never verified": the map's zero value must not pass for a match.
	v, seen := p.verified[name]
	p.mu.Unlock()
	if seen && v == version {
		return nil
	}
	info, err := gitprovider.NewClient(p.doer, name).Describe(ctx)
	if err != nil {
		return gitdom.ErrProviderUnavailable
	}
	if !speaksOurSPI(info.SPIVersion) {
		return gitdom.ErrProviderUnavailable
	}
	p.mu.Lock()
	p.verified[name] = version
	p.mu.Unlock()
	return nil
}

// Provider returns a client for the enabled provider plugin with the given id,
// or gitdom.ErrProviderUnavailable when no such plugin is enabled.
func (p *PluginProviders) Provider(ctx context.Context, providerID string) (ProviderAPI, error) {
	list, err := p.plugins.FindByCapability(ctx, plugindom.CapabilityGitProvider)
	if err != nil {
		return nil, err
	}
	for _, pl := range list {
		if pl.Name == providerID && pl.Enabled {
			if err := p.verify(ctx, pl.Name, pl.Version); err != nil {
				return nil, err
			}
			return gitprovider.NewClient(p.doer, pl.Name), nil
		}
	}
	return nil, gitdom.ErrProviderUnavailable
}

// Describe returns the provider's Info.
func (p *PluginProviders) Describe(ctx context.Context, providerID string) (gitprovider.Info, error) {
	prov, err := p.Provider(ctx, providerID)
	if err != nil {
		return gitprovider.Info{}, err
	}
	c, ok := prov.(*gitprovider.Client)
	if !ok {
		return gitprovider.Info{}, gitdom.ErrProviderUnavailable
	}
	return c.Describe(ctx)
}

// List describes every enabled provider plugin. A provider that fails to
// answer is left out rather than failing the whole list.
func (p *PluginProviders) List(ctx context.Context) ([]gitprovider.Info, error) {
	list, err := p.plugins.FindByCapability(ctx, plugindom.CapabilityGitProvider)
	if err != nil {
		return nil, err
	}
	out := make([]gitprovider.Info, 0, len(list))
	for _, pl := range list {
		if !pl.Enabled {
			continue
		}
		if info, err := gitprovider.NewClient(p.doer, pl.Name).Describe(ctx); err == nil && speaksOurSPI(info.SPIVersion) {
			out = append(out, info)
		}
	}
	return out, nil
}
