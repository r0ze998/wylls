#!/usr/bin/env bash
# Local history probe (candidate; local only): starts the local base and ER,
# runs setup + roundtrip, then asks both sides what an indexer can page:
# getSignaturesForAddress by program and by board, and getTransaction with
# maxSupportedTransactionVersion 0 (as fclient/findex request) and 1.
#
#   frontier-er/svm-tests/probe-history.sh WORK_DIR
# Env as e2e-local.sh: AGAVE_BIN, MB_PKG, NOFILE_SHIM (optional).
set -euo pipefail
W=$1; : "${AGAVE_BIN:?}" "${MB_PKG:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
B=http://127.0.0.1:41680; E=http://127.0.0.1:41670
rm -rf $W; mkdir -p $W
PATH="$AGAVE_BIN:$PATH" setsid node $MB_PKG/@magicblock-labs/ephemeral-validator/mbTestValidator.js --rpc-port 41680 --bpf-program GURgmxeLRJ1swjHDtQhQdTjguNB6EZDmxSdGM3GC6Hrt $HERE/../target/deploy/frontier_er_board.so --faucet-port 41690 --gossip-port 41691 --dynamic-port-range 41700-41740 --ledger $W/ledger --reset > $W/base.log 2>&1 &
BP=$!
for i in $(seq 1 60); do curl -s -m2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' $B | grep -q ok && break; sleep 1; done
for i in $(seq 1 60); do s=$(curl -s -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"finalized"}]}' $B | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",0))'); [ "$s" -ge 5 ] && break; sleep 1; done
LD_PRELOAD="${NOFILE_SHIM:-}" setsid $MB_PKG/@magicblock-labs/ephemeral-validator-linux-x64/bin/ephemeral-validator --no-tui --listen 127.0.0.1:41670 --remotes $B --remotes ws://127.0.0.1:41681 --storage $W/er > $W/er.log 2>&1 &
EP=$!
trap 'kill -- -$BP -$EP 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -s -m2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getIdentity"}' $E | grep -q identity && break; sleep 1; done
X=$HERE/../target/debug/examples/er_e2e
BOARD=$($X $B $E $W/k setup | python3 -c 'import sys,json; print(json.loads(sys.stdin.readline())["v"]["board"])')
$X $B $E $W/k roundtrip > /dev/null
q() { curl -s -X POST -H 'content-type: application/json' -d "$2" $1; }
PROG=GURgmxeLRJ1swjHDtQhQdTjguNB6EZDmxSdGM3GC6Hrt
for side in $B $E; do
  for addr in $PROG $BOARD; do
    r=$(q $side "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"$addr\",{\"limit\":100,\"commitment\":\"confirmed\"}]}")
    n=$(echo "$r" | python3 -c 'import sys,json; j=json.load(sys.stdin); print(len(j["result"]) if "result" in j else "ERR "+json.dumps(j.get("error"))[:120])')
    echo "{\"side\":\"$side\",\"addr\":\"$addr\",\"signatures\":\"$n\"}"
    if [ "$addr" = "$BOARD" ]; then echo "$r" > $W/sigs-$(echo $side | tr -dc 0-9).json; fi
  done
done
# Fetch every base signature that mentions the board and classify by programs invoked.
python3 - "$W/sigs-12700141680.json" "$B" <<'PY'
import json,sys,urllib.request
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
sigs=json.load(open(sys.argv[1]))["result"]; url=sys.argv[2]
kinds={}
for s in sigs:
    req=json.dumps({"jsonrpc":"2.0","id":1,"method":"getTransaction","params":[s["signature"],{"encoding":"json","commitment":"confirmed","maxSupportedTransactionVersion":0}]}).encode()
    j=json.load(urllib.request.urlopen(urllib.request.Request(url,req,{"content-type":"application/json"})))
    t=j.get("result")
    if t is None:
        print(json.dumps({"sig":s["signature"][:12],"getTransaction_error":j.get("error")}))
        continue
    logs=t["meta"]["logMessages"] or []
    top=[l.split()[1] for l in logs if l.endswith("invoke [1]")]
    k=" > ".join(dict.fromkeys(top))
    kinds[k]=kinds.get(k,0)+1
    print(json.dumps({"sig":s["signature"][:12],"err":t["meta"]["err"] is not None,"top":top}))
print(json.dumps({"base_txs_touching_board_by_top_level_programs":kinds}))
PY
# Every base signature under the PROGRAM address (what findex RpcPoll pages),
# fetched as fclient does (maxSupportedTransactionVersion 0) and with 1.
q $B '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["GURgmxeLRJ1swjHDtQhQdTjguNB6EZDmxSdGM3GC6Hrt",{"limit":100,"commitment":"confirmed"}]}' > $W/prog-sigs.json
python3 - "$W/prog-sigs.json" "$B" <<'PY'
import json,sys,urllib.request
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
url=sys.argv[2]
for s in json.load(open(sys.argv[1]))["result"]:
    row={"program_sig":s["signature"][:12]}
    for v in (0,1):
        req=json.dumps({"jsonrpc":"2.0","id":1,"method":"getTransaction","params":[s["signature"],{"encoding":"base64","commitment":"confirmed","maxSupportedTransactionVersion":v}]}).encode()
        j=json.load(urllib.request.urlopen(urllib.request.Request(url,req,{"content-type":"application/json"})))
        r=j.get("result")
        row["v%d"%v]=("ok version=%s"%r.get("version")) if r else ("error %s"%j["error"]["code"])
        if r and v==1:
            row["top"]=list(dict.fromkeys(l.split()[1] for l in r["meta"]["logMessages"] if l.endswith("invoke [1]")))
    print(json.dumps(row))
PY
# One ER transaction by signature.
s=$(python3 -c "import json;print(json.load(open('$W/sigs-12700141670.json'))['result'][0]['signature'])" 2>/dev/null || echo none)
q $E "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",\"params\":[\"$s\",{\"encoding\":\"json\",\"maxSupportedTransactionVersion\":0}]}" | python3 -c 'import sys,json; j=json.load(sys.stdin); r=j.get("result"); print(json.dumps({"er_getTransaction": ("ok slot %s, %d log lines" % (r["slot"], len(r["meta"]["logMessages"]))) if r else j.get("error")}))'
