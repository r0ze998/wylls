#!/bin/sh
# TEST-ONLY six-nation map timelapse (README.md): one map of a frontier-sim season. No chain, no key, no port.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
exec node "$here/sixmap.mjs" "$@"
