#!/bin/sh
# TEST-ONLY six-nation bot session + multi-view recording (README.md). Local world only; see `--dry-run`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
exec node "$here/sixnation.mjs" "$@"
