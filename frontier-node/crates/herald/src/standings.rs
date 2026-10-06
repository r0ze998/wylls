//! Territory-time standings: hourly `PSFSD1` rows, a current-bell
//! `/h/standings/latest.json`, and display-only player recognition.
//! Scores sum the authoritative province counters. `dominion` and `index`
//! remain compatibility aliases; no member normalization or capture bonus
//! contributes to the score.
//!
//! **When an hour's row is written.** Hour h's map figures (provinces,
//! banners, holdings, occupations) are taken from the control file of its
//! last bell (`6h + 5`, or `end_bell − 1`). No March-fold wait is needed
//! for the province counters. Cumulative fields count events of bells ≤ the hour's
//! bell and the folds of hours ≤ h known when the row is written (never
//! lower than the previous row). `members_active` and `members` are the
//! JoinShards' as of the transaction that completes the row.
//! Definitions (CQ2-E-NOTES §3): sieges won = completed as the attacker;
//! sieges lost = completed against the faction's holding; liberations =
//! LIBERATED events on the faction's holdings; captures = credited.

use std::collections::BTreeSet;

use frontier_abi::bytes::{rd_u32, rd_u8};
use frontier_abi::conquest_model as qm;
use frontier_abi::v2::layout::world::join_shard as JS;
use permutation_rules::frontier::geometry::{march_of, ProvinceCoord};

use crate::conquest::{
    kind_v1, push_diff, write, Cq, SeasonInfo, TALLY_N, T_CAPTURES, T_KEEPS_LOST, T_KEEPS_TAKEN,
    T_LIBERATIONS, T_SIEGES_LOST, T_SIEGES_WON,
};
use crate::cqfmt::{
    FactionHour, FactionStanding, PlayerRow, PlayersFile, StandingsLatest, StandingsSeries,
};
use crate::fold::{Fold, Scope};

/// Membership from JoinShards and established first homes from Citizens.
/// The legacy FINAL_HOLDINGS shard field was never maintained in CQ.
pub fn members(f: &Fold) -> ([u32; 6], [u32; 6]) {
    let (mut m, mut a) = ([0u32; 6], [0u32; 6]);
    for c in f.st.accounts.values() {
        let d = &c.data;
        if kind_v1(d) == Some(frontier_abi::layout::AccountKind::Citizen) {
            if let Ok(citizen) = fclient::decode::Citizen::decode(d) {
                if citizen.faction < 6
                    && citizen.flags
                        & frontier_abi::layout::player::citizen::FLAG_FIRST_HOLDING_FINAL
                        != 0
                {
                    a[citizen.faction as usize] = a[citizen.faction as usize].saturating_add(1);
                }
            }
            continue;
        }
        if kind_v1(d) != Some(frontier_abi::layout::AccountKind::JoinShard) {
            continue;
        }
        let fac = rd_u8(d, JS::FACTION).unwrap_or(9) as usize;
        if fac < 6 {
            m[fac] = m[fac].saturating_add(rd_u32(d, JS::MEMBERS).unwrap_or(0));
        }
    }
    (m, a)
}

/// The Marches a fold of hour `h` must cover: those with an opened member.
pub fn marches_due(f: &Fold, h: u32) -> BTreeSet<(i32, i32)> {
    f.provinces
        .iter()
        .filter(|(_, m)| m.first <= h * qm::HOUR_BELLS)
        .map(|(pq, _)| {
            let m = march_of(ProvinceCoord::new(pq.0 as i32, pq.1 as i32));
            (m.m, m.n)
        })
        .collect()
}

/// Standings rows (PSFSD1), `latest.json` and `players.json`.
pub(crate) fn write_rows(cq: &mut Cq, f: &mut Fold, si: Option<&SeasonInfo>, slot: u64) {
    let Some(_) = cq.ct_next else {
        return;
    };
    let mut wrote = false;
    while let Some((&h, &snap)) = cq.hour_snaps.iter().next() {
        // National score is fully determined by the synchronized Province
        // snapshots. March folds must not delay this public turn result.
        cq.hour_snaps.remove(&h);
        let mut cum = [[0u32; 6]; TALLY_N];
        for (_, t) in cq.tally.range(..=snap.bell) {
            for (r, row) in t.iter().enumerate() {
                for (x, v) in row.iter().enumerate() {
                    cum[r][x] = cum[r][x].saturating_add(*v as u32);
                }
            }
        }
        let (_, active) = members(f);
        let row: [FactionHour; 6] = std::array::from_fn(|x| FactionHour {
            provinces: snap.provinces[x],
            banners: snap.banners[x],
            keeps_taken: cum[T_KEEPS_TAKEN][x].min(u16::MAX as u32) as u16,
            keeps_lost: cum[T_KEEPS_LOST][x].min(u16::MAX as u32) as u16,
            dominion_bells: snap.territory_bells[x].min(u32::MAX as u64) as u32,
            captures: cum[T_CAPTURES][x].min(u16::MAX as u32) as u16,
            occupations_active: snap.occupations[x],
            sieges_won: cum[T_SIEGES_WON][x].min(u16::MAX as u32) as u16,
            sieges_lost: cum[T_SIEGES_LOST][x].min(u16::MAX as u32) as u16,
            liberations: cum[T_LIBERATIONS][x].min(u16::MAX as u32) as u16,
            holdings: snap.holdings[x],
            members_active: active[x].min(u16::MAX as u32) as u16,
        });
        let s = cq.series.get_or_insert(StandingsSeries {
            season: f.cfg.season_id,
            first_hour: h,
            hours: vec![],
        });
        if s.first_hour as usize + s.hours.len() != h as usize {
            // a gap cannot happen (control bells are contiguous); start over
            s.first_hour = h;
            s.hours.clear();
        }
        // monotone cumulative fields (a fold known only now never lowers a row)
        let row = match s.hours.last() {
            Some(p) => std::array::from_fn(|x| {
                let mut r = row[x];
                r.dominion_bells = r.dominion_bells.max(p[x].dominion_bells);
                r
            }),
            None => row,
        };
        s.hours.push(row);
        wrote = true;
    }
    if let Some(s) = cq.series.as_ref().filter(|_| wrote) {
        match s.encode() {
            Ok(b) => write(f, "h/standings/series.bin", &b, false),
            Err(_) => cq.alarms.format_errors += 1,
        }
    }
    if let Some(l) = standings_latest(cq, f, si) {
        if let Ok(j) = l.to_json() {
            write(f, "h/standings/latest.json", j.as_bytes(), false);
            push_diff(
                f,
                "standings",
                "/h/standings/latest.json".into(),
                slot,
                j.into_bytes(),
                Scope::None,
            );
        }
    }
    let pf = players_file(cq);
    if let Ok(j) = pf.to_json() {
        write(f, "h/standings/players.json", j.as_bytes(), false);
    }
}

/// The last standings row with members and the unofficial index.
pub fn standings_latest(cq: &Cq, f: &Fold, si: Option<&SeasonInfo>) -> Option<StandingsLatest> {
    let snap = cq.latest_territory.as_ref()?;
    let hour = snap.bell / qm::HOUR_BELLS;
    let mut cum = [[0u32; 6]; TALLY_N];
    for (_, tally) in cq.tally.range(..=snap.bell) {
        for (r, values) in tally.iter().enumerate() {
            for (sum, value) in cum[r].iter_mut().zip(values) {
                *sum = sum.saturating_add(*value as u32);
            }
        }
    }
    let (_, active) = members(f);
    let row: [FactionHour; 6] = std::array::from_fn(|x| FactionHour {
        provinces: snap.provinces[x],
        banners: snap.banners[x],
        holdings: snap.holdings[x],
        occupations_active: snap.occupations[x],
        members_active: active[x].min(u16::MAX as u32) as u16,
        dominion_bells: snap.territory_bells[x].min(u32::MAX as u64) as u32,
        keeps_taken: cum[T_KEEPS_TAKEN][x].min(u16::MAX as u32) as u16,
        keeps_lost: cum[T_KEEPS_LOST][x].min(u16::MAX as u32) as u16,
        captures: cum[T_CAPTURES][x].min(u16::MAX as u32) as u16,
        sieges_won: cum[T_SIEGES_WON][x].min(u16::MAX as u32) as u16,
        sieges_lost: cum[T_SIEGES_LOST][x].min(u16::MAX as u32) as u16,
        liberations: cum[T_LIBERATIONS][x].min(u16::MAX as u32) as u16,
    });
    let (members, _) = members(f);
    let factions = std::array::from_fn(|x| FactionStanding {
        row: row[x],
        members: members[x],
        // Legacy field names remain aliases so old chart readers still
        // decode the file. Neither activity nor captures affect this score.
        dominion: snap.territory_bells[x],
        index: snap.territory_bells[x],
    });
    Some(StandingsLatest {
        hour,
        bell: snap
            .bell
            .min(si.map_or(u32::MAX, |s| s.end_bell.saturating_sub(1))),
        factions,
    })
}

/// `players.json` from the recognition counters.
pub fn players_file(cq: &Cq) -> PlayersFile {
    let rows = cq.players.iter().filter_map(|(tag, c)| {
        let fac = cq.faction_of_tag(*tag)?;
        Some(PlayerRow {
            tag: *tag,
            faction: fac,
            rank: 0,
            keeps_taken: c[0],
            keep_bells: c[1],
            sieges_won: c[2],
            captures: c[3],
            liberations: c[4],
        })
    });
    PlayersFile::ranked(cq.ct_next.unwrap_or(1).saturating_sub(1), rows)
}
