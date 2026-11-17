#!/bin/sh
# Workstream 12: the regression tests, with key generation, derivation and signing disabled (no network).
# Tests that would need a key are listed as needs-key and are not run. The demo (demo/run-demo.mjs) signs its
# allocations with test-only fixed keys, so it is NOT regenerated here; results/ keeps its last committed output.
set -eu
cd "$(dirname "$0")"
sh tools/test-nokey.sh
