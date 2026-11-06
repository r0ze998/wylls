//! V27 — JoinResident (⑳'s 0xE1, `nft-experimental` programs; ⑪ r9 with
//! ⑳'s `facts::resident_joined_problem`). Every successful top-level
//! JoinResident stands for exactly one NFT Citizen that the program created
//! as `permutation-frontier/src/proc/resident.rs` `join` creates it:
//!
//! - **record:** its transaction carries a RESIDENT_JOINED that stands for
//!   it (`facts::resident_joined_problem`: the key is the asset's resident
//!   ID, the asset, generation and faction are the instruction's, the shard
//!   is the asset's, the join bell is the record's bell). With whole logs a
//!   JoinResident without one is a FAIL; with logs missing or cut it is V0E's
//!   (UNVERIFIABLE). A second record of the resident ID in the Season is
//!   ⑳'s V9 FAIL;
//! - **accounts:** the Season (2), the Frontier (3) and the Citizen (4) are
//!   this Season's canonical ones, the Citizen at `citizen_by_tag15(resident
//!   ID)`;
//! - **time:** the record's bell is the bell of the transaction's time, and
//!   before the Season's `join_close_bell`; the faction is a faction;
//! - **state (archives with post-states):** the Citizen's post-state is a
//!   Citizen of this Season with the record's faction, join bell and shard,
//!   joined, a zero wallet, its tag, and the asset as its resident asset;
//!   the link (7) holds `{asset, resident (9), citizen (4)}`. A post-state
//!   the archive lacks is UNVERIFIABLE (`MissingPostState`).
//!
//! Not judged here (no archived evidence): the Core asset's owner and
//! transfer guard and the resident program's current generation, which the
//! program reads from read-only accounts; like a wallet's signature, the
//! runtime accepted them. Codes: `ResidentJoinMismatch`,
//! `NonCanonicalAddress`, `MissingPostState`.

use frontier_abi::layout::player::citizen as C;
use frontier_abi::resident_wire::{self, Command};

use super::Ctx;
use crate::codes::*;
use crate::world::{CqRec, Tx, World};
use crate::Severity;

const V: &str = "V27";

/// JoinResident's account positions: `[owner] [payer] [season] [frontier]
/// [citizen] [system] [policy] [link] [asset] [resident] [join_gate?]`.
const SEASON: usize = 2;
const FRONTIER: usize = 3;
const CITIZEN: usize = 4;
const LINK: usize = 7;
const ASSET: usize = 8;
const RESIDENT: usize = 9;

/// What V27 needs of the Season besides the archive.
#[derive(Clone, Copy, Debug)]
pub struct JoinCtx {
    pub addr: frontier_abi::addr::AddrCtx,
    pub season_id: u64,
    pub genesis_ts: i64,
    pub join_close_bell: u32,
    pub program: [u8; 32],
}

/// One finding: severity, code, transaction, detail.
pub type Found = (Severity, &'static str, usize, String);

/// Whether the logs show every invocation of the program ending (no cut,
/// no lost tail): only then is an absent record evidence of absence.
fn logs_whole(logs: &[String], program: &str) -> bool {
    let invoke = format!("Program {program} invoke [");
    let started = logs.iter().filter(|l| l.starts_with(&invoke)).count();
    let ended = logs
        .iter()
        .filter(|l| **l == format!("Program {program} success"))
        .count();
    started > 0 && started == ended && !logs.iter().any(|l| l == super::v0_evidence::LOG_TRUNCATED)
}

fn le32(b: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(b.try_into().ok()?))
}

fn citizen_problem(d: &[u8], jc: &JoinCtx, rec: &CqRec, addr: &[u8; 32]) -> Option<String> {
    let asset: [u8; 32] = rec.field("asset", true).try_into().ok()?;
    let faction = *rec.field("faction", true).first()?;
    let shard = *rec.field("shard", true).first()?;
    let want: [(&str, bool); 8] = [
        ("magic", d.get(..8) == Some(&C::MAGIC[..])),
        (
            "season",
            d.get(8..16) == Some(&jc.season_id.to_le_bytes()[..]),
        ),
        ("faction", d.get(C::FACTION) == Some(&faction)),
        (
            "joined",
            d.get(C::FLAGS).is_some_and(|f| f & C::FLAG_JOINED != 0),
        ),
        (
            "join bell",
            d.get(C::JOIN_BELL..C::JOIN_BELL + 4).and_then(le32) == Some(rec.bell),
        ),
        ("join shard", d.get(C::JOIN_SHARD) == Some(&shard)),
        (
            "wallet",
            d.get(C::WALLET..C::WALLET + 32) == Some(&[0u8; 32][..])
                && d.get(C::CITIZEN_TAG..C::CITIZEN_TAG + 8) == Some(&addr[..8]),
        ),
        (
            "resident asset",
            frontier_abi::resident_citizen::resident_asset(d) == Some(asset),
        ),
    ];
    let bad: Vec<&str> = want.iter().filter(|x| !x.1).map(|x| x.0).collect();
    (!bad.is_empty()).then(|| {
        format!(
            "the new Citizen's {} differ from the join's",
            bad.join(", ")
        )
    })
}

/// The findings for one successful transaction's JoinResidents.
pub fn judge_tx(w: &World, jc: &JoinCtx, i: usize, t: &Tx, logs: &[String]) -> Vec<Found> {
    let mut out = vec![];
    let program = solana_address::Address::new_from_array(jc.program).to_string();
    for ix in &t.ixs {
        if ix.tag() != Some(resident_wire::JOIN_RESIDENT) {
            continue;
        }
        // V0 fails data that does not decode.
        let Some(Command::Join {
            generation,
            faction,
        }) = resident_wire::decode(&ix.data)
        else {
            continue;
        };
        let mut fail = |code: &'static str, d: String| out.push((Severity::Fail, code, i, d));
        let Some(asset) = ix.key(ASSET) else {
            fail(
                RESIDENT_JOIN_MISMATCH,
                "JoinResident names no asset account".into(),
            );
            continue;
        };
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
        let citizen = jc.addr.citizen_by_tag15(&tag15);
        for (pos, want, what) in [
            (SEASON, jc.addr.season, "Season"),
            (FRONTIER, jc.addr.frontier(), "Frontier"),
            (
                CITIZEN,
                citizen,
                "Citizen (citizen_by_tag15 of the resident ID)",
            ),
        ] {
            if ix.key(pos) != Some(want) {
                fail(
                    NON_CANONICAL_ADDRESS,
                    format!("JoinResident account {pos} is not this Season's {what}"),
                );
            }
        }
        if faction >= frontier_abi::layout::world::join_shard::FACTIONS {
            fail(
                RESIDENT_JOIN_MISMATCH,
                format!("JoinResident faction {faction} is not a faction"),
            );
        }
        // The record that stands for this join.
        let recs: Vec<&CqRec> = w
            .cq_recs
            .iter()
            .filter(|c| {
                c.tx == i
                    && c.kind == frontier_abi::v2::log::CqKind::RESIDENT_JOINED
                    && c.field("asset", true) == asset
                    && crate::facts::resident_joined_problem(c, t).is_none()
                    && le32(c.field("generation", true)) == Some(generation)
                    && c.field("faction", true) == [faction]
            })
            .collect();
        let rec = match recs.as_slice() {
            [r] => *r,
            [] => {
                if logs_whole(logs, &program) {
                    fail(
                        RESIDENT_JOIN_MISMATCH,
                        "JoinResident succeeded and its logs carry no RESIDENT_JOINED that stands for it".into(),
                    );
                }
                continue;
            }
            _ => {
                fail(
                    RESIDENT_JOIN_MISMATCH,
                    "JoinResident's transaction carries more than one RESIDENT_JOINED for it"
                        .into(),
                );
                continue;
            }
        };
        let now = frontier_abi::prologue::bell_at(jc.genesis_ts, t.time);
        if now != Some(rec.bell) {
            fail(
                RESIDENT_JOIN_MISMATCH,
                format!(
                    "RESIDENT_JOINED bell {} is not the bell {now:?} of its transaction's time {}",
                    rec.bell, t.time
                ),
            );
        }
        if rec.bell >= jc.join_close_bell {
            fail(
                RESIDENT_JOIN_MISMATCH,
                format!(
                    "JoinResident at bell {} is not before join_close_bell {}",
                    rec.bell, jc.join_close_bell
                ),
            );
        }
        if !w.has_post {
            continue;
        }
        match t.post.get(&citizen) {
            Some(Some(a)) => {
                if let Some(d) = citizen_problem(&a.data, jc, rec, &citizen) {
                    fail(RESIDENT_JOIN_MISMATCH, d);
                }
            }
            _ => out.push((
                Severity::Unverifiable,
                MISSING_POST_STATE,
                i,
                "the archive has no post-state of the Citizen JoinResident created".into(),
            )),
        }
        let link = ix.key(LINK);
        match link.and_then(|k| t.post.get(&k)) {
            Some(Some(a)) => {
                let ok = ix.key(RESIDENT).is_some_and(|r| {
                    frontier_abi::resident_binding::read(&a.data).is_some_and(|b| {
                        frontier_abi::resident_binding::matches(&b, &asset, &r, &citizen)
                    })
                });
                if !ok {
                    out.push((
                        Severity::Fail,
                        RESIDENT_JOIN_MISMATCH,
                        i,
                        "the link's post-state does not bind this asset, resident and Citizen"
                            .into(),
                    ));
                }
            }
            _ => out.push((
                Severity::Unverifiable,
                MISSING_POST_STATE,
                i,
                "the archive has no post-state of the link JoinResident wrote".into(),
            )),
        }
    }
    out
}

pub fn run(cx: &mut Ctx) {
    let (w, f) = (cx.w, cx.f);
    let Some(p) = f.params.as_ref() else {
        return;
    };
    let jc = JoinCtx {
        addr: f.ctx,
        season_id: cx.cfg.season_id,
        genesis_ts: f.genesis_ts,
        join_close_bell: p.join_close_bell,
        program: w.program,
    };
    let mut found = vec![];
    for (i, t) in w.txs.iter().enumerate() {
        if !t.ok {
            continue;
        }
        let logs = cx
            .input
            .txs
            .get(i)
            .map(|r| r.logs.as_slice())
            .unwrap_or(&[]);
        found.extend(judge_tx(w, &jc, i, t, logs));
    }
    for (sev, code, i, d) in found {
        let entity = format!("tx#{i}");
        match sev {
            Severity::Fail => cx.fail(V, code, entity, 0, Some(i), d),
            _ => cx.unverifiable(V, code, entity, 0, Some(i), d),
        }
    }
}

#[cfg(test)]
mod tests {
    //! ⑪ r9: literal bytes and a literal address context only. No key is
    //! generated, derived or signed: the Season address is written in, the
    //! Citizen's is `create_with_seed` arithmetic (SHA-256), the resident ID
    //! is a SHA-256 of a literal asset id.
    use super::*;
    use crate::facts::resident_tests::joined;
    use crate::world::{Ix, Tx};
    use fclient::ports::Account;
    use frontier_abi::addr::AddrCtx;
    use frontier_abi::resident_binding;
    use std::collections::BTreeMap;

    const GENESIS: i64 = 1_000_000;
    const BELL: u32 = 40; // `joined`'s join bell and record bell
    const NFT: [u8; 32] = [0x5a; 32];
    const RESIDENT_ACC: [u8; 32] = [0x79; 32];
    const LINK_ACC: [u8; 32] = [0x77; 32];
    const GEN: u32 = 3;
    const FACTION: u8 = 4;

    fn jc() -> JoinCtx {
        JoinCtx {
            addr: AddrCtx {
                season: [0x22; 32],
                program: [0x11; 32],
            },
            season_id: 7,
            genesis_ts: GENESIS,
            join_close_bell: 1_512,
            program: [0x11; 32],
        }
    }

    fn citizen_addr() -> [u8; 32] {
        jc().addr
            .citizen_by_tag15(&frontier_abi::resident_citizen::resident_tag15(&NFT))
    }

    fn acc(data: Vec<u8>) -> Option<Account> {
        Some(Account {
            lamports: 1,
            data,
            owner: solana_address::Address::new_from_array([0x11; 32]),
            executable: false,
        })
    }

    /// The Citizen as `proc::resident::join` writes it.
    fn citizen_data() -> Vec<u8> {
        let mut d = vec![0u8; C::SIZE];
        d[..8].copy_from_slice(&C::MAGIC);
        d[8..16].copy_from_slice(&7u64.to_le_bytes());
        d[C::FACTION] = FACTION;
        d[C::FLAGS] = C::FLAG_JOINED;
        d[C::JOIN_BELL..C::JOIN_BELL + 4].copy_from_slice(&BELL.to_le_bytes());
        d[C::JOIN_SHARD] = frontier_abi::addr::join_shard_of(&NFT);
        d[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&citizen_addr()[..8]);
        assert!(frontier_abi::resident_citizen::mark(&mut d, &NFT));
        d
    }

    fn link_data(citizen: [u8; 32]) -> Vec<u8> {
        let mut d = vec![0u8; resident_binding::LEN];
        assert!(resident_binding::write_once(
            &mut d,
            &resident_binding::Record {
                asset: NFT,
                resident: RESIDENT_ACC,
                citizen,
            }
        ));
        d
    }

    fn join_ix(generation: u32, faction: u8) -> Ix {
        let j = jc();
        let mut data = vec![resident_wire::JOIN_RESIDENT];
        data.extend_from_slice(&generation.to_le_bytes());
        data.push(faction);
        let keys: [[u8; 32]; 10] = [
            [0x70; 32],
            [0x71; 32],
            j.addr.season,
            j.addr.frontier(),
            citizen_addr(),
            [0; 32],
            [0x76; 32],
            LINK_ACC,
            NFT,
            RESIDENT_ACC,
        ];
        Ix {
            index: 0,
            data,
            accounts: keys.iter().map(|k| (*k, true)).collect(),
        }
    }

    /// A Season log with one honest JoinResident (tx 0).
    fn honest() -> (World, Vec<String>) {
        let mut post = BTreeMap::new();
        post.insert(citizen_addr(), acc(citizen_data()));
        post.insert(LINK_ACC, acc(link_data(citizen_addr())));
        let tx = Tx {
            seq: 0,
            slot: 0,
            time: GENESIS + BELL as i64 * 600 + 5,
            sig: String::new(),
            ok: true,
            code: None,
            fee_payer: None,
            keys: vec![],
            ixs: vec![join_ix(GEN, FACTION)],
            recs: vec![],
            post,
            cu_price: 0,
            cu_limit: 0,
            loaded_limit: 0,
        };
        let tag15 = frontier_abi::resident_citizen::resident_tag15(&NFT);
        let w = World {
            cq_recs: vec![joined(tag15, NFT, FACTION, GEN, 0)],
            txs: vec![tx],
            has_post: true,
            program: [0x11; 32],
            ..Default::default()
        };
        let p = solana_address::Address::new_from_array([0x11; 32]);
        (
            w,
            vec![
                format!("Program {p} invoke [1]"),
                format!("Program {p} success"),
            ],
        )
    }

    /// V27 with ⑳'s V9 rules on the same log: (severity, code) per finding.
    fn judge(w: &World, logs: &[String]) -> Vec<(Severity, &'static str)> {
        let mut out: Vec<_> = judge_tx(w, &jc(), 0, &w.txs[0], logs)
            .into_iter()
            .map(|f| (f.0, f.1))
            .collect();
        out.extend(
            crate::checks::v9_addresses::resident_joined_findings(w)
                .into_iter()
                .map(|_| (Severity::Fail, NON_CANONICAL_ADDRESS)),
        );
        out
    }

    fn fails(v: &[(Severity, &'static str)]) -> bool {
        v.iter().any(|f| f.0 == Severity::Fail)
    }

    #[test]
    fn an_honest_join_resident_has_no_finding() {
        let (w, logs) = honest();
        assert_eq!(judge(&w, &logs), vec![]);
        // V0 judges the instruction itself as modelled in an NFT season.
        let pv = Some(super::super::v0_coverage::PROGRAM_VERSION_NFT_S1);
        assert_eq!(
            super::super::v0_coverage::judge_outside_v2(0xE1, &w.txs[0].ixs[0].data, pv, true),
            None
        );
        // ⑱: when the S1 checks (and so V27) do not run, the same join is
        // Unverifiable, never left unjudged.
        assert!(matches!(
            super::super::v0_coverage::judge_outside_v2(0xE1, &w.txs[0].ixs[0].data, pv, false),
            Some((Severity::Unverifiable, _, _))
        ));
    }

    #[test]
    fn forged_joins_fail() {
        // A forged record key (not the asset's resident ID).
        let (mut w, logs) = honest();
        w.cq_recs[0].key = vec![9; 15];
        assert!(fails(&judge(&w, &logs)), "forged key");
        // The Citizen, Season or Frontier account not this Season's.
        for pos in [CITIZEN, SEASON, FRONTIER] {
            let (mut w, logs) = honest();
            w.txs[0].ixs[0].accounts[pos].0 = [0x66; 32];
            let f = judge(&w, &logs);
            assert!(
                f.contains(&(Severity::Fail, NON_CANONICAL_ADDRESS)),
                "{pos}"
            );
        }
        // A record in a transaction that ran no JoinResident (⑳'s V9).
        let (mut w, logs) = honest();
        w.txs[0].ixs.clear();
        assert!(fails(&judge(&w, &logs)), "record without its join");
        // The link binds another Citizen.
        let (mut w, logs) = honest();
        w.txs[0].post.insert(LINK_ACC, acc(link_data([0x55; 32])));
        assert!(fails(&judge(&w, &logs)), "link");
    }

    #[test]
    fn missing_evidence_is_never_a_pass() {
        // No record, whole logs: the program always writes one.
        let (mut w, logs) = honest();
        w.cq_recs.clear();
        assert_eq!(
            judge(&w, &logs),
            vec![(Severity::Fail, RESIDENT_JOIN_MISMATCH)]
        );
        // No record and logs cut or absent: V0E's (UNVERIFIABLE), not V27's.
        for cut in [
            vec![],
            vec![logs[0].clone()],
            vec![logs[0].clone(), "Log truncated".into()],
        ] {
            assert_eq!(judge(&w, &cut), vec![], "{cut:?}");
        }
        // The Citizen's or the link's post-state absent.
        for k in [citizen_addr(), LINK_ACC] {
            let (mut w, logs) = honest();
            w.txs[0].post.remove(&k);
            assert_eq!(
                judge(&w, &logs),
                vec![(Severity::Unverifiable, MISSING_POST_STATE)]
            );
        }
    }

    #[test]
    fn mismatches_fail() {
        type Edit = fn(&mut World);
        let cases: Vec<(&str, Edit)> = vec![
            ("generation", |w| w.txs[0].ixs[0].data[1] ^= 1),
            ("faction", |w| w.txs[0].ixs[0].data[5] = 1),
            ("NFT", |w| {
                w.txs[0].ixs[0].accounts[super::ASSET].0 = [0x5b; 32]
            }),
            ("shard", |w| w.cq_recs[0].payload[33] ^= 1),
            ("time", |w| w.txs[0].time += 600),
            ("join close", |w| {
                w.txs[0].time += 2_000 * 600;
                w.cq_recs[0].bell += 2_000;
                let jb = w.cq_recs[0].bell.to_le_bytes();
                w.cq_recs[0].payload[38..42].copy_from_slice(&jb);
            }),
            ("Citizen faction", |w| {
                let k = citizen_addr();
                if let Some(Some(a)) = w.txs[0].post.get_mut(&k) {
                    a.data[C::FACTION] = 1;
                }
            }),
            ("Citizen asset", |w| {
                let k = citizen_addr();
                if let Some(Some(a)) = w.txs[0].post.get_mut(&k) {
                    a.data[frontier_abi::resident_citizen::RESIDENT_ASSET] ^= 1;
                }
            }),
            ("Citizen wallet", |w| {
                let k = citizen_addr();
                if let Some(Some(a)) = w.txs[0].post.get_mut(&k) {
                    a.data[C::WALLET] = 1;
                }
            }),
            ("Citizen join bell", |w| {
                let k = citizen_addr();
                if let Some(Some(a)) = w.txs[0].post.get_mut(&k) {
                    a.data[C::JOIN_BELL] ^= 1;
                }
            }),
            ("faction out of range", |w| {
                w.txs[0].ixs[0].data[5] = 6;
                w.cq_recs[0].payload[32] = 6;
            }),
        ];
        for (what, edit) in cases {
            let (mut w, logs) = honest();
            edit(&mut w);
            assert!(fails(&judge(&w, &logs)), "{what}: {:?}", judge(&w, &logs));
        }
    }

    #[test]
    fn duplicates_fail() {
        // Two records for one join in one transaction.
        let (mut w, logs) = honest();
        let again = w.cq_recs[0].clone();
        w.cq_recs.push(again);
        assert!(fails(&judge(&w, &logs)));
        // A second join of the same NFT in the Season (one per world): ⑳'s
        // V9 fails the second record.
        let (mut w, logs) = honest();
        let mut tx1 = w.txs[0].clone();
        tx1.time += 600;
        // Its Citizen as a join at that bell would write it, so only the
        // duplicate is wrong.
        if let Some(Some(a)) = tx1.post.get_mut(&citizen_addr()) {
            a.data[C::JOIN_BELL..C::JOIN_BELL + 4].copy_from_slice(&(BELL + 1).to_le_bytes());
        }
        w.txs.push(tx1);
        let mut r1 = w.cq_recs[0].clone();
        r1.tx = 1;
        r1.bell += 1;
        let jb = r1.bell.to_le_bytes();
        r1.payload[38..42].copy_from_slice(&jb);
        w.cq_recs.push(r1);
        let v9 = crate::checks::v9_addresses::resident_joined_findings(&w);
        assert_eq!(v9.len(), 1);
        assert!(v9[0].1.contains("second"));
        assert!(judge_tx(&w, &jc(), 1, &w.txs[1], &logs).is_empty());
    }
}
