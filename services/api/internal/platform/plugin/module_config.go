package plugin

import (
	"crypto/rand"

	"github.com/tetratelabs/wazero"
)

// moduleConfig is the wazero configuration every plugin module is instantiated
// with.
//
// The clock is the real OS clock: without WithSysWalltime/WithSysNanotime
// wazero hands a plugin a fake clock frozen at 1970-01-01 (nanotime) and
// 2022-01-01 (walltime), which is what time.Now() would otherwise report (see
// issue #339).
//
// Randomness is the host's crypto/rand: without WithRandSource wazero seeds a
// fake generator with a constant, so WASI random_get — and with it a plugin's
// own crypto/rand and math/rand seeding — returns the same byte stream on every
// instance of every Paca deployment. Nothing a plugin derives from it (OAuth
// state, API keys, tokens, nonces) would be unguessable.
func moduleConfig(name string) wazero.ModuleConfig {
	return wazero.NewModuleConfig().
		WithName(name).
		WithStartFunctions("_initialize").
		WithSysWalltime().
		WithSysNanotime().
		WithRandSource(rand.Reader)
}
