//! The keeper's nation duty (S1 stage 1e, `S1-1E-CONTRACT.md` §3.3, §7).
//!
//! | duty | trigger | write | class | role |
//! |---|---|---|---|---|
//! | Settlements | an open proposal at or past its `close_bell` | SettleProposal | D | `settle` |
//!
//! **What it knows.** Each plan reads the six Nation accounts (absent ones
//! have no proposals) and, for a closed expulsion or readmission, its
//! target Citizen: a proposal that passes and still applies lists the
//! target's live holdings in its reference order (the program flags
//! them); every other settlement lists none. Nothing is cached across
//! plans but the keys already landed; a write the program refuses is
//! retried by the engine or planned again after [`NATION_RETRY_SLOTS`].

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fclient::abi::{tag, Class};
use fclient::ix::v2 as ix2;
use fclient::ix::HoldingRef;
use fclient::ports::{ChainPort, PortResult};
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_abi::v2::layout::s1::nation as NA;
use permutation_rules::frontier::nation::{self as kn, Proposal, KIND_EXPEL, KIND_READMIT};
use permutation_rules::frontier::structure::NATIONS;
use solana_address::Address;

use crate::engine::{Engine, Outcome, WriteSpec};
use crate::Tick;

/// Slots between two plans of a settlement that did not land.
pub const NATION_RETRY_SLOTS: u64 = 8;
/// The keys this duty writes.
pub const KINDS: [&str; 1] = ["nsettle"];

#[derive(Clone, Debug, Default)]
pub struct NationStats {
    pub settles_planned: u64,
    pub settles_landed: u64,
}

#[derive(Default)]
pub struct NationDuty {
    pub stats: NationStats,
    done: BTreeSet<String>,
    tried: BTreeMap<String, u64>,
}

/// The closed, still open proposals of a Nation's bytes: `(slot, proposal)`.
pub fn due(nd: &[u8], now_bell: u32) -> Vec<(u8, Proposal)> {
    (0..NA::N)
        .filter_map(|i| {
            let q = Proposal::decode(nd.get(NA::at(i)..)?)?;
            q.settles_at(now_bell).then_some((i as u8, q))
        })
        .collect()
}

/// The holdings a settlement of `q` lists, from its target Citizen's
/// bytes (`faction` the Nation's): the live ones when it passes and still
/// applies, none otherwise.
pub fn holdings_of(q: &Proposal, faction: u8, cd: &[u8]) -> Vec<HoldingRef> {
    let membership = q.kind == KIND_EXPEL || q.kind == KIND_READMIT;
    if !membership || !kn::passes(q.yes, q.no) {
        return vec![];
    }
    let since = cd
        .get(C2::EXPELLED_SINCE..C2::EXPELLED_SINCE + 8)
        .map(|b| i64::from_le_bytes(b.try_into().unwrap()));
    let applies = cd.get(C2::FACTION) == Some(&faction)
        && since.is_some_and(|s| (s == 0) == (q.kind == KIND_EXPEL));
    if !applies {
        return vec![];
    }
    (1..=3u8)
        .filter_map(|slot| {
            let o = C2::holding_of_slot(slot);
            let b = cd.get(o..o + 6)?;
            (b[5] != C2::EMPTY_GEN).then(|| HoldingRef {
                p: i16::from_le_bytes([b[0], b[1]]),
                q: i16::from_le_bytes([b[2], b[3]]),
                site: b[4],
            })
        })
        .collect()
}

impl NationDuty {
    /// Routes the engine's outcome of a nation write; `false`: not ours.
    pub fn on_outcome(&mut self, key: &str, o: &Outcome) -> bool {
        if !KINDS.contains(&key.split(':').next().unwrap_or("")) {
            return false;
        }
        if let Outcome::Landed { .. } = o {
            self.done.insert(key.to_string());
            self.stats.settles_landed += 1;
        }
        true
    }

    fn backoff(&mut self, key: &str, slot: u64) -> bool {
        if self
            .tried
            .get(key)
            .is_some_and(|&s| slot < s + NATION_RETRY_SLOTS)
        {
            return true;
        }
        self.tried.insert(key.to_string(), slot);
        false
    }

    /// Plans the settlements of every closed proposal.
    pub async fn plan<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        now_bell: u32,
    ) -> PortResult<()> {
        if t.season.program_version < fclient::abi::PROGRAM_VERSION_S1 || !t.cfg.has_role("settle")
        {
            return Ok(());
        }
        let keys: Vec<Address> = (0..NATIONS as u8).map(|f| t.addrs.nation(f)).collect();
        let got = port.accounts(&keys, 0).await?;
        let program = t.addrs.program;
        for (f, acc) in got.into_iter().enumerate() {
            let Some(nd) = acc
                .filter(|a| a.owner == program && a.data.len() == NA::SIZE)
                .map(|a| a.data)
            else {
                continue;
            };
            let faction = f as u8;
            for (slot, q) in due(&nd, now_bell) {
                let key = format!("nsettle:{faction}:{}", q.id);
                if self.done.contains(&key) || engine.is_pending(&key) || self.backoff(&key, t.slot)
                {
                    continue;
                }
                let (target, holdings) = if q.kind == KIND_EXPEL || q.kind == KIND_READMIT {
                    let target = Address::new_from_array(q.target);
                    let got = port.accounts(&[target], 0).await?;
                    let Some(cd) = got
                        .into_iter()
                        .next()
                        .flatten()
                        .filter(|a| a.owner == program && a.data.len() == C2::SIZE)
                        .map(|a| a.data)
                    else {
                        continue;
                    };
                    (Some(target), holdings_of(&q, faction, &cd))
                } else {
                    (None, vec![])
                };
                let (a, id) = (t.addrs.clone(), q.id);
                if engine.ensure(
                    WriteSpec {
                        key,
                        kind: "nsettle",
                        tag: tag::SETTLE_PROPOSAL,
                        class: Class::D,
                        bell: None,
                        region: None,
                        build: Arc::new(move |c: &crate::engine::BuildCtx| {
                            vec![ix2::settle_proposal(
                                &a, c.payer, faction, slot, id, target, &holdings,
                            )]
                        }),
                        deadline_slot: None,
                        not_before_slot: t.slot,
                        fixed_payer: None,
                    },
                    t.slot,
                ) {
                    self.stats.settles_planned += 1;
                }
            }
        }
        Ok(())
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "settlesPlanned": self.stats.settles_planned,
            "settlesLanded": self.stats.settles_landed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use permutation_rules::frontier::nation::{KIND_STANCE, STATE_OPEN};

    #[test]
    fn due_proposals_and_their_holdings() {
        let mut nd = vec![0u8; NA::SIZE];
        let q = Proposal {
            id: 5,
            state: STATE_OPEN,
            kind: KIND_EXPEL,
            close_bell: 444,
            yes: 3,
            no: 0,
            ..Default::default()
        };
        q.encode(&mut nd[NA::at(2)..]).unwrap();
        assert!(due(&nd, 443).is_empty());
        assert_eq!(due(&nd, 444), vec![(2, q)]);
        let mut cd = vec![0u8; C2::SIZE];
        for slot in 1..=3u8 {
            let o = C2::holding_of_slot(slot);
            cd[o..o + 2].copy_from_slice(&(slot as i16).to_le_bytes());
            cd[o + 4] = slot;
            cd[o + 5] = if slot == 2 { C2::EMPTY_GEN } else { 1 };
        }
        let hs = holdings_of(&q, 0, &cd);
        assert_eq!(hs.iter().map(|h| h.site).collect::<Vec<_>>(), vec![1, 3]);
        // Already expelled: the expulsion no longer applies.
        cd[C2::EXPELLED_SINCE..C2::EXPELLED_SINCE + 8].copy_from_slice(&7i64.to_le_bytes());
        assert!(holdings_of(&q, 0, &cd).is_empty());
        // A stance, or a failed proposal, lists none.
        let stance = Proposal {
            kind: KIND_STANCE,
            ..q
        };
        assert!(holdings_of(&stance, 0, &cd).is_empty());
    }
}
