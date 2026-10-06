# frontier-sim

Host balance simulator for Wylls (open-world design §12 M0):
a 28-day season of up to tens of thousands of agents whose clashes,
sieges, holdings, laurel reward indices, faction indices, pools and claims
all run through the rules-v10 kernels in `permutation_rules::frontier`.
Behaviour and in-game costs are assumptions, collected in `src/model.rs`.

A host binary only: its own workspace root, excluded from the root
workspace, so the program's lock and SBF build are untouched.

```sh
cargo test --release                                   # conservation, determinism, doctrine gate
cargo run --release -- run --agents 10000 --seed 1     # one season, full report
cargo run --release -- run --agents 10000 --sizes 3,1,1,1,1,1 --gamma 3/5
cargo run --release -- run --agents 10000 --doctrines  # rules-v10 doctrine table
cargo run --release -- suite --agents 10000 --seeds 5 --out RESULTS-suite.md
# doctrine balance: 6 rotations × K seeds, paired (the rotations of a seed share it)
cargo run --release -- doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --gate
cargo run --release -- doctrines --seeds 50 --dx "C.drill=10250,F.upkeep=8000"   # try overrides
cargo run --release -- doctrine-gate --controls        # the CI gate's harness (10k × 30 seeds × 6) and its negative controls
cargo run --release -- criterion --seeds 5                  # bot criterion (O4), 1/2/5/10% bots, with and without offices
cargo run --release -- criterion --seeds 5 --rev2-economy   # the same on the M0 economy
cargo run --release -- criterion --best-response --seeds 3 --gate   # the max over the bot's join window × stake × office
cargo run --release -- criterion --seeds 5 --bot-mandates 0.25      # bot officers steer Mandates (humans complete ×0.25)
cargo run --release -- c4 --agents 50000 --seeds 3 --out c4.md      # restated C4: per-bell participation, tail episodes,
                                                                    # counterfactual value of one attacked bell
```

### Conquest milestone (MC, CONQUEST-CONTRACT v1.1 §8.7)

```sh
# criterion 10 per seed, p10/p50/p90, and the thresholds file check (Gate CQ1)
cargo run --release -- mapmove --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 \
    --days 7 --seeds 10 --first-seed 2001 --check thresholds/mc-7d-1k.json
# the gate: every figure at its floor on >= 4 of 5 seeds; both negative controls must fail
cargo run --release -- mapmove-gate --rules mc --policy campaign --bot-profile cq --agents 1000 --bots 0.99 \
    --days 7 --seeds 5 --first-seed 1101 --thresholds thresholds/mc-7d-1k.json --controls
cargo run --release -- mapmove-gate --rules mc --policy campaign --agents 10000 --days 28 --seeds 4 \
    --first-seed 1101 --thresholds thresholds/mc-28d-10k.json          # the 10k / 28-day gate
cargo run --release -- doctrine-gate --set kernel --rules mc --controls  # doctrine CI proxy on the MC rules
cargo run --release -- criterion --best-response --seeds 3 --first-seed 30001 --rules mc --policy campaign --gate
CQ_SHORT=1 CQ_SET="mc:" cargo run --release -- conquest --rules mc --agents 1000 --days 7 --seeds 8 --first-seed 1100
                                                       # the balance lab's out/cand.md columns
```

`--rules m1|mc|mc-weightmap[,bannerdom[=N]][,keepdom]` (default `m1`: the
M1 simulator bit for bit), `--preset mc-local-7d|mc-season-28|mc-test`
(default by season length), `--policy lone|campaign|campaign:0,lone:1-5`,
`--bot-profile sim|cq|m1`, `--m1-act-p P`, `--keep-aggr K`, `--forward`,
`--days N`, `--sizes`, `--json FILE`, `--check FILE`, `--thresholds FILE`,
`--controls`, `--check-leader-max X`, `--gate-28d`, `--report-only`,
`--threads N` (or `FRONTIER_SIM_THREADS`), and `--mc key=value,...`
(exploration overrides of the preset; never in a gated line). The balance
lab's `--cq` levers and the `conquest` / `curve` commands are kept so
`out/cand.md` reproduces. Files: `src/mc.rs` (rules selectors, presets,
the adapters to CQ1-A's §7 keep/control/siege v3 kernels), `src/sim_mc.rs`
(the MC rules in the season loop), `src/sim_campaign.rs` (lone attackers
and the §8.6 campaign planner), `src/mapmove.rs` (criterion 10, the
gates, the files), `src/conquest.rs` (the balance lab's sweep),
`src/cq_tests.rs`. See `docs/frontier/conquest/CQ1-B-NOTES.md`.

The default economy is K3's (owner decisions O3, O4, O6, O10; see
`frontier/m0b/sim/ECONOMY.md`): officer pay may lift a claim to at most 95%
of what the wallet paid, 105 Works per USDC, the laurel stake priced by
expected accrual left (`EntrySchedule::SEASON1`), holdings emit by their
order factor, Relic Sites pay no laurels, the Mandate reserve pays only
staker completers through `frontier::mandate` with its share floor (the
divisor is at least half of the faction's active stakers; the unclaimable
part is burned), γ = 0.6.

The O5 doctrine band (16.7% ± 2 on ≥ 1,500 paired seasons) is checked by
`.github/workflows/doctrine-balance.yml` (nightly); the per-push CI test is a
180-season proxy on the mean index with three negative controls (see
`balance.rs`).

Options: `--bots SHARE`, `--bot-q Q`, `--bot-aggression A`, `--day0 SHARE`,
`--rotation K`, `--set kernel|draft|m0` (doctrine table), `--dx OVERRIDES`
(`model::apply_tweaks`), `--unpaired` (M0's seed layout),
`--emission full|first-only|order-weighted`,
`--relics`, `--no-relics`, `--works-cap N`, `--works-per-usdc N`,
`--stake-ramp BPS`, `--office-ceiling BPS|none`,
`--office-pay usdc|share:BPS|laurels`, `--mandate-all`, `--rev2-economy`,
`--bot-officers`, `--late-stake none|bots|stakers`, `--bot-join-days LO-HI`,
`--bot-mandates MULT`, `--office-term-limit N`, `--no-mandate-floor`,
`--first-seed N`, `--gate-index PCT`, `--verbose`.
`suite --only` takes a comma list of
`payout,variant,herding,bots,decompose,ladder,doctrines,determinism`.

| File | Contents |
|---|---|
| `src/model.rs` | archetypes, play profiles, placeholder costs (all assumptions); the doctrine tables (kernel, draft, M0) and overrides |
| `src/balance.rs` | the doctrine balance harness and its CI gate (`doctrine_balance_gate`) |
| `src/sim.rs` | the season loop: map growth, joins, sessions, economy, marches, clashes, sieges, relics, folds |
| `src/settle.rs` | Shade voiding, faction index, settlement, claims, conservation checks |
| `src/report.rs`, `src/suite.rs` | tables, the M0 measurement suite and the bot criterion (default mix and best response) |
| `src/c4.rs` | restated C4 from the simulator: per-bell participation, tail episodes, counterfactual attacks (`Config::attack`) |
