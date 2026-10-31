#!/usr/bin/env python3
"""Keeper journal counts of a local world, for consistency checks.

    python3 -I scripts/keeper-journal-counts.py RUN_DIR [--out FILE]

Reads RUN_DIR/keeper-{a,b}/keeper.journal.sqlite read-only and prints, per
keeper, the attempts by kind and status and every object key that landed
more than once (a double send of one write). Use it with
`frontier-stack snapshot` before and after a test boundary bell and after
`down` / `resume` (continuous world, migration candidate).
"""
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path


def counts(db: Path) -> dict:
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = list(c.execute("select kind, object_key, status from attempts"))
    by_kind = Counter((k, s) for k, _, s in rows)
    landed = Counter(o for _, o, s in rows if s == "landed")
    return {
        "attempts": len(rows),
        "by_kind_status": {f"{k}:{s}": n for (k, s), n in sorted(by_kind.items())},
        "landed_more_than_once": {o: n for o, n in sorted(landed.items()) if n > 1},
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    run = Path(sys.argv[1])
    out = {}
    for k in ("keeper-a", "keeper-b"):
        db = run / k / "keeper.journal.sqlite"
        if db.exists():
            out[k] = counts(db)
    text = json.dumps(out, indent=2, sort_keys=True)
    if "--out" in sys.argv:
        Path(sys.argv[sys.argv.index("--out") + 1]).write_text(text)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
