//! The caravan feed (S1 stage 1b): caravans are public objects (plan
//! §1-7; contract §3.5), so the herald publishes the ones on the road and
//! the vaults, for the map and for anyone planning an escort or a raid.
//!
//! `h/caravans.json` (live, rewritten when a record changes it):
//!
//! ```json
//! {"v": 1, "moving": [{"ownerTag": "…", "seq": 0, "faction": 1,
//!   "src": {"kind": 1, "p": 3, "q": 0, "at": 2, "gen": 1, "tile": 20},
//!   "dst": {…}, "steps": 7, "cargo": [0, 100, …], "arriveTs": 1790000000,
//!   "runs": [{"p": 3, "q": 0, "firstBell": 290, "n": 2}], "raided": false}],
//!  "vaults": [{"p": 3, "q": 0, "tile": 40, "ownerTag": "…", "faction": 1,
//!   "gen": 1}]}
//! ```
//!
//! Tags are decimal strings (u64). A caravan leaves `moving` with its
//! CARAVAN_SETTLED. A raid that burns empties it (`raided`, cargo 0; it goes
//! on); one that takes (decision J2) makes it the raider's, and the same
//! transaction's CARAVAN_SENT (origin kind 3, the raid tile) replaces its
//! entry with the raider's route. A vault's owner and generation follow VAULT_SEIZED; a closed
//! vault is not logged by kind (its CLOSE), so it stays listed until the
//! herald reads it absent (not done yet: a closed vault is rare and empty).

use std::collections::BTreeMap;

use fclient::conquest::{CqEvent, LogPlace};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Caravans {
    /// `(owner_tag, seq)` → the caravan's entry.
    pub moving: BTreeMap<(u64, u32), Value>,
    /// `(p, q, tile)` → the vault's entry.
    pub vaults: BTreeMap<(i32, i32, u8), Value>,
    /// Changed since the file was last written.
    pub dirty: bool,
}

fn place(p: &LogPlace) -> Value {
    json!({"kind": p.kind, "p": p.p, "q": p.q, "at": p.at, "gen": p.gen, "tile": p.tile})
}

impl Caravans {
    /// Folds one S1 record; `false` for any other.
    pub fn fold(&mut self, ev: &CqEvent) -> bool {
        match ev {
            CqEvent::CaravanSent {
                owner_tag,
                seq,
                faction,
                src,
                dst,
                steps,
                cargo,
                arrive_ts,
                runs,
                ..
            } => {
                let runs: Vec<Value> = runs
                    .iter()
                    .map(|r| json!({"p": r.p, "q": r.q, "firstBell": r.first_bell, "n": r.n}))
                    .collect();
                self.moving.insert(
                    (*owner_tag, *seq),
                    json!({"ownerTag": owner_tag.to_string(), "seq": seq, "faction": faction,
                        "src": place(src), "dst": place(dst), "steps": steps, "cargo": cargo,
                        "arriveTs": arrive_ts, "runs": runs, "raided": false}),
                );
            }
            CqEvent::CaravanSettled { owner_tag, seq, .. } => {
                self.moving.remove(&(*owner_tag, *seq));
            }
            CqEvent::CaravanRaided {
                owner_tag,
                seq,
                choice,
                ..
            } => {
                if let Some(m) = self.moving.get_mut(&(*owner_tag, *seq)) {
                    m["raided"] = json!(true);
                    if *choice == frontier_abi::v2::log::raid_choice::BURN {
                        m["cargo"] = json!([0u32; 8].to_vec());
                    }
                }
            }
            CqEvent::VaultBuilt {
                p,
                q,
                tile,
                owner_tag,
                faction,
                gen,
                ..
            } => {
                self.vaults.insert(
                    (*p, *q, *tile),
                    json!({"p": p, "q": q, "tile": tile, "ownerTag": owner_tag.to_string(),
                        "faction": faction, "gen": gen}),
                );
            }
            CqEvent::VaultSeized {
                p,
                q,
                tile,
                captor_tag,
                new_gen,
                ..
            } => {
                if let Some(v) = self.vaults.get_mut(&(*p, *q, *tile)) {
                    v["ownerTag"] = json!(captor_tag.to_string());
                    v["gen"] = json!(new_gen);
                }
            }
            _ => return false,
        }
        self.dirty = true;
        true
    }

    /// `h/caravans.json`.
    pub fn file(&self) -> Value {
        json!({
            "v": 1,
            "moving": self.moving.values().collect::<Vec<_>>(),
            "vaults": self.vaults.values().collect::<Vec<_>>(),
        })
    }

    /// The checkpoint form (the file's plus the keys).
    pub fn to_json(&self) -> Value {
        self.file()
    }

    /// The inverse of [`Caravans::to_json`] (`None` when damaged).
    pub fn from_json(v: &Value) -> Option<Caravans> {
        let mut c = Caravans::default();
        for m in v.get("moving")?.as_array()? {
            let tag = m["ownerTag"].as_str()?.parse().ok()?;
            let seq = m["seq"].as_u64()? as u32;
            c.moving.insert((tag, seq), m.clone());
        }
        for x in v.get("vaults")?.as_array()? {
            let key = (
                x["p"].as_i64()? as i32,
                x["q"].as_i64()? as i32,
                x["tile"].as_u64()? as u8,
            );
            c.vaults.insert(key, x.clone());
        }
        Some(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fclient::conquest::LogRun;

    fn here(kind: u8) -> LogPlace {
        LogPlace {
            kind,
            p: 3,
            q: 0,
            at: 2,
            gen: 1,
            tile: 20,
        }
    }

    /// A caravan is listed from its send to its settlement; a raid marks it
    /// and takes from its cargo; vaults follow their seizures; the
    /// checkpoint round-trips.
    #[test]
    fn caravans_and_vaults_follow_their_records() {
        let mut c = Caravans::default();
        assert!(c.fold(&CqEvent::CaravanSent {
            owner_tag: 77,
            seq: 0,
            faction: 1,
            src: here(1),
            dst: here(2),
            steps: 4,
            cargo: [0, 100, 0, 0, 0, 50, 0, 0],
            arrive_ts: 1_790_000_000,
            runs: vec![LogRun {
                p: 3,
                q: 0,
                first_bell: 290,
                n: 2,
            }],
            worn_bps: 0,
            path: [0; 12],
        }));
        assert!(c.fold(&CqEvent::VaultBuilt {
            p: 3,
            q: 0,
            tile: 40,
            owner_tag: 77,
            faction: 1,
            gen: 1,
            holding_key: 0,
        }));
        c.fold(&CqEvent::CaravanRaided {
            owner_tag: 77,
            seq: 0,
            p: 3,
            q: 0,
            bell: 290,
            choice: frontier_abi::v2::log::raid_choice::BURN,
            by: 0,
            raider_tag: 9,
            taken: [0, 100, 0, 0, 0, 50, 0, 0],
            dst: here(0),
            cleared: vec![],
            domestic: false,
        });
        let f = c.file();
        assert_eq!(f["moving"][0]["raided"], json!(true));
        assert_eq!(f["moving"][0]["cargo"][1], json!(0), "burned");
        assert_eq!(f["moving"][0]["runs"][0]["firstBell"], json!(290));
        c.fold(&CqEvent::VaultSeized {
            p: 3,
            q: 0,
            tile: 40,
            captor_tag: 9,
            prev_tag: 77,
            new_gen: 2,
            domestic: false,
            host_id: 0,
        });
        assert_eq!(c.file()["vaults"][0]["ownerTag"], json!("9"));
        assert_eq!(Caravans::from_json(&c.to_json()).unwrap().file(), c.file());
        c.fold(&CqEvent::CaravanSettled {
            owner_tag: 77,
            seq: 0,
            outcome: 1,
            dst: here(2),
            cargo: [0; 8],
            fee: 0,
        });
        assert!(c.moving.is_empty());
    }
}
