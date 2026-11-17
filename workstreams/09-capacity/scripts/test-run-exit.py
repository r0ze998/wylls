#!/usr/bin/env python3
"""Exercise the runner's exit handling with a shell stand-in, not Rust or keys."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

RUNNER = Path(__file__).resolve().parents[1] / "run.sh"


class ExitStatusTests(unittest.TestCase):
    def run_case(self, failure):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            here = root / "workstreams/09-capacity"
            (here / "kernel").mkdir(parents=True)
            # Stop before the bridge stage. The unchanged kernel stage is what
            # used to mask compile errors with `|| true` and a FAILED grep.
            script = RUNNER.read_text().split('echo "== bridge10', 1)[0]
            (here / "run.sh").write_text(script)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            cargo = bin_dir / "cargo"
            cargo.write_text('''#!/usr/bin/env bash
case "$*" in
 "test -q") stage=kernel ;;
 "test -q --features abi-04-provisional --test abi") stage=abi ;;
 *"--test contention"*) stage=contention ;;
 *"--test continuity"*) stage=continuity ;;
 *) stage=other ;;
esac
if [ "$stage" = "$FAIL_STAGE" ]; then
  echo "error: could not compile crate" >&2
  exit 101
fi
case "$stage" in
 kernel|abi) echo "test result: ok. 1 passed; 0 failed" ;;
 contention) echo "applied per kind: 1" ;;
 continuity) echo "long run: 1" ;;
esac
''')
            cargo.chmod(0o755)
            env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                       FAIL_STAGE=failure)
            return subprocess.run(["bash", str(here / "run.sh"), "--no-patch"],
                                  env=env, capture_output=True, text=True).returncode

    def test_success(self):
        self.assertEqual(self.run_case("none"), 0)

    def test_compile_failures_propagate(self):
        for stage in ("kernel", "abi", "contention", "continuity"):
            with self.subTest(stage=stage):
                self.assertNotEqual(self.run_case(stage), 0)


if __name__ == "__main__":
    unittest.main()
