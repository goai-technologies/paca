package plugin

import (
	"bytes"
	"context"
	"testing"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// randomModule is a hand-assembled WASM module that fills the first 16 bytes of
// its memory through WASI random_get, as a TinyGo plugin's crypto/rand does:
//
//	(import "wasi_snapshot_preview1" "random_get" (func (param i32 i32) (result i32)))
//	(memory (export "memory") 1)
//	(func (export "rnd") (result i32) (call 0 (i32.const 0) (i32.const 16)))
var randomModule = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
	0x01, 0x0b, 0x02, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x01, 0x7f, // types
	0x02, 0x25, 0x01, 0x16, 'w', 'a', 's', 'i', '_', 's', 'n', 'a', 'p', 's', 'h', 'o', 't', '_', 'p', 'r', 'e', 'v', 'i', 'e', 'w', '1',
	0x0a, 'r', 'a', 'n', 'd', 'o', 'm', '_', 'g', 'e', 't', 0x00, 0x00, // import
	0x03, 0x02, 0x01, 0x01, // function section
	0x05, 0x03, 0x01, 0x00, 0x01, // memory
	0x07, 0x10, 0x02, 0x06, 'm', 'e', 'm', 'o', 'r', 'y', 0x02, 0x00, 0x03, 'r', 'n', 'd', 0x00, 0x01, // exports
	0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0x41, 0x10, 0x10, 0x00, 0x0b, // code
}

func randomBytesFromPlugin(t *testing.T) []byte {
	t.Helper()
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	defer rt.Close(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		t.Fatal(err)
	}
	compiled, err := rt.CompileModule(ctx, randomModule)
	if err != nil {
		t.Fatal(err)
	}
	mod, err := rt.InstantiateModule(ctx, compiled, moduleConfig("test.random"))
	if err != nil {
		t.Fatal(err)
	}
	res, err := mod.ExportedFunction("rnd").Call(ctx)
	if err != nil || res[0] != 0 {
		t.Fatalf("random_get: %v errno=%v", err, res)
	}
	b, ok := mod.Memory().Read(0, 16)
	if !ok {
		t.Fatal("memory read")
	}
	return append([]byte(nil), b...)
}

// Every plugin instance must get fresh randomness: with wazero's default (a
// fixed-seed fake) each new instance starts the same byte stream, which made a
// plugin's "random" state values, keys and tokens predictable and repeatable.
func TestModuleConfig_PluginRandomnessIsNotDeterministic(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		b := randomBytesFromPlugin(t)
		if bytes.Equal(b, make([]byte, 16)) {
			t.Fatal("random_get returned all zeros")
		}
		if seen[string(b)] {
			t.Fatalf("instance %d got random bytes %x that an earlier instance already got", i, b)
		}
		seen[string(b)] = true
	}
}
