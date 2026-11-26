#!/usr/bin/env python3
"""One-time keeper journal reconciliation (keeper-landing-investigate, F-1).

Devnet keeper A (bin 81f73a62) never read a signature status (each poll's
history search was past the 20 s POST deadline), so every attempt stayed
`sent`. Most of those are re-sends that never landed: their blockhash expired
and the RPC's history search answers `null`. A keeper keeps such a signature
"unknown" forever, and while any payer-care signature is unknown it never
tops up its pools again (`Engine::care_unresolved`).

  sweep  READ-ONLY. Copies the journal (db + wal + shm) to a temp dir, reads
         `getBlockHeight`, and asks `getSignatureStatuses` with
         `searchTransactionHistory` for every `sent` row whose
         last_valid_block_height is more than --margin blocks behind the
         chain. 16 signatures per call, >= 1.2 s between calls. Writes JSON.
  apply  Only with the keeper STOPPED (refuses if any frontier-keeper process
         runs). Backs the journal up, then marks the sweep's `null` rows
         `superseded` (not chain evidence; `Journal::set_status` still accepts
         a later finalized status for them; not read by `in_flight`, not the
         legacy `expired` that blocks payer care). Dry run unless --yes.

No keys are read. Network: the --rpc URL only.
"""
import argparse, json, os, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.error, urllib.request


def rpc_call(url, method, params, state, gap=1.2, tries=6):
    for _ in range(tries):
        wait = gap - (time.time() - state["last"])
        if wait > 0:
            time.sleep(wait)
        state["last"] = time.time()
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                v = json.loads(r.read())
            if "result" in v:
                return v["result"]
            print(f"  {method}: rpc error {v.get('error')}", file=sys.stderr)
        except urllib.error.HTTPError as e:
            print(f"  {method}: HTTP {e.code}", file=sys.stderr)
        except Exception as e:  # timeout, reset
            print(f"  {method}: {type(e).__name__}", file=sys.stderr)
        time.sleep(11)  # api.devnet's Retry-After
    return None


def copy_journal(path):
    d = tempfile.mkdtemp(prefix="kjde-")
    for suf in ("", "-wal", "-shm"):
        if os.path.exists(path + suf):
            shutil.copy2(path + suf, os.path.join(d, os.path.basename(path) + suf))
    return os.path.join(d, os.path.basename(path)), d


def sweep(a):
    db, d = copy_journal(a.journal)
    try:
        rows = sqlite3.connect(db).execute(
            "SELECT sig, kind, object_key, last_valid_block_height FROM attempts "
            "WHERE status = 'sent' ORDER BY rowid").fetchall()
    finally:
        shutil.rmtree(d)
    st = {"last": 0.0}
    height = rpc_call(a.rpc, "getBlockHeight", [{"commitment": "finalized"}], st)
    if height is None:
        sys.exit("getBlockHeight failed")
    old = [r for r in rows if r[3] is not None and r[3] + a.margin < height]
    print(f"{len(rows)} sent rows; {len(old)} expired by > {a.margin} blocks at height {height}")
    out = {"at": time.strftime("%F %T %Z"), "height": height, "margin": a.margin,
           "null": [], "landed": [], "unread": [], "young": len(rows) - len(old)}
    for i in range(0, len(old), 16):
        chunk = old[i:i + 16]
        res = rpc_call(a.rpc, "getSignatureStatuses",
                       [[r[0] for r in chunk], {"searchTransactionHistory": True}], st)
        if res is None:
            out["unread"] += [r[0] for r in chunk]
            continue
        for r, s in zip(chunk, res["value"]):
            if s is None:
                out["null"].append({"sig": r[0], "kind": r[1]})
            else:
                out["landed"].append({"sig": r[0], "kind": r[1], "slot": s.get("slot"),
                                      "err": s.get("err"), "confirmation": s.get("confirmationStatus")})
        if (i // 16) % 10 == 0:
            print(f"  {i + len(chunk)}/{len(old)}", file=sys.stderr)
    json.dump(out, open(a.out, "w"), indent=1)
    kinds = {}
    for x in out["null"]:
        kinds[x["kind"]] = kinds.get(x["kind"], 0) + 1
    print(f"null {len(out['null'])} {kinds}; landed {len(out['landed'])}; unread {len(out['unread'])} -> {a.out}")


def keeper_running():
    r = subprocess.run(["pgrep", "-f", "frontier-keeper"], capture_output=True, text=True)
    return [p for p in r.stdout.split() if p and int(p) != os.getpid()]


def apply(a):
    sw = json.load(open(a.sweep))
    sigs = [x["sig"] for x in sw["null"]]
    if not a.copy_ok:
        pids = keeper_running()
        if pids:
            sys.exit(f"refusing: frontier-keeper is running (pids {' '.join(pids)}); stop it first")
    c = sqlite3.connect(a.journal)
    n_sent = c.execute(
        f"SELECT kind, COUNT(*) FROM attempts WHERE status = 'sent' AND sig IN ({','.join('?' * len(sigs))}) GROUP BY kind",
        sigs).fetchall() if sigs else []
    print(f"sweep {sw['at']} height {sw['height']}: {len(sigs)} null rows; still 'sent' in the journal: {dict(n_sent)}")
    if not a.yes:
        print("dry run (add --yes to write)")
        return
    bak = f"{a.journal}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    with sqlite3.connect(bak) as b:
        c.backup(b)
    print(f"backup: {bak}")
    with c:
        n = 0
        for s in sigs:
            n += c.execute("UPDATE attempts SET status = 'superseded' WHERE sig = ? AND status = 'sent'", (s,)).rowcount
        c.execute("INSERT INTO alerts(slot, kind, detail) VALUES (0, 'journal-reconciled', ?)",
                  (f"keeper-journal-drop-expired: {n} expired never-landed attempts marked superseded (sweep {sw['at']}, height {sw['height']})",))
    print(f"marked {n} rows superseded")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sweep")
    s.add_argument("--journal", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--rpc", default="https://api.devnet.solana.com")
    s.add_argument("--margin", type=int, default=300, help="blocks past last_valid_block_height")
    ap = sub.add_parser("apply")
    ap.add_argument("--journal", required=True)
    ap.add_argument("--sweep", required=True)
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--copy-ok", action="store_true", help="the journal is a copy (skip the running-keeper check)")
    a = p.parse_args()
    sweep(a) if a.cmd == "sweep" else apply(a)


if __name__ == "__main__":
    main()
