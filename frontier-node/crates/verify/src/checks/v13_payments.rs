//! V13 — payments (contract §5.11 SettleTransit D5, §5.12, §8.5; I-48,
//! I-52).
//!
//! - **TRANSIT_SETTLED:** the lamports each recipient receives (the four
//!   `(recipient prefix, amount)` pairs, DIVERT records of the same
//!   transaction moved back to their recipient, and `pool_owed_delta` for
//!   the Holding's pool) equal the rule's for the logged outcome, with `tip`
//!   = DEPART's, `fee = march_fee`, `bond = seal_bond`:
//!   bad seal → `tip + fee + bond` to the settle beneficiary; a fate of the
//!   records → tip to the slot's beneficiary, fee to the resolver, bond to
//!   the rent payer; `bounced-unranked` → tip and bond to the rent payer,
//!   fee to the resolver; `routed` with resolved inputs → tip to the pool,
//!   fee to the resolver, bond to the rent payer; `routed` without → tip
//!   and fee to the pool, bond to the rent payer. The recipients are the
//!   SettleTransit's own accounts; the slot beneficiary is the last Reveal's
//!   and the resolver the inputs'. The pairs name the intended recipients
//!   (W4-B P9: the Holding's own prefix is the pool), summed per recipient;
//!   `pool_owed_delta` = the pool's pairs + the transaction's DIVERT amounts
//!   (integ-W4 review).
//! - **DEFENCE_CLAIM:** the amount is `Σ fees::defence_refund(slot evidence,
//!   season)` over the claimed slots (each late by `≥ lateness_slots`
//!   against THE anchor's slot, unclaimed, the keeper's own), capped by the
//!   season's per-call bell-region cap and per-keeper-day cap. Only the
//!   amount actually paid consumes the day allowance; a partial claim pays
//!   less, never more. Ambiguous receipt/instruction attribution is missing
//!   evidence, not a reason to reuse the transaction's first instruction.
//! - SETTLE's escrow refunds and global lamport conservation are not
//!   judged in M1 (the contract makes conservation informational).
//!
//! Codes: `PaymentMismatch`, `DefenceRefundMismatch`.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::ix as aix;
use frontier_abi::layout::clash::{arrival_slot as AS, clash_inputs as CI};
use frontier_abi::log::{transit_outcome, Kind};
use frontier_abi::tags::Ix;
use permutation_rules::frontier::fees::{self, DefenceParams};

use super::Ctx;
use crate::codes::*;
use crate::facts::Facts;
use crate::world::{le, Key, Rec, World};

const V: &str = "V13";

/// Lamports per recipient prefix; the pool is the zero prefix.
type Pay = BTreeMap<[u8; 8], u64>;

fn prefix(k: &Key) -> [u8; 8] {
    k[..8].try_into().unwrap_or([0; 8])
}

fn add(m: &mut Pay, k: [u8; 8], v: u64) {
    if v > 0 {
        *m.entry(k).or_default() += v;
    }
}

pub fn run(cx: &mut Ctx) {
    transits(cx);
    claims(cx);
}

fn transits(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let Some(p) = f.params else { return };
    const POOL: [u8; 8] = [0; 8];
    for (n, r) in w
        .recs
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == Kind::TRANSIT_SETTLED)
    {
        let host = r.ku64("host_id");
        let what = format!("settlement of host {host}");
        if !w.has_post {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                "no post-states: the slot's beneficiary and the resolver cannot be read",
            );
            continue;
        }
        let tx = &w.txs[r.tx];
        let Some(ix) = tx.ix(Ix::SettleTransit.tag()) else {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                "SettleTransit's accounts are not in the archive",
            );
            continue;
        };
        let Some(d) = f.depart_of(w, host, n, None) else {
            continue;
        };
        let tip = w.recs[d].pu64("tip");
        let (fee, bond) = (p.march_fee, p.seal_bond);
        let acct = |i: usize| ix.key(i).map(|k| prefix(&k));
        let (Some(slot_ben), Some(resolver), Some(rent), Some(settler)) =
            (acct(8), acct(9), acct(10), acct(11))
        else {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                "SettleTransit has fewer accounts than §5.11 lists",
            );
            continue;
        };
        // The recipients the accounts name must be the chain's: the slot's
        // beneficiary (its last Reveal), the inputs' resolver.
        let ins = ix
            .key(4)
            .and_then(|k| w.state_before(&k, r.tx))
            .filter(|d| d.len() >= CI::SIZE);
        let resolved = ins.is_some_and(|d| d[CI::FLAGS] & CI::FLAG_RESOLVED != 0);
        let chain_resolver = ins.map(|d| {
            prefix(
                &d[CI::RESOLVER..CI::RESOLVER + 32]
                    .try_into()
                    .unwrap_or([0; 32]),
            )
        });
        let chain_slot_ben = ix
            .key(5)
            .and_then(|k| w.state_before(&k, r.tx))
            .filter(|d| d.len() >= AS::SIZE && le(&d[AS::HOST_ID..AS::HOST_ID + 8]) == host)
            .map(|d| {
                prefix(
                    &d[AS::BENEFICIARY..AS::BENEFICIARY + 32]
                        .try_into()
                        .unwrap_or([0; 32]),
                )
            });
        let mut want = Pay::new();
        let outcome = r.pu8("outcome");
        match outcome {
            transit_outcome::BAD_SEAL => add(&mut want, settler, tip + fee + bond),
            transit_outcome::STAYS..=transit_outcome::DESTROYED => {
                add(&mut want, chain_slot_ben.unwrap_or(slot_ben), tip);
                add(&mut want, chain_resolver.unwrap_or(resolver), fee);
                add(&mut want, rent, bond);
            }
            transit_outcome::BOUNCED_UNRANKED => {
                add(&mut want, rent, tip + bond);
                add(&mut want, chain_resolver.unwrap_or(resolver), fee);
            }
            transit_outcome::ROUTED if resolved => {
                add(&mut want, POOL, tip);
                add(&mut want, chain_resolver.unwrap_or(resolver), fee);
                add(&mut want, rent, bond);
            }
            transit_outcome::ROUTED => {
                add(&mut want, POOL, tip + fee);
                add(&mut want, rent, bond);
            }
            _ => {}
        }
        // W4-B P9 (v1.6 §22): each pair names the **intended** recipient
        // (the Holding's own address for `pool_owed`); a payment the
        // runtime could not credit (an unfunded wallet below rent, a
        // program account) is diverted into `pool_owed` with a DIVERT
        // record, and `pool_owed_delta` counts routed and diverted
        // lamports. So the sums per intended recipient are the pairs'
        // (the Holding's prefix read as the pool), and the delta must be
        // the pool's pairs plus the transaction's DIVERTs (integ-W4
        // review: the DIVERTs were credited a second time).
        let holding = ix.key(2).map(|k| prefix(&k)).unwrap_or([0; 8]);
        let mut got = Pay::new();
        for (to, amt) in [
            ("tip_to", "tip"),
            ("fee_to", "fee"),
            ("bond_to", "bond"),
            ("reward_to", "reward"),
        ] {
            let k: [u8; 8] = r.p(to).try_into().unwrap_or([0; 8]);
            add(&mut got, if k == holding { POOL } else { k }, r.pu64(amt));
        }
        let diverted: u64 = tx
            .recs
            .iter()
            .map(|&i| &w.recs[i])
            .filter(|x| x.kind == Kind::DIVERT)
            .map(|dv| dv.pu64("amount"))
            .sum();
        let pool_ok = r.pu64("pool_owed_delta") == got.get(&POOL).copied().unwrap_or(0) + diverted;
        if !pool_ok {
            cx.fail(
                V,
                PAYMENT_MISMATCH,
                what.clone(),
                r.bell,
                Some(r.tx),
                format!(
                    "pool_owed_delta {} is not the pool's pairs {} plus the diverted {diverted}",
                    r.pu64("pool_owed_delta"),
                    got.get(&POOL).copied().unwrap_or(0)
                ),
            );
        }
        let named_ok = chain_slot_ben
            .is_none_or(|b| b == slot_ben || outcome != transit_outcome::STAYS)
            && chain_resolver.is_none_or(|b| b == resolver || !resolved);
        if want != got || !named_ok {
            cx.fail(
                V,
                PAYMENT_MISMATCH,
                what,
                r.bell,
                Some(r.tx),
                format!(
                    "outcome {outcome}: paid {}, the rule pays {}",
                    show(&got),
                    show(&want)
                ),
            );
        }
    }
}

fn show(m: &Pay) -> String {
    m.iter()
        .map(|(k, v)| {
            format!(
                "{}:{v}",
                if *k == [0; 8] {
                    "pool".into()
                } else {
                    hex::encode(k)
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// The deployed handler creates fresh region counters for each call. This
/// intentionally does not implement a season-wide bell-region allowance.
#[derive(Default)]
struct ClaimCaps {
    regions: BTreeMap<(u32, u8), u64>,
    total: u64,
}

impl ClaimCaps {
    fn admit(&mut self, bell: u32, region: u8, refund: u64, cap: u64) -> Option<()> {
        let used = self.regions.entry((bell, region)).or_default();
        let admitted = refund.min(cap.saturating_sub(*used));
        let next_used = used.checked_add(admitted)?;
        let next_total = self.total.checked_add(admitted)?;
        *used = next_used;
        self.total = next_total;
        Some(())
    }

    fn capped(&self, day_cap: u64, paid_before: u64) -> u64 {
        self.total.min(day_cap.saturating_sub(paid_before))
    }
}

/// World retains transaction-level log positions, not each receipt's
/// instruction/invocation identity. Do not zip multiple claims by order or
/// assume the first legacy instruction emitted every receipt. Wide claims
/// are not attributed by this legacy-only check.
fn unique_claim<'a>(w: &'a World, r: &Rec) -> Result<&'a crate::world::Ix, &'static str> {
    let tx = &w.txs[r.tx];
    let mut calls = tx
        .ixs
        .iter()
        .filter(|ix| ix.tag() == Some(Ix::ClaimDefence.tag()));
    let ix = calls
        .next()
        .ok_or("a legacy ClaimDefence instruction is not in the archive")?;
    if calls.next().is_some()
        || tx
            .recs
            .iter()
            .filter(|&&i| w.recs[i].kind == Kind::DEFENCE_CLAIM)
            .count()
            != 1
    {
        return Err("multiple defence calls or receipts lack unique instruction attribution");
    }
    Ok(ix)
}

fn claims(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let Some(p) = f.params else { return };
    let s = DefenceParams {
        defence_cap_milli: p.defence_cap_milli,
        tip_min: fees::min_tip_lamports(
            p.min_reveal_priority_milli,
            p.reveal_cu_limit,
            p.reveal_loaded_limit,
        ),
    };
    let mut per_day: BTreeMap<([u8; 32], u32), u64> = BTreeMap::new();
    let mut unverified_days = BTreeSet::new();
    for r in w.of(Kind::DEFENCE_CLAIM) {
        let keeper: [u8; 32] = r.k("beneficiary").try_into().unwrap_or([0; 32]);
        let what = format!("claim of {}", crate::world::b58(&keeper));
        let day = r.pu32("day");
        let amount = r.pu64("amount");
        let day_key = (keeper, day);
        // Any early exit leaves this day unverified. Observed receipt
        // totals below are not proof that a skipped claim was valid.
        let earlier_unverified = !unverified_days.insert(day_key);
        // Receipt totals do not require assigning a receipt to a call. Keep
        // the observed paid amount even when that call cannot be checked,
        // and never charge a partial claim's unpaid demand to later claims.
        let dayc = per_day.entry(day_key).or_default();
        let paid_before = *dayc;
        let Some(paid_after) = paid_before.checked_add(amount) else {
            cx.fail(
                V,
                DEFENCE_REFUND_MISMATCH,
                what,
                r.bell,
                Some(r.tx),
                "the keeper-day's recorded paid amounts overflow u64",
            );
            continue;
        };
        *dayc = paid_after;
        if earlier_unverified {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                format!("an earlier claim for this keeper-day is unverified; receipts report {paid_before} paid before this claim"),
            );
            continue;
        }
        if !w.has_post {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                "no post-states: the claimed slots' evidence cannot be read",
            );
            continue;
        }
        let ix = match unique_claim(w, r) {
            Ok(ix) => ix,
            Err(detail) => {
                cx.missing(V, what, r.bell, Some(r.tx), detail);
                continue;
            }
        };
        let Ok(call) = aix::ClaimDefence::decode(&ix.data) else {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                "ClaimDefence data does not decode",
            );
            continue;
        };
        if ix.key(0) != Some(keeper) || call.day != day || call.n != r.pu8("slots") {
            cx.fail(
                V,
                DEFENCE_REFUND_MISMATCH,
                what,
                r.bell,
                Some(r.tx),
                "the claim's beneficiary, day or slot count differs from its instruction",
            );
            continue;
        }
        if call.n == 0
            || call.n as usize > frontier_abi::layout::beacon::defence_claim::MAX_SLOTS
            || ix.accounts.len() != 5 + 2 * call.n as usize
        {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                "ClaimDefence's slot accounts are incomplete",
            );
            continue;
        }
        let mut caps = ClaimCaps::default();
        let mut bad = None;
        let mut k = 5;
        while let (Some(sk), Some(ak)) = (ix.key(k), ix.key(k + 1)) {
            k += 2;
            let Some(sd) = w.state_before(&sk, r.tx).filter(|d| d.len() >= AS::SIZE) else {
                bad = Some("a claimed slot has no state before the claim".to_string());
                continue;
            };
            let Some(ev) = AS::evidence(sd) else { continue };
            let (bell, ev_slot) = (
                le(&sd[AS::BELL..AS::BELL + 4]) as u32,
                le(&sd[AS::EV_SLOT..AS::EV_SLOT + 8]),
            );
            let region = Facts::region(
                le(&sd[AS::P..AS::P + 2]) as u16 as i16 as i32,
                le(&sd[AS::Q..AS::Q + 2]) as u16 as i16 as i32,
            );
            let anchor = f.anchor(bell, region);
            if anchor.is_none_or(|a| {
                f.ctx.bell_anchor(bell, region) != ak
                    || ev_slot.saturating_sub(a.slot) < p.lateness_slots as u64
            }) || sd[AS::BENEFICIARY..AS::BENEFICIARY + 32] != keeper
                || sd[AS::CLAIMED] != 0
            {
                bad = Some(format!(
                    "slot of bell {bell} is not eligible (lateness, beneficiary or claimed)"
                ));
                continue;
            }
            if caps
                .admit(
                    bell,
                    region,
                    fees::defence_refund(&ev, &s),
                    p.per_bell_region_cap,
                )
                .is_none()
            {
                bad = Some("the claim's capped refunds overflow u64".to_string());
                break;
            }
        }
        let total = caps.capped(p.per_keeper_day_cap, paid_before);
        let partial = r.pu8("partial") != 0;
        if bad.is_some() || amount > total || (!partial && amount != total) {
            cx.fail(
                V,
                DEFENCE_REFUND_MISMATCH,
                what,
                r.bell,
                Some(r.tx),
                bad.unwrap_or_else(|| {
                    format!("claimed {amount} (partial {partial}), the formula gives {total}")
                }),
            );
        } else {
            unverified_days.remove(&day_key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::AnchorFact;
    use crate::input::{Config, Input};
    use crate::world::{Ix as WorldIx, Tx};
    use crate::{Finding, Severity};
    use fclient::ports::Account;
    use frontier_abi::addr::AddrCtx;
    use frontier_abi::presets::M1_LOCAL_7D;
    use permutation_rules::frontier::{beacon::WindowSchedule, clash::BeaconClock};
    use solana_address::Address;

    const KEEPER: Key = [7; 32];
    const OTHER: Key = [8; 32];
    const BELL: u32 = 10;

    fn facts() -> Facts {
        let mut p = M1_LOCAL_7D;
        p.per_bell_region_cap = 17;
        p.per_keeper_day_cap = 25;
        p.min_reveal_priority_milli = 0;
        p.lateness_slots = 1;
        // Literal facts only: no fixture builder, signer, key generation,
        // signature validation, world parser or program dispatcher.
        Facts {
            ctx: AddrCtx {
                season: [1; 32],
                program: [2; 32],
            },
            pk: [0; 96],
            params: Some(p),
            cq: None,
            payout: vec![],
            create_tx: None,
            announce_rec: None,
            created_rec: None,
            genesis_round: 0,
            genesis_ts: 0,
            clock: BeaconClock {
                genesis: 0,
                period: 3,
            },
            window: WindowSchedule::fixed(600),
            margin: 0,
            genesis_seed: None,
            anchors: BTreeMap::from([(
                (BELL, Facts::region(0, 0)),
                vec![AnchorFact {
                    rec: 0,
                    round: 0,
                    a: 0,
                    slot: 1,
                    beneficiary: [0; 32],
                }],
            )]),
            seeds: Default::default(),
            archived: Default::default(),
            sigs: Default::default(),
            ring_seeds: Default::default(),
            citizens: Default::default(),
            by_tag8: Default::default(),
            owners: Default::default(),
            ticket_funder: Default::default(),
            provinces: Default::default(),
            departs: Default::default(),
        }
    }

    fn tx() -> Tx {
        Tx {
            seq: 0,
            slot: 101,
            time: 0,
            sig: String::new(),
            ok: true,
            code: None,
            fee_payer: None,
            keys: vec![],
            ixs: vec![],
            recs: vec![],
            post: Default::default(),
            cu_price: 0,
            cu_limit: 0,
            loaded_limit: 0,
        }
    }

    /// Each tuple is (keeper, day, slot count, actual paid, partial).
    /// Every slot has a different literal address but the same bell-region
    /// and a 20-lamport refund. These are payment-check inputs, not evidence
    /// that a whole season or the instructions ran on chain.
    fn scenario(cases: &[(Key, u32, u8, u64, bool)]) -> (World, Facts) {
        let f = facts();
        let mut w = World {
            has_post: true,
            txs: vec![tx()],
            ..World::default()
        };
        let mut next_slot = 0u8;
        for &(keeper, day, n, amount, partial) in cases {
            let tx_index = w.txs.len();
            let mut t = tx();
            let mut accounts = vec![
                (keeper, true),
                (f.ctx.season, false),
                ([3; 32], true),
                ([4; 32], true),
                ([0; 32], false),
            ];
            for _ in 0..n {
                next_slot = next_slot.checked_add(1).unwrap();
                let mut slot_key = [9; 32];
                slot_key[0] = next_slot;
                let mut data = vec![0; AS::SIZE];
                data[AS::BELL..AS::BELL + 4].copy_from_slice(&BELL.to_le_bytes());
                data[AS::BENEFICIARY..AS::BENEFICIARY + 32].copy_from_slice(&keeper);
                data[AS::EV_SLOT..AS::EV_SLOT + 8].copy_from_slice(&100u64.to_le_bytes());
                data[AS::EV_PRICE..AS::EV_PRICE + 8].copy_from_slice(&20_000u64.to_le_bytes());
                data[AS::EV_LIMIT..AS::EV_LIMIT + 4].copy_from_slice(&1_000u32.to_le_bytes());
                w.txs[0].post.insert(
                    slot_key,
                    Some(Account {
                        lamports: 0,
                        data,
                        owner: Address::new_from_array(f.ctx.program),
                        executable: false,
                    }),
                );
                w.posts.insert(slot_key, vec![0]);
                accounts.push((slot_key, true));
                // Public, deterministic with-seed hash of literal inputs.
                accounts.push((f.ctx.bell_anchor(BELL, Facts::region(0, 0)), false));
            }
            t.ixs.push(WorldIx {
                index: 0,
                data: aix::ClaimDefence { day, n }.to_bytes().to_vec(),
                accounts,
            });
            let mut payload = day.to_le_bytes().to_vec();
            payload.push(n);
            payload.extend_from_slice(&amount.to_le_bytes());
            payload.push(u8::from(partial));
            t.recs.push(w.recs.len());
            w.recs.push(Rec {
                kind: Kind::DEFENCE_CLAIM,
                bell: BELL,
                key: keeper.to_vec(),
                payload,
                bwt: vec![],
                links: vec![],
                tx: tx_index,
                pos: 0,
            });
            w.txs.push(t);
        }
        (w, f)
    }

    fn judge(w: &World, f: &Facts) -> Vec<Finding> {
        let cfg = Config {
            program: Address::new_from_array(f.ctx.program),
            season_id: 0,
            quicknet_pk: [0; 96],
            ruleset_hash: [0; 32],
            program_hash: None,
        };
        let input = Input {
            cfg: cfg.clone(),
            txs: vec![],
            finals: Default::default(),
            final_slot: 0,
            program_hashes: vec![],
            provenance: String::new(),
            scenarios: vec![],
            history: Default::default(),
            resident_feed: None,
        };
        let mut cx = Ctx {
            w,
            f,
            cfg: &cfg,
            input: &input,
            findings: vec![],
            counts: Default::default(),
            liveness: Default::default(),
            sigs: Default::default(),
            v3: false,
            s1: false,
            cq_expected: Default::default(),
            cq_replayed: Default::default(),
            owner_required: Default::default(),
        };
        claims(&mut cx);
        cx.findings
    }

    #[test]
    fn region_cap_resets_per_call_while_day_cap_pays_17_then_8() {
        let (w, f) = scenario(&[(KEEPER, 0, 1, 17, false), (KEEPER, 0, 1, 8, false)]);
        assert_eq!(judge(&w, &f), vec![]);
    }

    #[test]
    fn partial_7_then_17_consumes_24_not_25() {
        let (w, f) = scenario(&[
            (KEEPER, 0, 1, 7, true),
            (KEEPER, 0, 1, 17, false),
            (KEEPER, 0, 1, 1, false),
        ]);
        assert_eq!(judge(&w, &f), vec![]);
    }

    #[test]
    fn region_cap_is_shared_by_slots_in_one_call_only() {
        let (w, f) = scenario(&[(KEEPER, 0, 2, 17, false), (OTHER, 0, 2, 17, false)]);
        assert_eq!(judge(&w, &f), vec![]);
    }

    #[test]
    fn keeper_days_have_separate_allowances() {
        let (w, f) = scenario(&[(KEEPER, 0, 1, 17, false), (KEEPER, 1, 1, 17, false)]);
        assert_eq!(judge(&w, &f), vec![]);
    }

    #[test]
    fn amount_above_remaining_day_allowance_fails() {
        let (w, f) = scenario(&[(KEEPER, 0, 1, 17, false), (KEEPER, 0, 1, 9, false)]);
        let findings = judge(&w, &f);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, DEFENCE_REFUND_MISMATCH);
        assert!(findings[0].detail.contains("formula gives 8"));
    }

    #[test]
    fn multiple_instructions_are_missing_and_taint_later_day_claims() {
        let (mut w, f) = scenario(&[(KEEPER, 0, 1, 7, true), (KEEPER, 0, 1, 17, false)]);
        let mut extra = w.txs[1].ixs[0].clone();
        extra.index = 1;
        w.txs[1].ixs.push(extra);
        let findings = judge(&w, &f);
        assert_eq!(findings.len(), 2);
        assert!(findings
            .iter()
            .all(|x| x.code == MISSING_DATA && x.severity == Severity::Unverifiable));
        assert!(findings[0]
            .detail
            .contains("unique instruction attribution"));
        assert!(findings[1].detail.contains("receipts report 7 paid"));
    }

    #[test]
    fn multiple_receipts_are_not_assigned_to_the_first_instruction() {
        let (mut w, f) = scenario(&[(KEEPER, 0, 1, 7, true), (KEEPER, 0, 1, 17, false)]);
        w.recs[1].tx = 1;
        w.recs[1].pos = 1;
        w.txs[1].recs.push(1);
        w.txs[2].recs.clear();
        w.txs[2].ixs.clear();
        let findings = judge(&w, &f);
        assert_eq!(findings.len(), 2);
        assert!(findings.iter().all(|x| x.code == MISSING_DATA));
        assert!(findings[0]
            .detail
            .contains("unique instruction attribution"));
    }

    #[test]
    fn ambiguous_claim_taint_stays_with_its_keeper_and_day() {
        let (mut w, f) = scenario(&[
            (KEEPER, 0, 1, 7, true),
            (OTHER, 0, 1, 17, false),
            (KEEPER, 1, 1, 17, false),
        ]);
        let mut extra = w.txs[1].ixs[0].clone();
        extra.index = 1;
        w.txs[1].ixs.push(extra);
        let findings = judge(&w, &f);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, MISSING_DATA);
        assert_eq!(findings[0].severity, Severity::Unverifiable);
        assert!(findings[0]
            .detail
            .contains("unique instruction attribution"));
    }

    #[test]
    fn missing_legacy_call_is_not_a_zero_demand_claim() {
        let (mut w, f) = scenario(&[(KEEPER, 0, 1, 0, true)]);
        w.txs[1].ixs[0].data[0] = 0xff;
        let findings = judge(&w, &f);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, MISSING_DATA);
    }

    #[test]
    fn receipt_identity_must_match_the_unique_instruction() {
        for field in ["beneficiary", "day", "slots"] {
            let (mut w, f) = scenario(&[(KEEPER, 0, 1, 17, false)]);
            match field {
                "beneficiary" => w.recs[0].key = OTHER.to_vec(),
                "day" => w.recs[0].payload[0] = 1,
                "slots" => w.recs[0].payload[4] = 2,
                _ => unreachable!(),
            }
            let findings = judge(&w, &f);
            assert_eq!(findings.len(), 1);
            assert_eq!(findings[0].code, DEFENCE_REFUND_MISMATCH);
            assert!(findings[0].detail.contains("differs from its instruction"));
        }
    }

    #[test]
    fn receipt_total_overflow_fails_without_wrapping() {
        let (w, f) = scenario(&[(KEEPER, 0, 1, u64::MAX, true), (KEEPER, 0, 1, 1, true)]);
        let findings = judge(&w, &f);
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[1].code, DEFENCE_REFUND_MISMATCH);
        assert!(findings[1].detail.contains("paid amounts overflow"));
    }

    #[test]
    fn refund_total_overflow_is_checked_before_counter_mutation() {
        let mut caps = ClaimCaps::default();
        assert_eq!(caps.admit(10, 1, u64::MAX, u64::MAX), Some(()));
        assert_eq!(caps.admit(10, 1, u64::MAX, u64::MAX), Some(()));
        assert_eq!(caps.admit(10, 2, 1, u64::MAX), None);
        assert_eq!(caps.total, u64::MAX);
        assert_eq!(caps.regions[&(10, 2)], 0);
        assert_eq!(caps.capped(25, u64::MAX), 0);
    }

    #[test]
    fn lateness_near_u64_max_does_not_overflow() {
        let (mut w, mut f) = scenario(&[(KEEPER, 0, 1, 17, false)]);
        f.anchors.values_mut().next().unwrap()[0].slot = u64::MAX;
        let slot = w.txs[1].ixs[0].key(5).unwrap();
        let data = &mut w.txs[0].post.get_mut(&slot).unwrap().as_mut().unwrap().data;
        data[AS::EV_SLOT..AS::EV_SLOT + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        let findings = judge(&w, &f);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, DEFENCE_REFUND_MISMATCH);
        assert!(findings[0].detail.contains("not eligible"));
    }
}
