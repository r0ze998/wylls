#!/bin/bash
# ⑯: adds an "owner material right after departure" option and test to ④'s play.rs scenario (test-only, isolated worktree).
set -e
f=$1/frontier-node/crates/keeper/tests/play.rs
grep -q owner_early "$f" && { echo already; exit 0; }
python3 -I - "$f" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
a="    api_journal_broken: bool,\n}"
assert s.count(a)==1
s=s.replace(a,"    api_journal_broken: bool,\n    /// ⑯: owner material is posted right after departure (bell b0), not at the arrival bell.\n    owner_early: bool,\n}")
b="if !owner_pushed && b >= arrive {"
assert s.count(b)==1
s=s.replace(b,"if !owner_pushed && (b >= arrive || (o.owner_early && b >= b0)) {\n            println!(\"  owner material posted at {} (arrival bell starts at {}, T(arrive) round time {})\", w.now(), sc.genesis_ts + arrive as i64 * 600, sc.drand.round_time(sc.tlock_round(arrive)));")
s+='''
/// ⑯ independent: owner material through the real `/v1/reveal` right
/// after departure, about two bells before the arrival turn starts (an SDK
/// or MCP client; the page waits for the bell start). Judged with ④'s own
/// criteria: no Reveal before drand published T(arrive), none before THE
/// anchor, and the marches are still revealed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v16_api_owner_material_right_after_departure() {
    let Some(want) = normal_revealed().await else {
        return;
    };
    let Some(r) = scenario(Opts {
        owner_via_api: true,
        owner_early: true,
        ..Default::default()
    })
    .await
    else {
        return;
    };
    let codes = API_CODES.with(|a| a.borrow().clone());
    println!("v16 early API codes: {codes:?}");
    let early = report("v16-early-API", &r);
    same_marches("v16-early-API", &want, &r);
    check(&r, &early);
}
'''
open(p,'w').write(s)
PY
echo applied
