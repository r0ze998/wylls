//! The structures feed (S1 stages 1d and 1e, `S1-1D-CONTRACT.md` §5.4,
//! `S1-1E-CONTRACT.md` §7): every live structure (towers, palisades,
//! forts) and the towers' sightings — plan B's "the relay's notices". A
//! watchtower cannot see a sealed march before it arrives (no zk yet), but
//! it watches the **public** events in its range: for each public record
//! whose place lies in a tower's coverage, by another faction than the
//! tower's, the herald adds a sighting. Everything here is public anyway;
//! the feed is the convenience of being told (`13-hidden-information`
//! §6-1).
//!
//! `h/structures.json` (live, rewritten when a record changes it):
//!
//! ```json
//! {"v": 1,
//!  "structures": [{"p": 3, "q": 0, "tile": 20, "kind": 1, "faction": 1,
//!    "ownerTag": "…", "gen": 1, "notify": 1, "cover": [12, 13, 19, 20, 21, 27, 28]}],
//!  "sightings": [{"seq": 41, "bell": 290, "tower": {"p": 3, "q": 0, "tile": 20},
//!    "towerFaction": 1, "notify": 1, "ownerTag": "…", "what": "depart",
//!    "faction": 2, "p": 3, "q": 0, "tile": 21, "subject": "…"}]}
//! ```
//!
//! `kind` is `structure::KIND_*` (1 tower, 2 palisade, 3 fort); `cover` is
//! a tower's coverage (empty for the others); `sent` the whole troops sent
//! into a fort (FORT_GARRISONED; its clash losses are not logged). Sightings: DEPART (the origin
//! tile; the faction from the host's holding owner, `null` when the herald
//! has not seen it), CARAVAN_SENT (every tile of the walk, from the logged
//! path; one sighting a tower), REVEAL (the destination tile),
//! CARAVAN_RAIDED (the raid's Province: every tower there). The newest
//! [`SIGHTINGS_MAX`] are kept. Readers filter by `ownerTag` (notify 0) or
//! `towerFaction` (notify 1).

use std::collections::{BTreeMap, VecDeque};

use fclient::conquest::CqEvent;
use permutation_rules::frontier::geometry::{locate, ProvinceCoord};
use permutation_rules::frontier::structure::{coverage, KIND_TOWER};
use permutation_rules::hex::{Hex, DIRECTIONS};
use serde_json::{json, Value};

/// Sightings kept in the feed.
pub const SIGHTINGS_MAX: usize = 256;

/// One live structure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    /// `structure::KIND_*`.
    pub kind: u8,
    pub faction: u8,
    pub owner_tag: u64,
    pub gen: u8,
    pub notify: u8,
    /// S1 1e, a fort: the whole troops its owner sent in (FORT_GARRISONED;
    /// the clash's losses are not logged, so this is what went in, not
    /// what stands).
    pub sent: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Structures {
    /// `(p, q, tile)` → the structure.
    pub items: BTreeMap<(i32, i32, u8), Item>,
    pub sightings: VecDeque<Value>,
    /// The next sighting's number.
    pub seq: u64,
    /// Changed since the file was last written.
    pub dirty: bool,
}

/// What a sighting saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum What {
    Depart,
    Caravan,
    Arrival,
    Raid,
}

impl What {
    fn name(self) -> &'static str {
        match self {
            What::Depart => "depart",
            What::Caravan => "caravan",
            What::Arrival => "arrival",
            What::Raid => "raid",
        }
    }
}

/// The tiles of a caravan's walk: `steps` packed directions from `origin`.
pub fn walk_tiles(origin: (i32, i32, u8), path: &[u8; 12], steps: u8) -> Vec<(i32, i32, u8)> {
    let Some(mut h) = ProvinceCoord::new(origin.0, origin.1).tile(origin.2) else {
        return vec![];
    };
    let mut out = vec![];
    for i in 0..steps.min(32) as usize {
        let d = permutation_rules::frontier::caravan::dir_of(path, i) as usize;
        let Some((dq, dr)) = DIRECTIONS.get(d) else {
            break;
        };
        h = Hex::new(h.q + dq, h.r + dr);
        let (pc, t) = locate(h);
        out.push((pc.p, pc.q, t));
    }
    out
}

impl Structures {
    /// Folds a structure record; `false` for any other.
    pub fn fold(&mut self, ev: &CqEvent) -> bool {
        match ev {
            CqEvent::StructureBuilt {
                p,
                q,
                tile,
                owner_tag,
                faction,
                gen,
                notify,
                kind,
                ..
            } => {
                self.items.insert(
                    (*p, *q, *tile),
                    Item {
                        kind: *kind,
                        faction: *faction,
                        owner_tag: *owner_tag,
                        gen: *gen,
                        notify: *notify,
                        sent: 0,
                    },
                );
            }
            CqEvent::StructureSeized {
                p,
                q,
                tile,
                captor_tag,
                new_gen,
                faction,
                ..
            } => {
                if let Some(t) = self.items.get_mut(&(*p, *q, *tile)) {
                    t.owner_tag = *captor_tag;
                    t.gen = *new_gen;
                    t.faction = *faction;
                }
            }
            CqEvent::StructureClosed { p, q, tile, .. } => {
                self.items.remove(&(*p, *q, *tile));
            }
            CqEvent::FortGarrisoned {
                p, q, tile, troops, ..
            } => {
                if let Some(t) = self.items.get_mut(&(*p, *q, *tile)) {
                    t.sent = t.sent.saturating_add(*troops);
                }
            }
            _ => return false,
        }
        self.dirty = true;
        true
    }

    /// Adds one sighting for every live tower of another faction than
    /// `faction` covering any of `tiles` (a tower sees its own Province
    /// only). `faction: None` (unknown) is seen by every tower.
    pub fn watch(
        &mut self,
        bell: u32,
        what: What,
        faction: Option<u8>,
        tiles: &[(i32, i32, u8)],
        subject: &str,
    ) {
        let mut seen = vec![];
        for (&(p, q, at), t) in &self.items {
            if t.kind != KIND_TOWER || faction == Some(t.faction) {
                continue;
            }
            let cover = coverage(at);
            if let Some(&(_, _, tile)) = tiles
                .iter()
                .find(|(tp, tq, tt)| (*tp, *tq) == (p, q) && cover >> tt & 1 == 1)
            {
                seen.push(json!({
                    "bell": bell, "tower": {"p": p, "q": q, "tile": at},
                    "towerFaction": t.faction, "notify": t.notify,
                    "ownerTag": t.owner_tag.to_string(), "what": what.name(),
                    "faction": faction, "p": p, "q": q, "tile": tile, "subject": subject,
                }));
            }
        }
        for mut s in seen {
            s["seq"] = json!(self.seq);
            self.seq += 1;
            self.sightings.push_back(s);
            while self.sightings.len() > SIGHTINGS_MAX {
                self.sightings.pop_front();
            }
            self.dirty = true;
        }
    }

    /// Every live tower in Province `(p, q)` sees an event somewhere in it
    /// (a raid: neither its tile nor the raider's faction is logged).
    pub fn watch_province(&mut self, bell: u32, what: What, p: i32, q: i32, subject: &str) {
        let tiles: Vec<(i32, i32, u8)> = self
            .items
            .iter()
            .filter(|(_, t)| t.kind == KIND_TOWER)
            .map(|(k, _)| k)
            .filter(|(tp, tq, _)| (*tp, *tq) == (p, q))
            .copied()
            .collect();
        self.watch(bell, what, None, &tiles, subject);
    }

    /// The sightings a public S1 record makes.
    pub fn sight(&mut self, bell: u32, ev: &CqEvent) {
        match ev {
            CqEvent::CaravanSent {
                owner_tag,
                seq,
                faction,
                src,
                steps,
                path,
                ..
            } => {
                let mut tiles = vec![(src.p as i32, src.q as i32, src.tile)];
                tiles.extend(walk_tiles(
                    (src.p as i32, src.q as i32, src.tile),
                    path,
                    *steps,
                ));
                let subject = format!("caravan {owner_tag}/{seq}");
                self.watch(bell, What::Caravan, Some(*faction), &tiles, &subject);
            }
            CqEvent::CaravanRaided {
                owner_tag,
                seq,
                p,
                q,
                ..
            } => {
                let subject = format!("caravan {owner_tag}/{seq}");
                self.watch_province(bell, What::Raid, *p, *q, &subject);
            }
            _ => {}
        }
    }

    /// `h/structures.json`.
    pub fn file(&self) -> Value {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|(&(p, q, tile), t)| {
                let cover: Vec<u8> = if t.kind == KIND_TOWER {
                    (0..61u8).filter(|i| coverage(tile) >> i & 1 == 1).collect()
                } else {
                    vec![]
                };
                json!({"p": p, "q": q, "tile": tile, "kind": t.kind, "faction": t.faction,
                    "ownerTag": t.owner_tag.to_string(), "gen": t.gen, "notify": t.notify,
                    "cover": cover, "sent": t.sent})
            })
            .collect();
        json!({"v": 1, "structures": items, "sightings": self.sightings})
    }

    /// The checkpoint form (the file's plus the next sighting number).
    pub fn to_json(&self) -> Value {
        let mut v = self.file();
        v["seq"] = json!(self.seq);
        v
    }

    /// The inverse of [`Structures::to_json`] (`None` when damaged).
    pub fn from_json(v: &Value) -> Option<Structures> {
        let mut t = Structures {
            seq: v.get("seq")?.as_u64()?,
            ..Default::default()
        };
        for x in v.get("structures")?.as_array()? {
            t.items.insert(
                (
                    x["p"].as_i64()? as i32,
                    x["q"].as_i64()? as i32,
                    x["tile"].as_u64()? as u8,
                ),
                Item {
                    kind: x["kind"].as_u64()? as u8,
                    faction: x["faction"].as_u64()? as u8,
                    owner_tag: x["ownerTag"].as_str()?.parse().ok()?,
                    gen: x["gen"].as_u64()? as u8,
                    notify: x["notify"].as_u64()? as u8,
                    // Absent in a checkpoint written before stage 1e.
                    sent: x.get("sent").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                },
            );
        }
        t.sightings = v.get("sightings")?.as_array()?.iter().cloned().collect();
        Some(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fclient::conquest::{LogPlace, LogRun};
    use permutation_rules::frontier::geometry::tile_index;

    fn built(tile: u8, faction: u8) -> CqEvent {
        CqEvent::StructureBuilt {
            p: 3,
            q: 0,
            tile,
            owner_tag: 77,
            faction,
            gen: 1,
            entry: 0,
            notify: 1,
            holding_key: 0,
            kind: KIND_TOWER,
        }
    }

    /// Towers follow their records; a hostile caravan through the range is
    /// sighted once a tower, a friendly one not; departures and raids; the
    /// checkpoint round-trips; the feed keeps the newest sightings.
    #[test]
    fn towers_sight_public_events_in_range() {
        let centre = tile_index(Hex::new(0, 0)).unwrap();
        let mut t = Structures::default();
        assert!(t.fold(&built(centre, 1)));
        assert!(t.dirty);
        // A caravan of faction 2 walking east through the centre.
        let start = tile_index(Hex::new(-4, 0)).unwrap();
        let path = permutation_rules::frontier::caravan::pack(&[0; 8]).unwrap();
        let sent = |faction| CqEvent::CaravanSent {
            owner_tag: 9,
            seq: 0,
            faction,
            src: LogPlace {
                kind: 1,
                p: 3,
                q: 0,
                at: 0,
                gen: 1,
                tile: start,
            },
            dst: LogPlace {
                kind: 2,
                p: 3,
                q: 0,
                at: 0,
                gen: 1,
                tile: 0,
            },
            steps: 8,
            cargo: [0; 8],
            arrive_ts: 0,
            runs: vec![LogRun {
                p: 3,
                q: 0,
                first_bell: 5,
                n: 2,
            }],
            worn_bps: 0,
            path,
        };
        t.sight(5, &sent(2));
        assert_eq!(t.sightings.len(), 1, "one sighting a tower");
        let s = &t.sightings[0];
        assert_eq!(s["what"], json!("caravan"));
        assert_eq!(s["faction"], json!(2));
        assert_eq!(s["towerFaction"], json!(1));
        t.sight(6, &sent(1));
        assert_eq!(t.sightings.len(), 1, "a tower does not report its own");
        // A departure from inside the range, of an unknown faction.
        t.watch(7, What::Depart, None, &[(3, 0, centre)], "host 1");
        assert_eq!(t.sightings.len(), 2);
        // Outside the range, or in another Province: nothing.
        t.watch(7, What::Depart, Some(2), &[(3, 0, start)], "host 2");
        t.watch(7, What::Arrival, Some(2), &[(3, 1, centre)], "host 3");
        assert_eq!(t.sightings.len(), 2);
        t.sight(
            8,
            &CqEvent::CaravanRaided {
                owner_tag: 9,
                seq: 0,
                p: 3,
                q: 0,
                bell: 8,
                choice: 0,
                by: 0,
                raider_tag: 4,
                taken: [0; 8],
                dst: sent(2).clone_dst(),
                cleared: vec![],
                domestic: false,
            },
        );
        assert_eq!(t.sightings[2]["what"], json!("raid"));
        assert_eq!(
            Structures::from_json(&t.to_json()).unwrap().file(),
            t.file()
        );
        // Seized: the new faction's view; closed: gone.
        t.fold(&CqEvent::StructureSeized {
            p: 3,
            q: 0,
            tile: centre,
            captor_tag: 5,
            prev_tag: 77,
            new_gen: 2,
            faction: 2,
            domestic: false,
            host_id: 0,
            kind: KIND_TOWER,
        });
        t.sight(9, &sent(2));
        assert_eq!(t.sightings.len(), 3, "now the caravan's own faction's");
        assert_eq!(
            t.file()["structures"][0]["cover"].as_array().unwrap().len(),
            19
        );
        t.fold(&CqEvent::StructureClosed {
            p: 3,
            q: 0,
            tile: centre,
            owner_tag: 5,
            entry: 0,
            kind: KIND_TOWER,
        });
        assert!(t.items.is_empty());
        for b in 0..300 {
            t.fold(&built(centre, 1));
            t.watch(b, What::Depart, Some(0), &[(3, 0, centre)], "x");
        }
        assert_eq!(t.sightings.len(), SIGHTINGS_MAX);
        assert_eq!(t.sightings.back().unwrap()["seq"], json!(t.seq - 1));
    }

    trait Dst {
        fn clone_dst(&self) -> LogPlace;
    }
    impl Dst for CqEvent {
        fn clone_dst(&self) -> LogPlace {
            match self {
                CqEvent::CaravanSent { dst, .. } => *dst,
                _ => unreachable!(),
            }
        }
    }
}
