#!/usr/bin/env python3
"""keyless.py CRATE_DIR -> JSON {skip: [module prefixes], tests: [integration test names], key_files: [...]}

A source file "has keys" when it names a key type or a signing call
(Keypair, new_from_array on a keypair, from_seed, sign_message, try_sign,
.sign(, tx::build, ed25519, signing_key, solana_signer, SigningKey).
Pubkey::new_from_array (public key bytes) is not a key.

Lib tests: every module whose file has keys, or refers to a module of the
crate whose file has keys (crate::m, super::m, use ...::m), is skipped
(cargo test -- --skip m::), transitively.
Integration tests: a tests/*.rs runs only if it has no keys and names no
key module of the crate.
"""
import json
import os
import re
import sys

KEY = re.compile(r"Keypair|keypair|(?<!Pubkey::)new_from_array|from_seed|sign_message|try_sign|\.sign\(|tx::build|ed25519|signing_key|solana_signer|SigningKey")
crate = sys.argv[1]
src = os.path.join(crate, "src")
files = {}
for root, _, names in os.walk(src):
    for n in names:
        if n.endswith(".rs"):
            p = os.path.join(root, n)
            rel = os.path.relpath(p, src)[:-3]
            parts = rel.split(os.sep)
            if parts[-1] in ("mod", "lib", "main"):
                parts = parts[:-1]
            mod = "::".join(parts)
            files[mod] = open(p, encoding="utf-8").read()
tainted = {m for m, t in files.items() if KEY.search(t)}
leaf = lambda m: m.split("::")[-1] if m else None
changed = True
while changed:
    changed = False
    for m, t in files.items():
        if m in tainted:
            continue
        for k in list(tainted):
            l = leaf(k)
            if l and re.search(r"(crate|super|self)::(\w+::)*" + re.escape(l) + r"\b", t):
                tainted.add(m)
                changed = True
                break
# the crate root (lib.rs) is not a module prefix to skip; its own tests are
# skipped if it has keys (skip by its test module name `tests`)
skip = sorted({(m + "::") for m in tainted if m})
if "" in tainted:
    skip.append("tests::")
tests = []
tdir = os.path.join(crate, "tests")
if os.path.isdir(tdir):
    for n in sorted(os.listdir(tdir)):
        if not n.endswith(".rs"):
            continue
        t = open(os.path.join(tdir, n), encoding="utf-8").read()
        if KEY.search(t):
            continue
        if any(leaf(k) and re.search(r"::" + re.escape(leaf(k)) + r"\b", t) for k in tainted if k):
            continue
        tests.append(n[:-3])
print(json.dumps({"skip": skip, "tests": tests, "key_files": sorted(m or "lib" for m in tainted)}))
