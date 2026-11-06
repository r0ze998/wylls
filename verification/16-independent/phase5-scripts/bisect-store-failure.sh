#!/bin/sh
cd frontier-node || exit 125
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/home/user/wylls/frontier-node/target cargo test --locked -q -p findex --test store_failure -- --test-threads=1 index_failure_requires_reopen_and_catches_up_from_the_archive >/dev/null 2>&1
r=$?
[ $r -eq 0 ] && exit 0
# compile failure or other -> skip, test failure -> bad
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/home/user/wylls/frontier-node/target cargo test --locked -q -p findex --test store_failure --no-run >/dev/null 2>&1 || exit 125
exit 1
