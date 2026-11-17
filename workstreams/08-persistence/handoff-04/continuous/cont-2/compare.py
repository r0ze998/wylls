#!/usr/bin/env python3
"""compare.py A.json B.json [--exact]: consistency between two world snapshots.

Checks (B is later than A):
  - no program account present in A is missing in B (a close would be explicit;
    listed so it can be checked by hand),
  - every holding of A keeps its owner, place (p, q, site) and generation,
  - every citizen of A keeps its wallet and faction, and holdings_n never drops,
  - with --exact: every account is byte-identical (sha256, lamports) — the
    restart check (A taken just before `down`, B just after `resume`, no new bell).
Prints a summary and exits 1 on a failed check.
"""
import json
import sys

a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
exact = "--exact" in sys.argv
fail = []
A = {x["key"]: x for x in a["accounts"]}
B = {x["key"]: x for x in b["accounts"]}
missing = sorted(set(A) - set(B))
added = sorted(set(B) - set(A))
if missing:
    fail.append(f"{len(missing)} accounts of A missing in B: {missing[:5]}")
HA = {h["key"]: h for h in a["holdings"]}
HB = {h["key"]: h for h in b["holdings"]}
for k, h in HA.items():
    g = HB.get(k)
    if g is None:
        fail.append(f"holding {k} gone")
        continue
    for f in ("owner", "p", "q", "site", "gen"):
        if h[f] != g[f]:
            fail.append(f"holding {k} {f} {h[f]} -> {g[f]}")
CA = {c["key"]: c for c in a["citizens"]}
CB = {c["key"]: c for c in b["citizens"]}
for k, c in CA.items():
    d = CB.get(k)
    if d is None:
        fail.append(f"citizen {k} gone")
        continue
    for f in ("wallet", "faction"):
        if c[f] != d[f]:
            fail.append(f"citizen {k} {f} changed")
    if d["holdings_n"] < c["holdings_n"]:
        fail.append(f"citizen {k} holdings_n {c['holdings_n']} -> {d['holdings_n']}")
changed = [k for k in set(A) & set(B) if A[k]["sha256"] != B[k]["sha256"] or A[k]["lamports"] != B[k]["lamports"]]
if exact and (changed or added or missing):
    fail.append(f"exact: {len(changed)} changed, {len(added)} added, {len(missing)} missing")
print(json.dumps({
    "a": {"bell": a["bell"], "slot": a["slot"], "accounts": a["accounts_n"], "holdings": len(a["holdings"]),
          "citizens": len(a["citizens"]), "lamports": a["lamports_total"], "continuous": a["continuous"], "end_bell": a["end_bell"]},
    "b": {"bell": b["bell"], "slot": b["slot"], "accounts": b["accounts_n"], "holdings": len(b["holdings"]),
          "citizens": len(b["citizens"]), "lamports": b["lamports_total"], "continuous": b["continuous"], "end_bell": b["end_bell"]},
    "accounts_added": len(added), "accounts_missing": len(missing), "accounts_changed": len(changed),
    "kinds_a": a.get("kinds"), "kinds_b": b.get("kinds"),
    "failures": fail,
}, indent=1))
sys.exit(1 if fail else 0)
