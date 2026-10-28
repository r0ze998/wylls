#!/usr/bin/env python3
"""Map growth measurements on a local world (docs/frontier/map-growth/).

    scripts/map-growth-measure.py sample  --run-dir DIR --out FILE [--every 5] [--for SECS]
    scripts/map-growth-measure.py summary --run-dir DIR --samples FILE

`sample` appends one JSON line every `--every` wall seconds:
  - `rss_kb` and `cpu` of each component of the run (`state.json` pids:
    localnet, keeper-a, keeper-b, relay, herald), from `ps`;
  - the herald's `/h/world` (rings, their seed state, Provinces on chain) and
    `/h/status` (`provinces`, `lastSlot`), the chain's slot and Clock time
    (`frontier_status`), so `herald_lag_slots` = chain slot − herald slot;
  - the time one `/h/season` and one `/h/world` answer take (ms).

`summary` groups the samples by the number of Provinces on chain and prints,
for each group: mean and max RSS per component, mean CPU, herald lag, and the
**turn completion delay**: for every turn b whose overview files the herald
wrote while the group held, the wall seconds from the earliest moment the
rules let turn b resolve (turn b + 1's start plus the reveal window `W`) to
the herald's last `h/overview2/{d}/{b}.bin` of any ring (every Province of
every ring resolved through b, and the herald has folded it).
Turn starts are converted from game time to wall time through the samples'
(wall, chain Clock) pairs, so a changed clock scale is followed.

Standard library only; reads the run directory and the run's 127.0.0.1 ports.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request

COMPONENTS = ["localnet", "keeper-a", "keeper-b", "relay", "herald"]


def get_json(url, body=None, timeout=10):
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"} if body else {})
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return json.loads(data), (time.monotonic() - t0) * 1000.0, len(data)


def ps(pid):
    try:
        out = subprocess.run(["ps", "-o", "rss=,%cpu=", "-p", str(pid)], capture_output=True, text=True, check=False).stdout.split()
        return int(out[0]), float(out[1])
    except (IndexError, ValueError):
        return None, None


def sample_once(run_dir, state):
    ports = state["ports"]
    herald = f"http://127.0.0.1:{ports['herald']}"
    rpc = f"http://127.0.0.1:{ports['localnet']}"
    row = {"wall": time.time(), "rss_kb": {}, "cpu": {}}
    for name in COMPONENTS:
        pid = (state.get("components", {}).get(name) or {}).get("pid")
        if pid:
            rss, cpu = ps(pid)
            row["rss_kb"][name], row["cpu"][name] = rss, cpu
    try:
        st, _, _ = get_json(rpc, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "frontier_status", "params": []}).encode())
        res = st.get("result", {})
        row["chain_slot"], row["chain_unix"], row["scale"] = res.get("slot"), res.get("unixTimestamp"), res.get("scale")
    except Exception as e:  # noqa: BLE001 (a sample with a gap is still a sample)
        row["chain_error"] = str(e)
    try:
        hs, _, _ = get_json(f"{herald}/h/status")
        row["herald_slot"], row["herald_provinces"] = hs.get("lastSlot"), hs.get("provinces")
        if row.get("chain_slot") is not None and row["herald_slot"] is not None:
            row["herald_lag_slots"] = row["chain_slot"] - row["herald_slot"]
        w, ms, n = get_json(f"{herald}/h/world")
        row["world"] = {"ringsOpened": w.get("ringsOpened"), "provinces": w.get("provinces"), "rMax": w.get("rMax"),
                        "rings": [[r["d"], r["seed"], r["provinces"], r["size"]] for r in w.get("rings", [])]}
        row["world_ms"], row["world_bytes"] = round(ms, 2), n
        s, ms, n = get_json(f"{herald}/h/season")
        row["season_ms"], row["season_bytes"] = round(ms, 2), n
        row["genesis_ts"], row["bell_secs"], row["reveal_window"] = s.get("genesisTs"), s.get("bellSecs"), s.get("W")
    except Exception as e:  # noqa: BLE001
        row["herald_error"] = str(e)
    return row


def cmd_sample(a):
    state_path = os.path.join(a.run_dir, "state.json")
    end = time.time() + a.duration if a.duration else None
    with open(a.out, "a", encoding="utf-8") as out:
        while end is None or time.time() < end:
            with open(state_path, encoding="utf-8") as f:
                state = json.load(f)
            out.write(json.dumps(sample_once(a.run_dir, state)) + "\n")
            out.flush()
            time.sleep(a.every)


def wall_of(pairs, game):
    """Wall time of game time `game`, interpolated through (wall, chain_unix) pairs (sorted by chain time)."""
    if not pairs:
        return None
    if game <= pairs[0][1]:
        w0, g0 = pairs[0]
        w1, g1 = pairs[1] if len(pairs) > 1 else (w0 + 1, g0 + 1)
    elif game >= pairs[-1][1]:
        w0, g0 = pairs[-2] if len(pairs) > 1 else (pairs[-1][0] - 1, pairs[-1][1] - 1)
        w1, g1 = pairs[-1]
    else:
        i = next(k for k in range(1, len(pairs)) if pairs[k][1] >= game)
        (w0, g0), (w1, g1) = pairs[i - 1], pairs[i]
    if g1 == g0:
        return w1
    return w0 + (game - g0) * (w1 - w0) / (g1 - g0)


def overview_times(run_dir):
    """{bell: wall time of the last ring's overview2 file of that bell}."""
    root = os.path.join(run_dir, "herald", "files", "h", "overview2")
    last = {}
    if not os.path.isdir(root):
        return last
    for d in os.listdir(root):
        for f in os.listdir(os.path.join(root, d)):
            if not f.endswith(".bin") or f.startswith("latest"):
                continue
            try:
                b = int(f[:-4])
            except ValueError:
                continue
            t = os.path.getmtime(os.path.join(root, d, f))
            last[b] = max(last.get(b, 0), t)
    return last


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    xs.sort()
    p = lambda q: xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]  # noqa: E731
    return {"n": len(xs), "mean": round(statistics.fmean(xs), 2), "p50": round(p(0.5), 2), "p90": round(p(0.9), 2), "max": round(xs[-1], 2)}


def cmd_summary(a):
    rows = [json.loads(l) for l in open(a.samples, encoding="utf-8") if l.strip()]
    rows = [r for r in rows if r.get("world")]
    pairs = sorted({(r["wall"], r["chain_unix"]) for r in rows if r.get("chain_unix")}, key=lambda x: x[1])
    ov = overview_times(a.run_dir)
    groups = {}
    for r in rows:
        groups.setdefault(r["world"]["provinces"], []).append(r)
    out = []
    for n in sorted(groups):
        g = groups[n]
        t0, t1 = g[0]["wall"], g[-1]["wall"]
        gen, bs, w = g[-1].get("genesis_ts"), g[-1].get("bell_secs") or 600, g[-1].get("reveal_window")
        if w is None:
            w = a.reveal_window
        delays = []
        for b, t in ov.items():
            if t0 <= t <= t1 and gen is not None:
                # the earliest the rules let turn b resolve: its reveals close W after turn b + 1 starts
                start = wall_of(pairs, gen + (b + 1) * bs + w)
                if start is not None:
                    delays.append(t - start)
        out.append({
            "provinces": n,
            "ringsOpened": g[-1]["world"]["ringsOpened"],
            "samples": len(g),
            "wall_secs": round(t1 - t0, 1),
            "rss_mb": {c: stats([x["rss_kb"].get(c) / 1024 if x["rss_kb"].get(c) else None for x in g]) for c in COMPONENTS},
            "cpu_pct": {c: stats([x["cpu"].get(c) for x in g]) for c in COMPONENTS},
            "herald_lag_slots": stats([x.get("herald_lag_slots") for x in g]),
            "world_ms": stats([x.get("world_ms") for x in g]),
            "season_ms": stats([x.get("season_ms") for x in g]),
            "season_bytes": g[-1].get("season_bytes"),
            "turn_done_after_secs": stats(delays),
        })
    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    print()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sample")
    s.add_argument("--run-dir", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--every", type=float, default=5.0)
    s.add_argument("--for", dest="duration", type=float, default=None)
    m = sub.add_parser("summary")
    m.add_argument("--run-dir", required=True)
    m.add_argument("--samples", required=True)
    m.add_argument("--reveal-window", type=int, default=600, help="W in game seconds for samples that do not carry it")
    a = ap.parse_args()
    {"sample": cmd_sample, "summary": cmd_summary}[a.cmd](a)


if __name__ == "__main__":
    main()
