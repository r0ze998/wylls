#!/bin/sh
# Workstream 12: regenerate the demo artifacts and run the regression tests (no network).
set -eu
cd "$(dirname "$0")"
node demo/run-demo.mjs --json results/demo-output.json > results/demo-console.txt
tail -n 1 results/demo-console.txt
node --test test/*.test.mjs
