#!/bin/sh
# Reproduction for workstream 04 (not part of ③'s suite): N concurrent `runexec act register` processes (different keys)
# make the FIRST open of one brand-new run store at once, TRIALS times; prints each failure with its output.
# runexec's act register writes only SQLite (no key, no network).
#   sh run-store-cold-open.sh <runexec> <trials> <n> <scratch dir>
# Measured on ④ 16576826 (cargo build --locked): n=2 → 'StoreError: database is locked' 6/80, 9/200; n=8 → 0/160.
# The same with the store opened once first (runexec act list): 0/200 (warm register), 0/300 (warm list).
RX=$1; TRIALS=$2; N=$3; OUT=$4; fails=0
for t in $(seq 1 $TRIALS); do
  d=$(mktemp -d "$OUT/t.XXXXXX"); db="$d/runs.db"
  for i in $(seq 1 $N); do ( "$RX" act register --db "$db" --agent agent1 --key "k$t.$i" --source mcp --run "run$t.$i" > "$d/o$i" 2>&1; echo $? > "$d/e$i" ) & done; wait
  for i in $(seq 1 $N); do e=$(cat "$d/e$i"); if [ "$e" != 0 ]; then fails=$((fails+1)); echo "trial $t proc $i exit $e: $(head -c 300 "$d/o$i")"; fi; done
done
echo "failures: $fails of $((TRIALS*N))"
