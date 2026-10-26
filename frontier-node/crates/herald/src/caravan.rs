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
//!   "runs": [{"p": 3, "q": 0, "firstBell": 290, "n": 2}], "raided": false,
//!   "path": [12 bytes], "provinces": [[3, 0], [4, 0]]}],
//!  "vaults": [{"p": 3, "q": 0, "tile": 40, "ownerTag": "…", "faction": 1,
//!   "gen": 1}]}
//! ```
//!
//! Tags are decimal strings (u64). `path` is the packed walk (`steps` of it
//! used) and `provinces` the Provinces it enters, in order, the origin's
//! first (the Caravan's `PROVINCES`). A caravan leaves `moving` with its
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
                path,
                ..
            } => {
                // The route's Provinces in first-entered order (the origin's
                // first): the Caravan's `PROVINCES`, which a raid's take names.
                let mut provinces: Vec<(i32, i32)> = vec![(src.p as i32, src.q as i32)];
                for (p, q, _) in crate::structure::walk_tiles(
                    (src.p as i32, src.q as i32, src.tile),
                    path,
                    *steps,
                ) {
                    if !provinces.contains(&(p, q)) {
                        provinces.push((p, q));
                    }
                }
                let provinces: Vec<Value> = provinces.iter().map(|(p, q)| json!([p, q])).collect();
                let runs: Vec<Value> = runs
                    .iter()
                    .map(|r| json!({"p": r.p, "q": r.q, "firstBell": r.first_bell, "n": r.n}))
                    .collect();
                self.moving.insert(
                    (*owner_tag, *seq),
                    json!({"ownerTag": owner_tag.to_string(), "seq": seq, "faction": faction,
                        "src": place(src), "dst": place(dst), "steps": steps, "cargo": cargo,
                        "arriveTs": arrive_ts, "runs": runs, "raided": false,
                        "path": path.to_vec(), "provinces": provinces}),
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

    /// A Vault's post-transaction bytes (the local node's feed): its stores
    /// and cap, in whole units, on its entry (`stores`, `cap`), so its owner
    /// can send a caravan from it and anyone can see what a seizure would
    /// take (a vault is public, like a caravan). A Vault the transaction
    /// closed (`None` bytes at a listed vault's address) leaves the list.
    /// `false` when nothing changed.
    pub fn vault_bytes(&mut self, key: Option<(i32, i32, u8)>, data: Option<&[u8]>) -> bool {
        use frontier_abi::v2::layout::s1::vault as VA;
        let rd = |d: &[u8], o: usize| -> Option<i64> {
            Some(i64::from_le_bytes(d.get(o..o + 8)?.try_into().ok()?))
        };
        let Some(d) = data else {
            return key.is_some_and(|k| self.vaults.remove(&k).is_some());
        };
        if d.get(..8) != Some(&VA::MAGIC[..]) {
            return false;
        }
        let at = |o: usize| {
            d.get(o..o + 2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as i32)
        };
        let (Some(p), Some(q), Some(&tile), Some(&state)) =
            (at(VA::P), at(VA::Q), d.get(VA::TILE), d.get(VA::STATE))
        else {
            return false;
        };
        if state != VA::STATE_LIVE {
            return self.vaults.remove(&(p, q, tile)).is_some();
        }
        let units = |m: i64| (m.max(0) / 1_000).min(u32::MAX as i64);
        let stores: Vec<i64> = (0..8)
            .map(|r| rd(d, VA::store(r)).map_or(0, units))
            .collect();
        let cap = rd(d, VA::CAP).map_or(0, units);
        // the owner's Citizen address: a seizure names it (SeizeVault's `owner_citizen`)
        let owner = d
            .get(VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32)
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .map(|b| fclient::Address::new_from_array(b).to_string());
        // and its faction: VAULT_SEIZED names the captor's tag but not its faction
        let faction = d.get(VA::FACTION).copied();
        let Some(v) = self.vaults.get_mut(&(p, q, tile)) else {
            return false;
        };
        let mut new = json!({"stores": stores, "cap": cap, "ownerCitizen": owner});
        if let Some(f) = faction {
            new["faction"] = json!(f);
        }
        if ["stores", "cap", "ownerCitizen", "faction"]
            .iter()
            .all(|k| new.get(*k).is_none() || v.get(*k) == new.get(*k))
        {
            return false;
        }
        for k in ["stores", "cap", "ownerCitizen", "faction"] {
            if let Some(x) = new.get(k) {
                v[k] = x.clone();
            }
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

    /// A caravan's route names the Provinces its walk enters, in order.
    #[test]
    fn a_caravan_lists_the_provinces_of_its_route() {
        let mut c = Caravans::default();
        let centre = LogPlace {
            kind: 1,
            p: 0,
            q: 0,
            at: 0,
            gen: 1,
            tile: 30,
        };
        // five steps east from the centre leave the Province (radius 4)
        let path = permutation_rules::frontier::caravan::pack(&[0; 5]).unwrap();
        c.fold(&CqEvent::CaravanSent {
            owner_tag: 5,
            seq: 1,
            faction: 0,
            src: centre,
            dst: centre,
            steps: 5,
            cargo: [1, 0, 0, 0, 0, 0, 0, 0],
            arrive_ts: 0,
            runs: vec![],
            worn_bps: 0,
            path,
        });
        let ps = c.file()["moving"][0]["provinces"].clone();
        let ps = ps.as_array().unwrap();
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[0], json!([0, 0]));
        assert_ne!(ps[1], json!([0, 0]));
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
        assert_eq!(
            f["moving"][0]["provinces"],
            json!([[here(1).p, here(1).q]]),
            "a walk within its Province"
        );
        assert_eq!(f["moving"][0]["path"], json!(vec![0u8; 12]));
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

    /// A Vault's bytes as the program writes them (`layout::s1::vault`).
    fn vault_account(
        p: i16,
        q: i16,
        tile: u8,
        state: u8,
        stores: [i64; 8],
        owner: [u8; 32],
    ) -> Vec<u8> {
        use frontier_abi::v2::layout::s1::vault as VA;
        let mut d = vec![0u8; VA::SIZE];
        d[..8].copy_from_slice(&VA::MAGIC);
        d[VA::P..VA::P + 2].copy_from_slice(&p.to_le_bytes());
        d[VA::Q..VA::Q + 2].copy_from_slice(&q.to_le_bytes());
        d[VA::TILE] = tile;
        d[VA::STATE] = state;
        d[VA::FACTION] = owner[0] % 6;
        d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32].copy_from_slice(&owner);
        for (r, v) in stores.iter().enumerate() {
            d[VA::store(r)..VA::store(r) + 8].copy_from_slice(&v.to_le_bytes());
        }
        d[VA::CAP..VA::CAP + 8].copy_from_slice(&5_000_000i64.to_le_bytes());
        d
    }

    #[test]
    fn a_vault_shows_its_stores_cap_and_owner_from_its_bytes() {
        use frontier_abi::v2::layout::s1::vault as VA;
        let mut c = Caravans::default();
        c.fold(&CqEvent::VaultBuilt {
            p: 3,
            q: 0,
            tile: 40,
            owner_tag: 77,
            faction: 1,
            gen: 1,
            holding_key: 0,
        });
        c.dirty = false;
        // a vault the feed does not list is left alone
        assert!(!c.vault_bytes(
            None,
            Some(&vault_account(3, 0, 41, VA::STATE_LIVE, [0; 8], [5; 32]))
        ));
        let d = vault_account(
            3,
            0,
            40,
            VA::STATE_LIVE,
            [0, 100_500, 0, 0, 0, 7_000, 0, -3],
            [7; 32],
        );
        assert!(c.vault_bytes(None, Some(&d)));
        assert!(c.dirty);
        let v = &c.file()["vaults"][0];
        assert_eq!(
            v["stores"],
            json!([0, 100, 0, 0, 0, 7, 0, 0]),
            "whole units, a negative store read as 0"
        );
        assert_eq!(v["cap"], json!(5000));
        assert_eq!(
            v["ownerCitizen"],
            json!(fclient::Address::new_from_array([7; 32]).to_string())
        );
        assert_eq!(v["faction"], json!(1));
        // seized (s1-season-2): VAULT_SEIZED names the captor's tag; its faction comes with the bytes
        c.fold(&CqEvent::VaultSeized {
            p: 3,
            q: 0,
            tile: 40,
            captor_tag: 99,
            prev_tag: 77,
            new_gen: 2,
            domestic: false,
            host_id: 0,
        });
        let seized = vault_account(
            3,
            0,
            40,
            VA::STATE_LIVE,
            [0, 100_500, 0, 0, 0, 7_000, 0, 0],
            [8; 32],
        );
        assert!(c.vault_bytes(None, Some(&seized)));
        let v = &c.file()["vaults"][0];
        assert_eq!(
            (
                v["ownerTag"].clone(),
                v["gen"].clone(),
                v["faction"].clone()
            ),
            (json!("99"), json!(2), json!(2))
        );
        let d = vault_account(
            3,
            0,
            40,
            VA::STATE_LIVE,
            [0, 100_500, 0, 0, 0, 7_000, 0, -3],
            [7; 32],
        );
        assert!(c.vault_bytes(None, Some(&d)));
        // the same bytes again change nothing; a closed vault (no bytes, or not live) leaves the list
        c.dirty = false;
        assert!(!c.vault_bytes(None, Some(&d)));
        assert!(!c.dirty);
        assert!(c.vault_bytes(Some((3, 0, 40)), None));
        assert!(c.vaults.is_empty());
        // a checkpoint keeps the stores
        c.fold(&CqEvent::VaultBuilt {
            p: 3,
            q: 0,
            tile: 40,
            owner_tag: 77,
            faction: 1,
            gen: 1,
            holding_key: 0,
        });
        c.vault_bytes(None, Some(&d));
        assert_eq!(Caravans::from_json(&c.to_json()).unwrap().vaults, c.vaults);
        assert!(c.vault_bytes(
            None,
            Some(&vault_account(3, 0, 40, VA::STATE_NONE, [0; 8], [5; 32]))
        ));
        assert!(c.vaults.is_empty());
    }
}
