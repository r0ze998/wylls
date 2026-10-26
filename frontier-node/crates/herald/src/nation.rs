//! The nations feed (S1 stage 1e, `S1-1E-CONTRACT.md` §3 and §7): each
//! nation's stances, its proposals and their tallies, and the expelled
//! villages, folded from NATION_PROPOSED, NATION_VOTED and NATION_DECIDED,
//! and the domestic raids (RAID_OPENED, decision K4).
//!
//! `h/nations.json` (live, rewritten when a record changes it):
//!
//! ```json
//! {"v": 1,
//!  "stances": [[0, 0, 0, 1, 0, 0], …],
//!  "proposals": [{"faction": 0, "id": 3, "slot": 1, "kind": "expel",
//!    "targetFaction": 0, "value": 0, "proposerTag": "…", "targetTag": "…",
//!    "openBell": 300, "closeBell": 444, "yes": 3, "no": 1, "state": "open"}],
//!  "expelled": [{"tag": "…", "faction": 0, "since": 445}],
//!  "domesticRaids": [{"ownerTag": "…", "seq": 0, "p": 3, "q": 0, "bell": 450,
//!    "raiderHost": "…", "raiderTag": "…"}]}
//! ```
//!
//! `stances[n][f]` is nation `n`'s stance toward faction `f`
//! (`structure::STANCE_*`: 0 war, 1 pass, 2 ally; a fresh season is all
//! war). Open proposals are all kept, decided ones the newest
//! [`DECIDED_MAX`]. `openBell` is the bell its NATION_PROPOSED was logged
//! at.

use std::collections::BTreeMap;

use fclient::conquest::CqEvent;
use permutation_rules::frontier::nation::{KIND_EXPEL, KIND_READMIT, KIND_STANCE};
use permutation_rules::frontier::structure::NATIONS;
use serde_json::{json, Value};

/// Decided proposals kept in the feed.
pub const DECIDED_MAX: usize = 64;
/// Domestic raids kept in the feed (the newest).
pub const RAIDS_MAX: usize = 64;

/// A domestic raid as RAID_OPENED logged it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DomesticRaid {
    pub owner_tag: u64,
    pub seq: u32,
    pub p: i32,
    pub q: i32,
    pub bell: u32,
    pub raider_host: u64,
    pub raider_tag: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Prop {
    pub slot: u8,
    pub kind: u8,
    pub target_faction: u8,
    pub value: u8,
    pub proposer_tag: u64,
    pub target_tag: u64,
    pub open_bell: u32,
    pub close_bell: u32,
    pub yes: u16,
    pub no: u16,
    /// `nation::STATE_*` (1 open, 2 passed, 3 failed).
    pub state: u8,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Nations {
    pub stances: [[u8; NATIONS]; NATIONS],
    /// `(faction, id)` → the proposal.
    pub proposals: BTreeMap<(u8, u32), Prop>,
    /// The expelled villages' tags → `(faction, since bell)`.
    pub expelled: BTreeMap<u64, (u8, u32)>,
    /// The expelled villages' tags → their holdings `(p, q, site)` as the
    /// expulsion's NATION_DECIDED named them.
    pub expelled_holdings: BTreeMap<u64, Vec<(i32, i32, u8)>>,
    /// The newest domestic raids, oldest first.
    pub raids: std::collections::VecDeque<DomesticRaid>,
    /// Changed since the file was last written.
    pub dirty: bool,
}

fn kind_name(k: u8) -> &'static str {
    match k {
        KIND_STANCE => "stance",
        KIND_EXPEL => "expel",
        KIND_READMIT => "readmit",
        _ => "unknown",
    }
}

fn kind_of(s: &str) -> Option<u8> {
    match s {
        "stance" => Some(KIND_STANCE),
        "expel" => Some(KIND_EXPEL),
        "readmit" => Some(KIND_READMIT),
        _ => None,
    }
}

fn state_name(s: u8) -> &'static str {
    match s {
        2 => "passed",
        3 => "failed",
        _ => "open",
    }
}

fn state_of(s: &str) -> u8 {
    match s {
        "passed" => 2,
        "failed" => 3,
        _ => 1,
    }
}

impl Nations {
    /// Folds a nation record logged at `bell`; `false` for any other.
    pub fn fold(&mut self, bell: u32, ev: &CqEvent) -> bool {
        match *ev {
            CqEvent::NationProposed {
                faction,
                id,
                slot,
                kind,
                target_faction,
                value,
                proposer_tag,
                target_tag,
                close_bell,
            } => {
                self.proposals.insert(
                    (faction, id),
                    Prop {
                        slot,
                        kind,
                        target_faction,
                        value,
                        proposer_tag,
                        target_tag,
                        open_bell: bell,
                        close_bell,
                        yes: 0,
                        no: 0,
                        state: 1,
                    },
                );
            }
            CqEvent::NationVoted {
                faction,
                id,
                yes_now,
                no_now,
                ..
            } => {
                if let Some(p) = self.proposals.get_mut(&(faction, id)) {
                    p.yes = yes_now;
                    p.no = no_now;
                }
            }
            CqEvent::NationDecided {
                faction,
                id,
                passed,
                kind,
                target_faction,
                value,
                target_tag,
                yes,
                no,
                holdings,
            } => {
                if let Some(p) = self.proposals.get_mut(&(faction, id)) {
                    p.state = if passed { 2 } else { 3 };
                    p.yes = yes;
                    p.no = no;
                }
                if passed {
                    match kind {
                        KIND_STANCE => {
                            if let Some(row) = self.stances.get_mut(faction as usize) {
                                if let Some(c) = row.get_mut(target_faction as usize) {
                                    *c = value;
                                }
                            }
                        }
                        KIND_EXPEL => {
                            self.expelled.insert(target_tag, (faction, bell));
                            // the expelled village's holdings (host-id keys): a readmission
                            // proposal names the village's Citizen, read from one of them
                            let hs: Vec<(i32, i32, u8)> = holdings
                                .iter()
                                .filter(|&&k| k != 0)
                                .filter_map(|&k| frontier_abi::addr::split_host_id(k))
                                .map(|x| (x.province.p, x.province.q, x.site))
                                .collect();
                            self.expelled_holdings.insert(target_tag, hs);
                        }
                        KIND_READMIT => {
                            self.expelled.remove(&target_tag);
                            self.expelled_holdings.remove(&target_tag);
                        }
                        _ => {}
                    }
                }
                self.prune();
            }
            CqEvent::RaidOpened {
                owner_tag,
                seq,
                p,
                q,
                bell,
                raider_host,
                raider_tag,
                domestic: true,
            } => {
                self.raids.push_back(DomesticRaid {
                    owner_tag,
                    seq,
                    p,
                    q,
                    bell,
                    raider_host,
                    raider_tag,
                });
                while self.raids.len() > RAIDS_MAX {
                    self.raids.pop_front();
                }
            }
            _ => return false,
        }
        self.dirty = true;
        true
    }

    /// Keeps every open proposal and the newest decided ones.
    fn prune(&mut self) {
        let decided: Vec<(u8, u32)> = self
            .proposals
            .iter()
            .filter(|(_, p)| p.state != 1)
            .map(|(k, p)| (p.open_bell, *k))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|(_, k)| k)
            .collect();
        if decided.len() > DECIDED_MAX {
            for k in &decided[..decided.len() - DECIDED_MAX] {
                self.proposals.remove(k);
            }
        }
    }

    pub fn file(&self) -> Value {
        let proposals: Vec<Value> = self
            .proposals
            .iter()
            .map(|((f, id), p)| {
                json!({"faction": f, "id": id, "slot": p.slot, "kind": kind_name(p.kind),
                    "targetFaction": p.target_faction, "value": p.value,
                    "proposerTag": p.proposer_tag.to_string(), "targetTag": p.target_tag.to_string(),
                    "openBell": p.open_bell, "closeBell": p.close_bell, "yes": p.yes, "no": p.no,
                    "state": state_name(p.state)})
            })
            .collect();
        let expelled: Vec<Value> = self
            .expelled
            .iter()
            .map(|(t, (f, since))| {
                let hs: Vec<Value> = self
                    .expelled_holdings
                    .get(t)
                    .into_iter()
                    .flatten()
                    .map(|(p, q, s)| json!([p, q, s]))
                    .collect();
                json!({"tag": t.to_string(), "faction": f, "since": since, "holdings": hs})
            })
            .collect();
        let raids: Vec<Value> = self
            .raids
            .iter()
            .map(|r| {
                json!({"ownerTag": r.owner_tag.to_string(), "seq": r.seq, "p": r.p, "q": r.q,
                    "bell": r.bell, "raiderHost": r.raider_host.to_string(),
                    "raiderTag": r.raider_tag.to_string()})
            })
            .collect();
        json!({"v": 1, "stances": self.stances, "proposals": proposals, "expelled": expelled,
            "domesticRaids": raids})
    }

    pub fn to_json(&self) -> Value {
        self.file()
    }

    /// The inverse of [`Nations::to_json`] (`None` when damaged).
    pub fn from_json(v: &Value) -> Option<Nations> {
        let mut n = Nations::default();
        for (i, row) in v.get("stances")?.as_array()?.iter().enumerate() {
            for (j, c) in row.as_array()?.iter().enumerate() {
                *n.stances.get_mut(i)?.get_mut(j)? = c.as_u64()? as u8;
            }
        }
        for x in v.get("proposals")?.as_array()? {
            n.proposals.insert(
                (x["faction"].as_u64()? as u8, x["id"].as_u64()? as u32),
                Prop {
                    slot: x["slot"].as_u64()? as u8,
                    kind: kind_of(x["kind"].as_str()?)?,
                    target_faction: x["targetFaction"].as_u64()? as u8,
                    value: x["value"].as_u64()? as u8,
                    proposer_tag: x["proposerTag"].as_str()?.parse().ok()?,
                    target_tag: x["targetTag"].as_str()?.parse().ok()?,
                    open_bell: x["openBell"].as_u64()? as u32,
                    close_bell: x["closeBell"].as_u64()? as u32,
                    yes: x["yes"].as_u64()? as u16,
                    no: x["no"].as_u64()? as u16,
                    state: state_of(x["state"].as_str()?),
                },
            );
        }
        for x in v.get("expelled")?.as_array()? {
            let tag: u64 = x["tag"].as_str()?.parse().ok()?;
            n.expelled.insert(
                tag,
                (x["faction"].as_u64()? as u8, x["since"].as_u64()? as u32),
            );
            // Absent in a checkpoint written before the readmission panel.
            if let Some(hs) = x.get("holdings").and_then(|h| h.as_array()) {
                let mut out = vec![];
                for h in hs {
                    let h = h.as_array()?;
                    out.push((
                        h.first()?.as_i64()? as i32,
                        h.get(1)?.as_i64()? as i32,
                        h.get(2)?.as_u64()? as u8,
                    ));
                }
                n.expelled_holdings.insert(tag, out);
            }
        }
        // Absent in a checkpoint written before the domestic raids.
        for x in v
            .get("domesticRaids")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
        {
            n.raids.push_back(DomesticRaid {
                owner_tag: x["ownerTag"].as_str()?.parse().ok()?,
                seq: x["seq"].as_u64()? as u32,
                p: x["p"].as_i64()? as i32,
                q: x["q"].as_i64()? as i32,
                bell: x["bell"].as_u64()? as u32,
                raider_host: x["raiderHost"].as_str()?.parse().ok()?,
                raider_tag: x["raiderTag"].as_str()?.parse().ok()?,
            });
        }
        Some(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_a_stance_and_an_expulsion_and_round_trips() {
        let mut n = Nations::default();
        let proposed = |id, kind, tf, value, target_tag| CqEvent::NationProposed {
            faction: 0,
            id,
            slot: 0,
            kind,
            target_faction: tf,
            value,
            proposer_tag: 7,
            target_tag,
            close_bell: 444,
        };
        assert!(n.fold(300, &proposed(1, KIND_STANCE, 3, 1, 0)));
        assert!(n.fold(
            301,
            &CqEvent::NationVoted {
                faction: 0,
                id: 1,
                voter_tag: 8,
                yes: true,
                yes_now: 1,
                no_now: 0,
            }
        ));
        assert_eq!(n.proposals[&(0, 1)].yes, 1);
        let decided = |id, kind, tf, value, target_tag| CqEvent::NationDecided {
            faction: 0,
            id,
            passed: true,
            kind,
            target_faction: tf,
            value,
            target_tag,
            yes: 3,
            no: 0,
            holdings: [0; 3],
        };
        n.fold(445, &decided(1, KIND_STANCE, 3, 1, 0));
        assert_eq!(n.stances[0][3], 1);
        assert_eq!(n.proposals[&(0, 1)].state, 2);
        n.fold(446, &proposed(2, KIND_EXPEL, 0, 0, 99));
        // the expelled village's holdings come with the expulsion (a readmission names its Citizen from one)
        let key = frontier_abi::addr::host_id(3, -1, 4, 1, 0).unwrap();
        let mut expel = decided(2, KIND_EXPEL, 0, 0, 99);
        if let CqEvent::NationDecided { holdings, .. } = &mut expel {
            *holdings = [key, 0, 0];
        }
        n.fold(600, &expel);
        assert_eq!(n.expelled[&99], (0, 600));
        assert_eq!(n.expelled_holdings[&99], vec![(3, -1, 4)]);
        assert_eq!(n.file()["expelled"][0]["holdings"], json!([[3, -1, 4]]));
        let back = Nations::from_json(&n.to_json()).expect("round trip");
        assert_eq!(back.stances, n.stances);
        assert_eq!(back.proposals, n.proposals);
        assert_eq!(back.expelled, n.expelled);
        assert_eq!(back.expelled_holdings, n.expelled_holdings);
        // A domestic raid is listed (and survives the round trip).
        assert!(n.fold(
            700,
            &CqEvent::RaidOpened {
                owner_tag: 5,
                seq: 2,
                p: -1,
                q: 3,
                bell: 699,
                raider_host: 1 << 40,
                raider_tag: 8,
                domestic: true,
            }
        ));
        assert_eq!(n.raids.len(), 1);
        assert_eq!(Nations::from_json(&n.to_json()).unwrap().raids, n.raids);
        n.fold(1_100, &decided(3, KIND_READMIT, 0, 0, 99));
        assert!(n.expelled.is_empty());
        // Other records are not the feed's.
        assert!(!n.fold(
            1,
            &CqEvent::Retire {
                host_id: 1,
                troops: 0,
                home_key: 0,
                by: 0
            }
        ));
    }
}
