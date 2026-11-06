#!/usr/bin/env python3
"""Shared ABI number inventory (workstream 04).

Reads git refs (no checkout, no build, no keys) and lists every number in five
shared spaces: instruction tags (v2), log kinds (v1 + v2 tables, one space),
account kinds (code / magic / seed tag), error codes (game, prize), versions.

For each ref it records numbers from
  - code:  definitions in the tree (frontier-abi, permutation-frontier,
           permutation-prize, permutation-nft-resident-spike, workstreams/**.rs)
  - patch: lines added by workstreams/*/patches/*.patch (proposed, unapplied)
  - doc:   tables in workstreams/** and docs/** Markdown that name a tag
           (`| 0xNN | Name`) — proposals with the weakest evidence
and prints, against a baseline ref, the numbers each ref adds and every
number claimed with different names.

  python3 abi_inventory.py --repo <git dir> --base <ref> --ref TEAM=<ref> ... [--json out.json]
"""
import argparse
import json
import re
import subprocess
from collections import defaultdict


def git(repo, *a):
    r = subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def files(repo, ref, paths):
    out = git(repo, "ls-tree", "-r", "--name-only", ref, "--", *paths)
    return [f for f in out.splitlines() if f]


def show(repo, ref, path):
    return git(repo, "show", f"{ref}:{path}")


TAG_TABLE = re.compile(r"^\s*(\w+)\s*=\s*0x([0-9A-Fa-f]{2})\s*,\s*[A-Z]\b", re.M)
TAG_CONST = re.compile(r"const\s+([A-Z][A-Z0-9_]*)\s*:\s*u8\s*=\s*0x([0-9A-Fa-f]{2})\s*;")
KIND_LINE = re.compile(r"^\s*([A-Z][A-Z0-9_]+)\s*=\s*(\d{1,3})\s*[;,]", re.M)
ERR_LINE = re.compile(r"^\s*([A-Z][A-Za-z0-9]+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*,", re.M)
VER_LINE = re.compile(r"pub const ((?:PROGRAM|RULES|LAYOUT)_VERSION\w*|VERSION|MAX_KIND_V2)\s*:\s*\w+\s*=\s*([^;]+);")
MAGIC = re.compile(r"(MAGIC\w*)\s*:\s*\[u8;\s*8\]\s*=\s*\*b\"([^\"]{8})\"")
SEED = re.compile(r"pub const ([A-Z][A-Z0-9_]*)\s*:\s*\[u8;\s*2\]\s*=\s*\*b\"([^\"]{2})\"")
DOC_TAG = re.compile(r"^\|\s*`?0x([0-9A-Fa-f]{2})`?\s*\|\s*`?([A-Za-z][A-Za-z0-9]+)", re.M)
ENUM_BLOCK = re.compile(r"enum\s+(\w*(?:Error|Kind))\s*\{(.*?)\n\}", re.S)


def from_rust(path, text):
    """(category, number, name, detail) from a Rust source."""
    out = []
    base = path.rsplit("/", 1)[-1]
    if path.endswith("v2/tags.rs"):
        for n, v in TAG_TABLE.findall(text):
            out.append(("tag", int(v, 16), n, path))
    for n, v in TAG_CONST.findall(text):
        # Team-local tag constants (e.g. v2/rights.rs ISSUE_GRANT = 0xD0). Skip byte tables.
        # Team-local Frontier tag constants (e.g. v2/rights.rs ISSUE_GRANT = 0xD0),
        # not byte tables, positions or slots.
        if path.startswith("frontier-abi/src/") and not path.endswith("tags.rs") \
                and (re.search(r"(GRANT|SWAP|ISSUE|REVOKE|CLOSE|OPEN|TAG)", n) or path.endswith("_wire.rs")) \
                and not re.search(r"(MAGIC|POS|SLOT|FLAG)", n):
            out.append(("tag", int(v, 16), n, path))
    if path.startswith("frontier-abi/") and (path.endswith("src/log.rs") or path.endswith("v2/log.rs")):
        for n, v in KIND_LINE.findall(text):
            if n not in ("VERSION",) and not n.startswith(("MAX", "SOFT", "HARD")):
                out.append(("kind", int(v), n, path))
        for n, v in re.findall(r"^\s*([A-Z][a-z][A-Za-z0-9]*)\s*=\s*(\d{1,3})\s*,", text, re.M):
            out.append(("entity", int(v), n, path))
    if path.startswith("frontier-abi/") and path.endswith("error.rs") and "enum " not in text:
        # A patch's added lines of the game error table (no enum header).
        for n, v in ERR_LINE.findall(text):
            out.append(("err-game", int(v, 16) if v.startswith("0x") else int(v), n, path))
    if path.startswith("frontier-abi/") and path.endswith("layout/mod.rs") and "enum AccountKind" not in text:
        for n, v in ERR_LINE.findall(text):
            out.append(("acct", int(v), n, path))
    if path.startswith("permutation-prize/") and "enum PrizeError" not in text:
        for n, v in re.findall(r"^\s*([A-Z][A-Za-z0-9]+)\s*=\s*(0x1[0-9A-Fa-f]{2})\s*,", text, re.M):
            out.append(("err-prize", int(v, 16), n, path))
    for ename, body in ENUM_BLOCK.findall(text):
        # Only the shared spaces: the game program's errors (FrontierError and
        # CqError are one space), the prize program's, and the account kinds.
        # A workstream's kernel-internal error enum is not a program code.
        if ename in ("FrontierError", "CqError") and path.startswith(("frontier-abi/", "permutation-frontier/")):
            cat = "err-game"
        elif ename == "PrizeError" and path.startswith("permutation-prize/"):
            cat = "err-prize"
        elif ename == "AccountKind" and path.startswith("frontier-abi/"):
            cat = "acct"
        else:
            continue
        for n, v in ERR_LINE.findall(body):
            out.append((cat, int(v, 16) if v.startswith("0x") else int(v), n, f"{path}:{ename}"))
    for v, n in re.findall(r"^\s*//[!/]\s*\|\s*`?0x([0-9A-Fa-f]{2})`?\s*\|\s*([A-Za-z][A-Za-z0-9]+)", text, re.M):
        out.append(("tag-doc", int(v, 16), n, path))
    for n, v in VER_LINE.findall(text):
        out.append(("version", v.strip(), n, path))
    for n, m in MAGIC.findall(text):
        out.append(("magic", m, n, path))
    if base in ("addr.rs",) or "addr" in base:
        for n, t in SEED.findall(text):
            out.append(("seed", t, n, path))
    return out


def from_layouts(path, text):
    out = []
    try:
        j = json.loads(text)
    except Exception:
        return out
    for a in j.get("accounts", []):
        if "code" in a:
            out.append(("acct", a["code"], a.get("kind"), path))
        if a.get("magic"):
            out.append(("magic", a["magic"], a.get("kind"), path))
        if a.get("seed_tag"):
            out.append(("seed", a["seed_tag"], a.get("kind"), path))
    return out


def from_patch(path, text):
    """Added lines of a patch, read by the target file's rules."""
    out = []
    target, buf = None, []

    def flush():
        if target and buf:
            for c, v, n, d in from_rust(target, "\n".join(buf)) if target.endswith(".rs") else []:
                out.append((c, v, n, f"{path} (+{target})"))

    for line in text.splitlines():
        m = re.match(r"^\+\+\+ b/(.+)$", line)
        if m:
            flush()
            target, buf = m.group(1), []
            continue
        if line.startswith("+") and not line.startswith("+++"):
            buf.append(line[1:])
    flush()
    return out


def from_doc(path, text):
    return [("tag", int(v, 16), n, path) for v, n in DOC_TAG.findall(text)]


CODE_PATHS = ["frontier-abi/src", "frontier-abi/vectors/v2/layouts.json", "permutation-frontier/src",
              "permutation-prize/src", "permutation-nft-resident-spike", "workstreams"]


def scan(repo, ref):
    rows = []
    for f in files(repo, ref, CODE_PATHS):
        # Separate programs (the NFT resident program, its Core stand-ins) have
        # their own instruction and error spaces: only their Frontier-side
        # changes count, which live in frontier-abi / permutation-frontier.
        if f.startswith("permutation-nft-resident-spike/") and f.endswith(".rs"):
            continue
        if f.endswith(".rs") and ("/src/" in f or f.startswith("workstreams/")) and "/tests/" not in f and "/target/" not in f:
            rows += [(*r, "code") for r in from_rust(f, show(repo, ref, f))]
        elif f.endswith("layouts.json") and f.startswith("frontier-abi/"):
            rows += [(*r, "code") for r in from_layouts(f, show(repo, ref, f))]
        elif f.endswith(".patch") and "/patches/" in f:
            rows += [(*r, "patch") for r in from_patch(f, show(repo, ref, f))]
        elif f.endswith(".md") and (f.startswith("workstreams/") or f.startswith("permutation-nft-resident-spike/")):
            rows += [(*r, "doc") for r in from_doc(f, show(repo, ref, f))]
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--ref", action="append", default=[], help="TEAM=ref")
    ap.add_argument("--json")
    a = ap.parse_args()
    base = set((c, str(v), n) for c, v, n, d, k in scan(a.repo, a.base) if k == "code")
    claims = defaultdict(set)  # (cat, value) -> {(team, name, kind, where)}
    for c, v, n, d, k in scan(a.repo, a.base):
        if k == "code":
            claims[(c, str(v))].add(("base", n, k, d))
    added = defaultdict(list)
    for spec in a.ref:
        team, ref = spec.split("=", 1)
        sha = git(a.repo, "rev-parse", ref).strip()
        for c, v, n, d, k in scan(a.repo, ref):
            key = (c, str(v), n)
            if k == "code" and key in base:
                continue
            m = re.match(r"workstreams/(\d\d)-", d)
            owner = m.group(1) if m else team
            if c == "tag-doc":
                c, k = "tag", "doc"
            claims[(c, str(v))].add((owner, n, k, d))
            added[owner].append((c, str(v), n, k, d, sha))
    collisions = {}
    for (c, v), s in claims.items():
        if c == "version":
            continue
        norm = lambda n: re.sub(r"[^a-z0-9]", "", (n or "").lower())
        names = {(t, norm(n)) for t, n, k, d in s}
        if len({n for t, n in names}) > 1:
            collisions[f"{c}:{v}"] = sorted(s)
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"added": {t: sorted(set(x)) for t, x in added.items()},
                       "collisions": collisions}, f, ensure_ascii=False, indent=1)
    for t in sorted(added):
        print(f"== {t}: {len(set(added[t]))} entries not in base code")
    print(f"== collisions: {len(collisions)}")
    for k in sorted(collisions, key=lambda s: (s.split(':')[0], s.split(':')[1].zfill(6))):
        print(k, " | ".join(sorted({f"{t}:{n}({kk})" for t, n, kk, d in collisions[k]})))


if __name__ == "__main__":
    main()
