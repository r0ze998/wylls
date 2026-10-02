# Wylls conquest milestone (MC): owner decision sheet (PO-1..PO-8)
2026-10-02. Built from exp/cq-e1..e4, their skeptic verdicts, and one extra combined measurement (P1, branch exp/cq-p1-combo at 60def25, worktree .claude/worktrees/cq-exp-p1). Context: on 2026-10-01 the owner approved the directions in DECISIONS CQ-G (frontier/cq-integ 5c470d9). This sheet supplies the parameters, and it changes one point (CQG8's +0.006). Tags: [C] = confirmed by a skeptic or measured by the integrator; [P1] = measured in this synthesis, not yet re-run by a skeptic. Every rules change below is MC-only: the M1 rules, the M1 RULESET_HASH and the M1 digests stay unchanged. The D9 audit is 0 everywhere (630 seed rows in P1 alone).

PO-1. Map movement (mapmove-gate 7d/1k, and p10 >= 2 x floors)
Problem: under cq bots, occupations and liberations are 0, and 10e (P2 net movement) stays below 10%. A simulator defect sends every arriving rally host home under MC, because the clash checks the M1 siege record.
Recommendation: (a)+(b), with no §3.12 rules lever.
- (a) Adopt the E1 planner: one occupation slot per faction for a legal first holding; hold rule retreat_bps = clamp(10,000 x group/own, 6,667, 60,000); rally hosts stay while the siege is pending or live.
- (b) Amend the floors: 10e becomes 10e' (every non-heartland province open at bell 287 or later, holder at max(open, 287) vs end-1) with a floor of 6%; 10a 60 -> 45; 10c 15% -> 13%; occupations 3 -> 10 (kept on the bot row); liberations 1, unchanged. The 2x rule is kept for every map figure and 10h count.
Evidence:
- E1 gives occupations p10 36.8 and liberations 25 on the thresholds seeds, and 37.4/22.2 and 37.8/24.4 on two new sets [C].
- E1 leaves contract 10e at p10 0.074 against the 0.20 needed [C]. With the old floors, E1 still fails 10e on 10/20 new seeds [P1].
- Package (E1 + floors), cq profile: PASS on seeds 1102-1106, 10002-10021, 13002-13021 and 6102-6106. m1 profile PASS 20/20. Both negative controls FAIL on every set. p10 / floor: 10a 2.08-2.17x, 10c 2.13-2.22x, 10e' 2.37-2.63x, occupations >= 3.4x [P1].
- 10c at 14% gives only 1.98x on seeds 4002-4011, so 13% is used [C].
- Cost: Departs per bot-day 0.158 -> 0.177 (+5 to +12%) [C].
Alternatives: a §3.12 lever. keep_consolidate_bells=144 failed on seeds 6101-6105 [C], and any lever is a player-visible rules change. Moving occupations to the lone row (E2's first proposal) is no longer needed with E1.

PO-2. Doctrine band on MC
Problem: MC marches about 5x as much as M1, and the cavalry doctrines B and F pay a variant surcharge on every march. Their win rates fall to about 11% (band 16.7 +/- 2).
Recommendation: K2. Under MC, cavalry unit lines pay no ore or gold variant surcharge. On chain this is an MC-only train cost (catalog::train, v2 table), not a Depart change. Also, validate_table v2 refuses Knight lines for MC doctrines (or keeps a Knight cost).
Evidence:
- CI proxy 6/6, max |Δ| 0.100% (baseline 3/6) [C].
- Overnight band (1,500 seasons) 6/6 on seeds 10000, 20000 and 30000. E4's independent implementation gives the identical table [C].
- Seeds 40000: 6/6, but B is at 14.8%, close to the 14.67% edge [C].
- K2 with the symmetric keep: overnight 6/6, max |Δ| 0.102%. All three doctrine controls are rejected [P1].
Alternatives: contest economics (E4). No stake level restores the band, and outposts off breaks the criterion (1.068) [C]. Charging the surcharge at training only (the chain-faithful model) gives 2/6 [C].

PO-3. 10k / 28-day overnight gate
Recommendation: floors banner changes >= 3.5 a day and Marches with >= 2 banners >= 10%. Add --controls to the O-B line.
Evidence:
- Base p10 4.65 / 0.138, worst seed 4.43 / 0.130 [C].
- With E1: PASS 4/4 on seeds 1101 and 9101, and with the symmetric keep. The weightmap control fails Marches 0/4 (max 0.046) [P1].
- The banner figure alone does not always reject the weightmap control (up to 5.21 a day); the Marches figure does [C].
Alternative: 4 a day / 12%. Margin only 1.08-1.16x.

PO-4. Size stress
Recommendation: no rules change. At 7 days, gate 2:1 (>= 8/10 seeds <= 22%) and report 3:1. At 28 days / 10k, gate both. Optionally, a later UI wave shows member counts in the faction picker.
Evidence:
- 2:1: human mix 20/20 and 20/20, cq 19/20 and 17/20 [C]. With E1: 10/10 and 9/10 [P1].
- 3:1 at 7 days: 6/10 and 3/10. At 28 days: 10/10, end share p50 0.202 [P1].

PO-5. Adopt keep_tile_symmetric before CQ2-A
With the full package it passes:
- the cq gate on 1102-1106 and 10002-10021;
- the 28-day gate (4/4);
- the overnight band (6/6).
Thresholds barely move (10a p10 93.8 -> 98.4) [P1].

PO-6. Accept the changed v1 WASM bytes
Behaviour is identical: recorded vectors byte-identical, 6/6 replays (notes §2). Restoring the M1 bytes would need a separate M1 artefact build and buys nothing.

PO-7. Amend §3.10 to count every holding in state 1, provisional included
No layout change, and the layout freezes at Gate CQ1. A provisional holding lasts at most about 24 bells per new holding, the same for every faction.

PO-8. Best-response margin
Problem: MC - M1 swings with the seed set alone from +0.00003 to +0.0098. A +0.005 or +0.006 margin sits inside that noise.
Recommendation: keep the criterion's own test (every cell < 1.0). Replace the relative margin with an absolute MC ceiling (worst cell <= 0.995 on the gate seeds), and report MC - M1.
Evidence:
- MC worst cells across 4 seed sets reach at most 0.992770.
- Base margins: +0.00003 / +0.0051 / +0.0077 / +0.0098.
- E1 margins: +0.0023 / +0.0058 / +0.0074 / +0.0080.
- [C] except the 50001 rows and the E1 30101 row, which are [P1].
- CQG8's +0.006 would fail E1 on 2 of the 4 sets.

Plan impact (estimate)
- Gate CQ1 must be re-run in full: kernel changes, a RULESET_HASH_V2 re-pin, and new thresholds files. About half a day of machine time including the overnight lines.
- Extra work before Wave 2, about 3-4 engineer-days: the v1.3 amendment text; simulator landing of E1, 10e', K2 and keep-sym; kernel/ABI work for the MC train-cost table, the Knight bound and keep_tile_symmetric; the hash re-pin; vector regeneration.
- Extra work in CQ2-F, about 0.5 ew: port the planner additions and extend the §8.7 item 6 field-equality test.
- Calendar: +1.5-2.5 days at the agent pace M1 ran, or about +1 week for a human team.
- Open risks are listed separately. The main ones: the P1 numbers are not yet skeptic-verified, the floors are partly fitted on the same seeds, B sits consistently about 0.1% low, and the human-mix campaign row still does not move the map (OD-14).