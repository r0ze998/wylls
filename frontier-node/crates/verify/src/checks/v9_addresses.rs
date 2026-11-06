//! V9 — accounts at canonical addresses (contract §4.1, §8.5; I-02).
//!
//! Every program account of this season the archive or the final states
//! show — by its magic — sits at the address its own key fields derive
//! (`frontier_abi::addr::AddrCtx`, with-seed from the Season PDA). A
//! pre-funded address never blocks an init (§4.2): failed transactions
//! whose account was pre-funded are listed for information only.
//!
//! Codes: `NonCanonicalAddress`; info `PrefundedAddress`.

use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::{
    beacon::{anchor_archive as AA, bell_anchor as BA, defence_claim as DC, seed_cache as SC},
    clash::{arrival_day as AD, arrival_slot as AS, clash_inputs as CI},
    header as HD,
    player::holding as H,
    province::province as PV,
    world::{beacon_log as BL, join_shard as JS, province_fund as PF, ring_seed as RS},
    AccountKind,
};
use frontier_abi::resident_citizen::{is_flagged, record_tag15};

use super::v1_chains::kind_by_magic;
use super::{ent, Ctx};
use crate::codes::*;
use crate::world::{le, Key};

const V: &str = "V9";

fn i16at(d: &[u8], o: usize) -> i32 {
    le(d.get(o..o + 2).unwrap_or(&[0, 0])) as u16 as i16 as i32
}
fn u8at(d: &[u8], o: usize) -> u8 {
    d.get(o).copied().unwrap_or(0)
}
fn u32at(d: &[u8], o: usize) -> u32 {
    le(d.get(o..o + 4).unwrap_or(&[0; 4])) as u32
}
fn arr32(d: &[u8], o: usize) -> [u8; 32] {
    d.get(o..o + 32)
        .and_then(|s| s.try_into().ok())
        .unwrap_or([0; 32])
}

/// The canonical address of an account of `kind` with bytes `d` (`None`:
/// a kind without a derivable key here, e.g. another season's Season).
pub fn canonical(ctx: &AddrCtx, kind: AccountKind, d: &[u8]) -> Option<Key> {
    use AccountKind::*;
    Some(match kind {
        Season => ctx.season,
        Frontier => ctx.frontier(),
        RingSeed => ctx.ring_seed(le(d.get(RS::D..RS::D + 2)?) as u16),
        ProvinceFund => ctx.province_fund(u8at(d, PF::WEDGE)),
        JoinShard => ctx.join_shard(u8at(d, JS::FACTION), u8at(d, JS::SHARD)),
        BeaconLog => ctx.beacon_log(u8at(d, BL::REGION)),
        DefencePool => ctx.defence_pool(),
        // A wallet Citizen at its wallet's tag; a ⑳ NFT-resident Citizen
        // (`nft-experimental` programs) at its resident ID's. A flagged
        // Citizen without a resident asset derives nothing here and is
        // failed by `run` itself.
        Citizen => ctx.citizen_by_tag15(&record_tag15(d)?),
        Holding => ctx.holding(i16at(d, H::P), i16at(d, H::Q), u8at(d, H::SITE)),
        Province => ctx.province(i16at(d, PV::P), i16at(d, PV::Q)),
        ArrivalSlot => ctx.arrival_slot(
            i16at(d, AS::P),
            i16at(d, AS::Q),
            u32at(d, AS::BELL),
            u8at(d, AS::FACTION),
            u8at(d, AS::I),
        ),
        ArrivalDay => ctx.arrival_day(i16at(d, AD::P), i16at(d, AD::Q), u32at(d, AD::DAY)),
        ClashInputs => ctx.clash_inputs(i16at(d, CI::P), i16at(d, CI::Q), u32at(d, CI::BELL)),
        BellAnchor => ctx.bell_anchor(u32at(d, BA::BELL), u8at(d, BA::REGION)),
        SeedCache => ctx.seed_cache(u32at(d, SC::BELL), u8at(d, SC::REGION), u8at(d, SC::NONCE)),
        AnchorArchive => ctx.anchor_archive(u8at(d, AA::REGION), u32at(d, AA::PART)),
        DefenceClaim => ctx.defence_claim(&arr32(d, DC::BENEFICIARY), u32at(d, DC::DAY)),
    })
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let sid = cx.cfg.season_id;
    let mut seen = std::collections::BTreeSet::new();
    let mut check = |cx: &mut Ctx, k: &Key, d: &[u8], tx: Option<usize>| {
        if !seen.insert(*k) {
            return;
        }
        let Some(kind) = kind_by_magic(d) else { return };
        if le(d.get(HD::SEASON_ID..HD::SEASON_ID + 8).unwrap_or(&[])) != sid {
            return;
        }
        if kind == AccountKind::Citizen && is_flagged(d) && record_tag15(d).is_none() {
            cx.fail(
                V,
                NON_CANONICAL_ADDRESS,
                ent(kind.name(), k),
                0,
                tx,
                "a resident-flagged Citizen carries a wallet or no resident asset",
            );
            return;
        }
        if let Some(want) = canonical(&f.ctx, kind, d) {
            if want != *k {
                cx.fail(
                    V,
                    NON_CANONICAL_ADDRESS,
                    ent(kind.name(), k),
                    0,
                    tx,
                    "the account is not at the address its key derives",
                );
            }
        }
    };
    for (i, t) in w.txs.iter().enumerate().filter(|(_, t)| t.ok) {
        for (k, a) in &t.post {
            if let Some(a) = a {
                if a.owner.to_bytes() == w.program {
                    check(cx, k, &a.data, Some(i));
                }
            }
        }
    }
    for (k, a) in &w.finals {
        if let Some(a) = a {
            if a.owner.to_bytes() == w.program {
                check(cx, k, &a.data, None);
            }
        }
    }
    // ⑳ RESIDENT_JOINED (kind 130): see `resident_joined_findings`.
    for (n, why) in resident_joined_findings(cx.w) {
        let c = &cx.w.cq_recs[n];
        cx.fail(
            V,
            NON_CANONICAL_ADDRESS,
            "RESIDENT_JOINED".to_string(),
            c.bell,
            Some(c.tx),
            why,
        );
    }
    // A JoinResident whose RESIDENT_JOINED is not in its transaction.
    for (i, why) in joins_without_their_record(cx.w) {
        let truncated = cx.input.txs.get(i).is_some_and(|r| {
            r.logs
                .iter()
                .any(|l| l == super::v0_evidence::LOG_TRUNCATED)
        });
        if truncated {
            cx.unverifiable(V, NON_CANONICAL_ADDRESS, "JoinResident".to_string(), 0, Some(i), format!(
                "{why}; the runtime cut this transaction's logs, so the record may be in the cut part"
            ));
        } else {
            cx.fail(
                V,
                NON_CANONICAL_ADDRESS,
                "JoinResident".to_string(),
                0,
                Some(i),
                why,
            );
        }
    }
    // Pre-funded addresses (informational, §4.2): an init at an address
    // that already held lamports keeps them, so such an account ends above
    // its rent minimum; none of them blocked an init (the init that
    // created it landed, or V1 would miss its records).
    let mut prefunded = 0u64;
    for a in w.finals.values().flatten() {
        if a.owner.to_bytes() == w.program {
            if let Some(kind) = kind_by_magic(&a.data) {
                if kind != AccountKind::Season && a.lamports > kind.rent() && !is_pool(kind) {
                    prefunded += 1;
                }
            }
        }
    }
    if prefunded > 0 {
        cx.warn(
            V,
            PREFUNDED,
            "accounts",
            0,
            None,
            format!("{prefunded} accounts hold more than their rent (pre-funded or escrow; informational)"),
        );
    }
}

/// The RESIDENT_JOINED records (by index into `cq_recs`) that do not stand:
/// a key that is not its asset's resident ID; a record that does not stand
/// for the JoinResident of its own transaction (asset, generation, faction,
/// shard, bell; `facts::resident_joined_problem`); or a second record of a
/// resident ID in the Season (one NFT, one Citizen per world).
pub fn resident_joined_findings(w: &crate::world::World) -> Vec<(usize, &'static str)> {
    let mut out = vec![];
    let mut seen = std::collections::BTreeSet::new();
    for (n, c) in w.cq_recs.iter().enumerate() {
        if c.kind != frontier_abi::v2::log::CqKind::RESIDENT_JOINED {
            continue;
        }
        let why = match w.txs.get(c.tx) {
            Some(tx) => crate::facts::resident_joined_problem(c, tx),
            None => Some("the record's transaction is missing"),
        };
        let why = why.or_else(|| {
            (!seen.insert(c.key.clone()))
                .then_some("a second RESIDENT_JOINED of this resident ID in the Season")
        });
        if let Some(why) = why {
            out.push((n, why));
        }
    }
    out
}

/// The successful transactions (by index) whose top-level JoinResident
/// (0xE1) has no RESIDENT_JOINED in the same transaction that stands for it
/// (its asset, generation and faction; `facts::resident_joined_problem`).
/// JoinResident writes one on every success, so its absence means the
/// record is missing from the archive (or the logs were cut).
pub fn joins_without_their_record(w: &crate::world::World) -> Vec<(usize, &'static str)> {
    use frontier_abi::resident_wire::{decode, Command};
    let mut out = vec![];
    for (i, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        for ix in &tx.ixs {
            let Some(Command::Join {
                generation,
                faction,
            }) = decode(&ix.data)
            else {
                continue;
            };
            let Some(asset) = ix.key(8) else {
                out.push((i, "a JoinResident without its asset account"));
                continue;
            };
            let stands = w.cq_recs.iter().any(|c| {
                c.tx == i
                    && c.kind == frontier_abi::v2::log::CqKind::RESIDENT_JOINED
                    && c.field("asset", true) == asset.as_slice()
                    && c.field("generation", true) == generation.to_le_bytes().as_slice()
                    && c.field("faction", true) == [faction].as_slice()
                    && crate::facts::resident_joined_problem(c, tx).is_none()
            });
            if !stands {
                out.push((
                    i,
                    "a JoinResident whose RESIDENT_JOINED is missing from its transaction",
                ));
            }
        }
    }
    out
}

/// Kinds that hold lamports above rent by design (funds, pools, escrows).
fn is_pool(k: AccountKind) -> bool {
    matches!(
        k,
        AccountKind::ProvinceFund
            | AccountKind::DefencePool
            | AccountKind::Holding
            | AccountKind::Citizen
    )
}

#[cfg(test)]
mod resident_tests {
    //! ⑳: literal addresses only — no key is generated, derived or signed.
    use super::*;
    use frontier_abi::layout::player::citizen as C;
    use frontier_abi::resident_citizen::{mark, resident_tag15, FLAG_RESIDENT, RESIDENT_FLAGS};

    fn ctx() -> AddrCtx {
        AddrCtx {
            season: [0x22; 32],
            program: [0x11; 32],
        }
    }

    fn citizen(wallet: [u8; 32]) -> Vec<u8> {
        let mut d = vec![0u8; frontier_abi::v2::layout::player::citizen::SIZE];
        d[C::WALLET..C::WALLET + 32].copy_from_slice(&wallet);
        d
    }

    #[test]
    fn wallet_citizen_address_is_unchanged() {
        let c = ctx();
        let d = citizen([7; 32]);
        assert_eq!(
            canonical(&c, AccountKind::Citizen, &d),
            Some(c.citizen(&[7; 32]))
        );
    }

    #[test]
    fn nft_citizen_address_comes_from_the_resident_id() {
        let c = ctx();
        let asset = [0x5a; 32];
        let mut d = citizen([0; 32]);
        assert!(mark(&mut d, &asset));
        let want = c.citizen_by_tag15(&resident_tag15(&asset));
        assert_eq!(canonical(&c, AccountKind::Citizen, &d), Some(want));
        // Not the zero wallet's Citizen (the old reading of WALLET).
        assert_ne!(want, c.citizen(&[0; 32]));
    }

    #[test]
    fn a_flagged_citizen_with_a_wallet_derives_nothing() {
        let mut d = citizen([7; 32]);
        d[RESIDENT_FLAGS] = FLAG_RESIDENT;
        assert_eq!(canonical(&ctx(), AccountKind::Citizen, &d), None);
        assert!(is_flagged(&d) && record_tag15(&d).is_none());
    }
}

#[cfg(test)]
mod resident_joined_tests {
    //! ⑳ with workstream 11: literal bytes only (no key is generated, derived or signed).
    use super::resident_joined_findings;
    use crate::facts::resident_tests::{join_ix, joined, tx_with};
    use crate::world::World;

    #[test]
    fn one_record_per_join_and_per_resident_id() {
        let asset = [0x5a; 32];
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        // Two worlds' worth of joins in one Season's log: the second is refused.
        let w = World {
            cq_recs: vec![joined(tag15, asset, 4, 0, 0), joined(tag15, asset, 4, 0, 1)],
            txs: vec![
                tx_with(vec![join_ix(asset, 0, 4)]),
                tx_with(vec![join_ix(asset, 0, 4)]),
            ],
            ..Default::default()
        };
        let f = resident_joined_findings(&w);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].0, 1);
        assert!(f[0].1.contains("second"));
    }

    #[test]
    fn a_record_without_its_join_or_with_a_forged_key_fails() {
        let asset = [0x5a; 32];
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        let w = World {
            cq_recs: vec![
                joined(tag15, asset, 4, 0, 0),
                joined([9; 15], asset, 4, 0, 1),
                joined(tag15, asset, 4, 0, 7),
            ],
            // tx 0 ran no JoinResident; tx 1 did, but the key is forged; tx 7 is missing.
            txs: vec![tx_with(vec![]), tx_with(vec![join_ix(asset, 0, 4)])],
            ..Default::default()
        };
        let f = resident_joined_findings(&w);
        assert_eq!(f.iter().map(|x| x.0).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(f[0].1.contains("JoinResident"));
        assert!(f[1].1.contains("resident ID"));
        assert!(f[2].1.contains("missing"));
    }

    /// 04: every JoinResident needs its record; a record of another join,
    /// another generation or another faction does not stand in for it.
    #[test]
    fn a_join_without_its_record_is_found() {
        use super::joins_without_their_record;
        let asset = [0x5a; 32];
        let other = [0x6b; 32];
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        let tag_other = frontier_abi::resident_citizen::resident_tag15(&other);
        let w = World {
            cq_recs: vec![
                // tx 0: the right record. tx 1: none. tx 2: another asset's
                // record (with its own join). tx 3: wrong generation.
                // tx 4: wrong faction.
                joined(tag15, asset, 4, 3, 0),
                joined(tag_other, other, 4, 3, 2),
                joined(tag15, asset, 4, 9, 3),
                joined(tag15, asset, 5, 3, 4),
            ],
            txs: vec![
                tx_with(vec![join_ix(asset, 3, 4)]),
                tx_with(vec![join_ix(asset, 3, 4)]),
                tx_with(vec![join_ix(asset, 3, 4), join_ix(other, 3, 4)]),
                tx_with(vec![join_ix(asset, 3, 4)]),
                tx_with(vec![join_ix(asset, 3, 4)]),
            ],
            ..Default::default()
        };
        let f = joins_without_their_record(&w);
        assert_eq!(f.iter().map(|x| x.0).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert!(f.iter().all(|x| x.1.contains("missing")));
        // A failed transaction is not judged.
        let mut failed = tx_with(vec![join_ix(asset, 3, 4)]);
        failed.ok = false;
        let w = World {
            txs: vec![failed],
            ..Default::default()
        };
        assert!(joins_without_their_record(&w).is_empty());
    }

    /// The whole NFT join, as V9 judges it: the right record and its join
    /// pass both ways; forged, missing, mismatched or duplicated parts fail.
    #[test]
    fn a_correct_nft_join_passes_and_every_broken_one_fails() {
        use super::joins_without_their_record;
        let asset = [0x5a; 32];
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        let ok = World {
            cq_recs: vec![joined(tag15, asset, 4, 3, 0)],
            txs: vec![tx_with(vec![join_ix(asset, 3, 4)])],
            ..Default::default()
        };
        assert!(resident_joined_findings(&ok).is_empty());
        assert!(joins_without_their_record(&ok).is_empty());
        let broken = |cq_recs, txs| {
            let w = World {
                cq_recs,
                txs,
                ..Default::default()
            };
            resident_joined_findings(&w).len() + joins_without_their_record(&w).len()
        };
        // Forged: the key is not the asset's resident ID.
        assert!(
            broken(
                vec![joined([9; 15], asset, 4, 3, 0)],
                vec![tx_with(vec![join_ix(asset, 3, 4)])]
            ) > 0
        );
        // Missing: the record without its join, the join without its record.
        assert!(broken(vec![joined(tag15, asset, 4, 3, 0)], vec![tx_with(vec![])]) > 0);
        assert!(broken(vec![], vec![tx_with(vec![join_ix(asset, 3, 4)])]) > 0);
        // Mismatched: generation, faction, asset account.
        assert!(
            broken(
                vec![joined(tag15, asset, 4, 3, 0)],
                vec![tx_with(vec![join_ix(asset, 2, 4)])]
            ) > 0
        );
        assert!(
            broken(
                vec![joined(tag15, asset, 4, 3, 0)],
                vec![tx_with(vec![join_ix(asset, 3, 1)])]
            ) > 0
        );
        assert!(
            broken(
                vec![joined(tag15, asset, 4, 3, 0)],
                vec![tx_with(vec![join_ix([0x6b; 32], 3, 4)])]
            ) > 0
        );
        // Duplicated: a second join of the same NFT in the Season.
        assert!(
            broken(
                vec![joined(tag15, asset, 4, 3, 0), joined(tag15, asset, 4, 3, 1)],
                vec![
                    tx_with(vec![join_ix(asset, 3, 4)]),
                    tx_with(vec![join_ix(asset, 3, 4)])
                ]
            ) > 0
        );
    }

    #[test]
    fn a_record_that_stands_for_its_join_passes() {
        let asset = [0x5a; 32];
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        let w = World {
            cq_recs: vec![joined(tag15, asset, 4, 3, 0)],
            txs: vec![tx_with(vec![join_ix(asset, 3, 4)])],
            ..Default::default()
        };
        assert!(resident_joined_findings(&w).is_empty());
    }
}
