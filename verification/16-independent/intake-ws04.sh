#!/usr/bin/env bash
# ⑯ 受け入れ: ④の正本パッケージを SHA-256 で照合し、隔離ディレクトリに展開して worktree を復元し、
# ④の試験（workstreams/04-execution 72 件、e2e-native 3 件）と⑯の境界試験を同じ tree で実行する。
#   verification/16-independent/intake-ws04.sh <package.tar.gz> <expected-sha256> [expected-head]
# 何も push しない。本線（このブランチ）には取り込まない。
set -euo pipefail
pkg="$1"; want="$2"; head_claim="${3:-}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
scratch="${SCRATCH:-/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad}"
log="$here/logs/ws04-intake-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$log") 2>&1
echo "package: $pkg"
have="$(sha256sum "$pkg" | cut -d' ' -f1)"
echo "sha256: $have (expected $want)"
[ "$have" = "$want" ] || { echo "SHA-256 MISMATCH: not restored"; exit 3; }
ext="$scratch/ws04-pkg"; rm -rf "$ext"; mkdir -p "$ext"
tar -xzf "$pkg" -C "$ext"
echo "--- contents ---"; find "$ext" -maxdepth 3 -type f | sed "s|$ext/||" | head -60
bundle="$(find "$ext" -name '*.bundle' | head -1)"
[ -n "$bundle" ] || { echo "no .bundle in the package: list patches instead"; find "$ext" -name '*.patch' | sort; exit 4; }
echo "bundle: $bundle"; sha256sum "$bundle"
wt="$scratch/wt-ws04"; rm -rf "$wt"
git -C "$root" bundle verify "$bundle" || echo "(bundle verify: prerequisites missing or standalone)"
heads="$(git -C "$root" bundle list-heads "$bundle")"; echo "$heads"
ref="$(echo "$heads" | awk '{print $2}' | grep -E 'integration|HEAD' | head -1)"; sha="$(echo "$heads" | awk -v r="$ref" '$2==r{print $1}')"
git -C "$root" fetch "$bundle" "$ref:refs/ws04/candidate" 2>&1 | tail -2 || git -C "$root" fetch "$bundle" "$sha" 2>&1 | tail -2
git -C "$root" worktree add --detach "$wt" "$sha"
echo "HEAD: $(git -C "$wt" rev-parse HEAD)  tree: $(git -C "$wt" rev-parse 'HEAD^{tree}')"
[ -z "$head_claim" ] || { case "$(git -C "$wt" rev-parse HEAD)" in "$head_claim"*) echo "head matches the claim $head_claim";; *) echo "HEAD DIFFERS from the claimed $head_claim";; esac; }
echo "base 4cd901de is ancestor: $(git -C "$wt" merge-base --is-ancestor 4cd901de9f8e0d6c0b2016851d30595c4a70aa46 HEAD && echo yes || echo no)"
git -C "$wt" log --oneline 4cd901de..HEAD | cat
# ⑯の試験ファイルを同じ tree に置く（本線の試験をコピー。tree 側のコードは変えない）
cp "$root/frontier-abi/tests/v16_period_boundary.rs" "$wt/frontier-abi/tests/"
cp "$root/frontier-node/crates/herald/tests/v16_caravan_holder.rs" "$wt/frontier-node/crates/herald/tests/"
cp "$root/frontier-node/crates/verify/tests/v16_unknown_tag.rs" "$wt/frontier-node/crates/verify/tests/"
cp "$root"/permutation-gateway/test/v16-*.test.mjs "$wt/permutation-gateway/test/"
ln -sfn "$root/permutation-gateway/node_modules" "$wt/permutation-gateway/node_modules"
echo "=== ④: workstreams/04-execution cargo test ==="
( cd "$wt/workstreams/04-execution" && cargo test 2>&1 | grep -E '^test |test result|^error' ) || true
echo "=== ④: workstreams/04-execution gateway (ignored) ==="
( cd "$wt/workstreams/04-execution" && cargo test --test gateway -- --ignored 2>&1 | grep -E '^test |test result|^error' ) || true
echo "=== ④: e2e-native ==="
( cd "$wt/e2e-native" 2>/dev/null && cargo test 2>&1 | grep -E '^test |test result|^error' ) || echo "(e2e-native not found at the root; search:)" && find "$wt" -maxdepth 3 -type d -name e2e-native
echo "=== ⑯: boundary (abi) ==="
( cd "$wt" && cargo test --locked -p frontier-abi --test v16_period_boundary 2>&1 | grep -E '^test |test result|panicked' ) || true
echo "=== ⑯: verify / herald ==="
( cd "$wt/frontier-node" && CARGO_TARGET_DIR="$root/frontier-node/target" cargo test --locked -p verify --test v16_unknown_tag 2>&1 | grep -E '^test |test result' ; CARGO_TARGET_DIR="$root/frontier-node/target" cargo test --locked -p herald --test v16_caravan_holder 2>&1 | grep -E '^test |test result' ) || true
echo "=== ⑯: node ==="
( cd "$wt/permutation-gateway" && node --test test/v16-*.test.mjs 2>&1 | grep -E '^(not )?ok|^# (pass|fail)' ) || true
echo "log: $log"
