#!/bin/sh
# Copies the Git Provider SPI wire types from the plugin SDK into Paca core.
#
# Core does not import plugin-sdk-go (see docs/architecture/service-boundaries.md:
# shared code stays inside the owning runtime until duplication is proven), so it
# keeps its own copy of the types a provider and core exchange. Two guards keep
# the copies honest: this script (the only way the files are changed), and a
# contract test on each side that asserts the JSON shape of every wire type
# against the same golden file (testdata/wire-shapes.golden.json).
#
#   scripts/sync-git-spi.sh [path-to-plugin-sdk-go]    (default: ../plugin-sdk-go)
set -eu
SDK="${1:-$(cd "$(dirname "$0")/../.." && pwd)/plugin-sdk-go}"
DST="$(cd "$(dirname "$0")/.." && pwd)/services/api/internal/platform/gitprovider"
[ -d "$SDK/gitprovider" ] || { echo "plugin-sdk-go not found at $SDK" >&2; exit 1; }
mkdir -p "$DST/testdata"
for f in types.go errors.go wiretypes.go; do
  { echo "// Code generated from plugin-sdk-go/gitprovider/$f by scripts/sync-git-spi.sh. DO NOT EDIT."
    echo "// Change it in the SDK, then re-run the script. Contract: wire-shapes.golden.json."
    echo
    cat "$SDK/gitprovider/$f"; } > "$DST/spi_$f"
done
cp "$SDK/gitprovider/testdata/wire-shapes.golden.json" "$DST/testdata/wire-shapes.golden.json"
echo "synced SPI from $SDK to $DST"
