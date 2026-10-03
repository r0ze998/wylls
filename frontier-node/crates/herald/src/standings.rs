//! Standings (MC contract §3.10, §8.4; unit CQ2-E): the hourly `PSFSD1`
//! rows, `/h/standings/latest.json` (with the unofficial per-member
//! Dominion index of DESIGN §5.6: the clamped per-capita ratio of the
//! Dominion path times the herding damping, γ = 0.6, `index::IndexParams::
//! REV2`) and `/h/standings/players.json` (display-only recognition, R-10).
//!
//! **When an hour's row is written.** Hour h's map figures (provinces,
//! banners, holdings, occupations) are taken from the control file of its
//! last bell (`6h + 5`, or `end_bell − 1`); the row is written once every
//! March with an opened member has a MARCH_FOLD for hour h, or
//! [`crate::conquest::HOUR_FOLD_WAIT_BELLS`] control bells later, or at the
//! season's end. Cumulative fields count the events of bells ≤ the hour's
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
use permutation_rules::frontier::index::{self as fidx, IndexParams, INDEX_ONE};

use crate::conquest::{
    kind_v1, push_diff, write, Cq, SeasonInfo, HOUR_FOLD_WAIT_BELLS, TALLY_N, T_CAPTURES,
    T_KEEPS_LOST, T_KEEPS_TAKEN, T_LIBERATIONS, T_SIEGES_LOST, T_SIEGES_WON,
};
use crate::cqfmt::{
    FactionHour, FactionStanding, PlayerRow, PlayersFile, StandingsLatest, StandingsSeries,
};
use crate::fold::{Fold, Scope};

/// Members and active members per faction from the JoinShards.
pub fn members(f: &Fold) -> ([u32; 6], [u32; 6]) {
    let (mut m, mut a) = ([0u32; 6], [0u32; 6]);
    for c in f.st.accounts.values() {
        let d = &c.data;
        if kind_v1(d) != Some(frontier_abi::layout::AccountKind::JoinShard) {
            continue;
        }
        let fac = rd_u8(d, JS::FACTION).unwrap_or(9) as usize;
        if fac < 6 {
            m[fac] = m[fac].saturating_add(rd_u32(d, JS::MEMBERS).unwrap_or(0));
            a[fac] = a[fac].saturating_add(rd_u32(d, JS::FINAL_HOLDINGS).unwrap_or(0));
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
    let Some(ct) = cq.ct_next else {
        return;
    };
    let ended = si.is_some_and(|s| s.ended && ct >= s.end_bell);
    let mut wrote = false;
    while let Some((&h, &snap)) = cq.hour_snaps.iter().next() {
        let due = marches_due(f, h);
        let folded = cq
            .fold_hours
            .get(&h)
            .is_some_and(|x| due.iter().all(|m| x.marches.contains(m)));
        if !(folded || snap.bell + HOUR_FOLD_WAIT_BELLS < ct || ended) {
            break;
        }
        cq.hour_snaps.remove(&h);
        let mut cum = [[0u32; 6]; TALLY_N];
        for (_, t) in cq.tally.range(..=snap.bell) {
            for (r, row) in t.iter().enumerate() {
                for (x, v) in row.iter().enumerate() {
                    cum[r][x] = cum[r][x].saturating_add(*v as u32);
                }
            }
        }
        let mut dom = [0u32; 6];
        for (_, fh) in cq.fold_hours.range(..=h) {
            for (d, x) in dom.iter_mut().zip(fh.dom) {
                *d = d.saturating_add(x);
            }
        }
        let (_, active) = members(f);
        let row: [FactionHour; 6] = std::array::from_fn(|x| FactionHour {
            provinces: snap.provinces[x],
            banners: snap.banners[x],
            keeps_taken: cum[T_KEEPS_TAKEN][x].min(u16::MAX as u32) as u16,
            keeps_lost: cum[T_KEEPS_LOST][x].min(u16::MAX as u32) as u16,
            dominion_bells: dom[x],
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
    if !wrote {
        return;
    }
    if let Some(s) = &cq.series {
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
    let s = cq.series.as_ref()?;
    let row = s.hours.last()?;
    let hour = s.first_hour + s.hours.len() as u32 - 1;
    let dpc = si.map_or(36, |x| x.prm.cq.dominion_per_capture) as u64;
    let (members, _) = members(f);
    let dominion: [u64; 6] =
        std::array::from_fn(|x| row[x].dominion_bells as u64 + dpc * row[x].captures as u64);
    let all_d: u64 = dominion.iter().sum();
    let all_a: u64 = row.iter().map(|r| r.members_active as u64).sum();
    let all_m: u64 = members.iter().map(|&m| m as u64).sum();
    let ip = IndexParams::REV2;
    let factions = std::array::from_fn(|x| {
        let ratio = fidx::per_capita_ratio(
            dominion[x],
            row[x].members_active as u64,
            all_d,
            all_a,
            ip.clamp_hi,
        )
        .clamp(ip.clamp_lo, ip.clamp_hi);
        let hd = fidx::herding(members[x] as u64, all_m, &ip);
        FactionStanding {
            row: row[x],
            members: members[x],
            dominion: dominion[x],
            index: (ratio as u128 * hd as u128 / INDEX_ONE as u128) as u64,
        }
    });
    Some(StandingsLatest {
        hour,
        bell: (hour * qm::HOUR_BELLS + qm::HOUR_BELLS - 1)
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
