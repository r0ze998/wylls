//! Player territory records of the recorded wide world (territory-map-2,
//! owner 2026-11-25 12:04 Q-TM-4 (c): "the herald publishes territory
//! records"; feature `wide-world-experimental`).
//!
//! | path | answer | cache |
//! |---|---|---|
//! | `/h/world/wide/territory` | every captured territory province record with an owned tile: who owns which tile | `max-age=5`, ETag, gzip |
//!
//! **What it is.** The territory province records (`PSFXWTN1`, 672 B,
//! frontier-abi `world_index::territory::TerritoryProvince`) the fold
//! captured from the program's post-states, authenticated like the other
//! wide captures (program owner, season, world and the canonical address of
//! the coordinate the record names), decoded to the tiles' owners. A tile's
//! owner is a Citizen tag (the first 8 bytes of the Citizen address, LE) as
//! a decimal string; the answer lists each tag once (`tags`) and each
//! province's owned tiles as `[tile, tag index, dist]` (`dist`: the
//! record's distance byte — provinces from the owner's nearest village at
//! the claim, which its upkeep reads). A record whose 61 tiles
//! are all free is left out (absent = no owned tile known).
//!
//! **What it is not.** Not a view: every account is public on the chain,
//! and the page decides what a player is shown (its fog of war,
//! `web/frontier/map/territorytiles.mjs`). Not a proof (labelled
//! `captured-unverified`, like `/h/world/wide/route`), and not complete (a
//! record the fold never captured is unknown).
//!
//! **Cost.** The records are indexed beside the wide Provinces
//! (`WideIndex::territory`), and a revision counts every change. The
//! server builds the answer once per revision (`server.rs`, gzip and ETag
//! kept with it) and shares it with every viewer: a poll between two claims
//! costs a map lookup and, with `If-None-Match`, a bodiless 304.

use serde_json::{json, Value};
use solana_address::Address;
use std::collections::BTreeMap;

use frontier_abi::world_index::territory::{self as wtr, territory_province, TerritoryProvince};
use frontier_abi::world_index::WideCoord;

use crate::fold::Fold;

/// The magic of a territory province record.
pub const MAGIC: [u8; 8] = territory_province::MAGIC;

pub(crate) fn is_territory(d: &[u8]) -> bool {
    d.get(..8).is_some_and(|m| m == MAGIC)
}

/// The record's coordinate when it is this season's and world's and sits at
/// the canonical address of that coordinate; else `None`.
pub(crate) fn authenticate(f: &Fold, key: &[u8; 32], d: &[u8]) -> Option<WideCoord> {
    let world = f.wide.as_ref()?.world();
    let r = TerritoryProvince::read(d).ok()?;
    (r.season_id == f.cfg.season_id
        && r.world == world
        && wtr::province_address(&f.ctx, r.coord) == *key)
        .then_some(r.coord)
}

/// `GET /h/world/wide/territory`.
pub fn territory_json(f: &Fold) -> Result<Value, crate::wide::WideFault> {
    let w = crate::wide::wide_of(f)?;
    let mut tags: Vec<u64> = vec![];
    let mut tag_ix: BTreeMap<u64, usize> = BTreeMap::new();
    let mut provinces = vec![];
    for (coord, key) in w.territory_records() {
        let Some(c) = f.account(key) else { continue };
        let Ok(r) = TerritoryProvince::read(&c.data) else {
            continue;
        };
        if r.coord != *coord {
            continue;
        }
        let tiles: Vec<Value> = r
            .owner
            .iter()
            .enumerate()
            .filter(|(_, t)| **t != 0)
            .map(|(i, t)| {
                let n = *tag_ix.entry(*t).or_insert_with(|| {
                    tags.push(*t);
                    tags.len() - 1
                });
                json!([i, n, r.dist[i]])
            })
            .collect();
        if tiles.is_empty() {
            continue;
        }
        provinces.push(json!({
            "p": coord.p().to_string(), "q": coord.q().to_string(),
            "address": Address::new_from_array(*key).to_string(),
            "slot": c.slot.to_string(), "archiveSequence": c.tx.to_string(),
            "keepTile": r.keep_tile, "owned": tiles.len(), "tiles": tiles,
        }));
    }
    Ok(json!({
        "v": 1,
        "experimental": true,
        "readOnly": true,
        "verification": "captured-unverified",
        "completeness": "captured",
        "world": hex::encode(w.world().as_bytes()),
        "season": f.cfg.season_id.to_string(),
        "program": f.cfg.program.to_string(),
        "seasonAddress": Address::new_from_array(f.season_address()).to_string(),
        "revision": w.territory_revision().to_string(),
        "tags": tags.iter().map(u64::to_string).collect::<Vec<_>>(),
        "provinces": provinces,
        "tiles": "each province's owned tiles as [tile 0-60, index into tags, dist (provinces from the owner's nearest village at the claim)]; a tag is a Citizen tag (decimal, the first 8 bytes of the Citizen address, little-endian); a record with no owned tile is left out",
    }))
}

#[cfg(test)]
#[path = "wide_territory_tests.rs"]
mod wide_territory_tests;
