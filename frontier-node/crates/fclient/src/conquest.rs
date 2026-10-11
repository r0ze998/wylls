//! The conquest reads every off-chain process shares (MC contract §6, §8.1,
//! §8.2): typed MC log records, the contested-province test of the
//! keeper's planner, and the March fold's readiness.
//!
//! Everything here reads the Province and MarchState bytes through
//! `frontier-abi` (`conquest_model`, the v2 layouts and log tables), never
//! its own offsets, so the keeper, the herald, the bots and the verifier
//! see one rule.

use frontier_abi::conquest_model::{self as cm, FoldError, Record as CqRecord};
use frontier_abi::v2::layout::province::{conquest as cr, keep as kp, province as p2};
use frontier_abi::v2::log::{self as l2, AnyKind, ConquestPayload, CqKind};

/// Bells per hour (snapshots, folds).
pub const HOUR_BELLS: u32 = cm::HOUR_BELLS;
/// Most hours one FoldMarch folds.
pub const FOLD_MAX_HOURS: u8 = frontier_abi::v2::ix::FOLD_MAX_HOURS;
/// The snapshot ring's length (K-13): a member more than this many hours
/// past an unfolded hour has overwritten it (the hour is lost).
pub const SNAP_RING_HOURS: u32 = p2::SNAP_N as u32;

// ------------------------------------------------------------ log records

/// One MC log record (kinds 80–88), its key and payload as typed fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CqEvent {
    SiegeDeclared {
        p: i32,
        q: i32,
        site: u8,
        attacker: u8,
        /// 6 = a Free City.
        owner_faction: u8,
        target: u8,
        declarer_tag: u64,
        required: u8,
        stake: u32,
        src_key: u64,
        owner_tag: u64,
        lead_host_id: u64,
    },
    SiegeSettled {
        p: i32,
        q: i32,
        site: u8,
        reason: u8,
        recipient_key: u64,
        amount: u32,
        burned: u32,
        slot_released: u8,
    },
    Conquest {
        p: i32,
        q: i32,
        payload: Box<ConquestPayload>,
    },
    CaptureSettled {
        p: i32,
        q: i32,
        site: u8,
        outcome: u8,
        credited: u8,
        captor_tag: u64,
        victim_tag: u64,
        new_gen: u8,
        slot: u8,
    },
    Keep {
        p: i32,
        q: i32,
        cause: u8,
        holder: u8,
        from: u8,
        troops: u32,
        consolidated_until: u32,
        gen: u32,
    },
    MarchFold {
        m: i32,
        n: i32,
        hour: u32,
        controller: u8,
        contested: u8,
        credit: u8,
        lost: u8,
    },
    Retire {
        host_id: u64,
        troops: u32,
        home_key: u64,
        by: u8,
    },
    Neutral {
        p: i32,
        q: i32,
        site: u8,
        kind: u8,
        garrison: u32,
        tier: u8,
    },
    OutpostSettled {
        p: i32,
        q: i32,
        site: u8,
        citizen_tag: u64,
        order: u8,
        gen: u8,
    },
}

impl CqEvent {
    /// The Province the record is about (`None` for MARCH_FOLD and RETIRE).
    pub fn province(&self) -> Option<(i32, i32)> {
        use CqEvent::*;
        match self {
            SiegeDeclared { p, q, .. }
            | SiegeSettled { p, q, .. }
            | Conquest { p, q, .. }
            | CaptureSettled { p, q, .. }
            | Keep { p, q, .. }
            | Neutral { p, q, .. }
            | OutpostSettled { p, q, .. } => Some((*p, *q)),
            MarchFold { .. } | Retire { .. } => None,
        }
    }
}

/// A decoded MC record: its bell and typed fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CqLog {
    pub bell: u32,
    pub event: CqEvent,
}

/// Parses a PS2 body of an MC kind (`None` for an M1 kind or a body that
/// does not decode).
pub fn parse(body: &[u8]) -> Option<CqLog> {
    let r = l2::decode(body).ok()?;
    let AnyKind::Cq(k) = r.kind else {
        return None;
    };
    let f = |name: &str| -> Option<&[u8]> {
        if let Some((o, w)) = l2::field(r.kind, name, false) {
            return r.key.get(o..o + w);
        }
        let (o, w) = l2::field(r.kind, name, true)?;
        r.payload.get(o..o + w)
    };
    let u = |name: &str| -> Option<u64> {
        let b = f(name)?;
        let mut a = [0u8; 8];
        a[..b.len().min(8)].copy_from_slice(&b[..b.len().min(8)]);
        Some(u64::from_le_bytes(a))
    };
    let i = |name: &str| -> Option<i32> { u(name).map(|v| v as u32 as i32) };
    let b8 = |name: &str| -> Option<u8> { u(name).map(|v| v as u8) };
    let event = match k {
        CqKind::SIEGE_DECLARED => CqEvent::SiegeDeclared {
            p: i("p")?,
            q: i("q")?,
            site: b8("site")?,
            attacker: b8("attacker")?,
            owner_faction: b8("owner_faction")?,
            target: b8("target")?,
            declarer_tag: u("declarer_tag")?,
            required: b8("required")?,
            stake: u("stake")? as u32,
            src_key: u("src_key")?,
            owner_tag: u("owner_tag")?,
            lead_host_id: u("lead_host_id")?,
        },
        CqKind::SIEGE_SETTLED => CqEvent::SiegeSettled {
            p: i("p")?,
            q: i("q")?,
            site: b8("site")?,
            reason: b8("reason")?,
            recipient_key: u("recipient_key")?,
            amount: u("amount")? as u32,
            burned: u("burned")? as u32,
            slot_released: b8("slot_released")?,
        },
        CqKind::CONQUEST => CqEvent::Conquest {
            p: i("p")?,
            q: i("q")?,
            payload: Box::new(ConquestPayload::from_bytes(r.payload)?),
        },
        CqKind::CAPTURE_SETTLED => CqEvent::CaptureSettled {
            p: i("p")?,
            q: i("q")?,
            site: b8("site")?,
            outcome: b8("outcome")?,
            credited: b8("credited")?,
            captor_tag: u("captor_tag")?,
            victim_tag: u("victim_tag")?,
            new_gen: b8("new_gen")?,
            slot: b8("slot")?,
        },
        CqKind::KEEP => CqEvent::Keep {
            p: i("p")?,
            q: i("q")?,
            cause: b8("cause")?,
            holder: b8("holder")?,
            from: b8("from")?,
            troops: u("troops")? as u32,
            consolidated_until: u("consolidated_until")? as u32,
            gen: u("gen")? as u32,
        },
        CqKind::MARCH_FOLD => CqEvent::MarchFold {
            m: i("m")?,
            n: i("n")?,
            hour: u("hour")? as u32,
            controller: b8("controller")?,
            contested: b8("contested")?,
            credit: b8("credit")?,
            lost: b8("lost")?,
        },
        CqKind::RETIRE => CqEvent::Retire {
            host_id: u("host_id")?,
            troops: u("troops")? as u32,
            home_key: u("home_key")?,
            by: b8("by")?,
        },
        CqKind::NEUTRAL => CqEvent::Neutral {
            p: i("p")?,
            q: i("q")?,
            site: b8("site")?,
            kind: b8("kind")?,
            garrison: u("garrison")? as u32,
            tier: b8("tier")?,
        },
        CqKind::OUTPOST_SETTLED => CqEvent::OutpostSettled {
            p: i("p")?,
            q: i("q")?,
            site: b8("site")?,
            citizen_tag: u("citizen_tag")?,
            order: b8("order")?,
            gen: b8("gen")?,
        },
    };
    Some(CqLog {
        bell: r.bell,
        event,
    })
}

/// The horns of §8.2's watcher in one record: SIEGE_DECLARED, and the
/// CONQUEST events KEEP_CONTEST, OCCUPIED, CAPTURE_DUE, LIBERATED and
/// KEEP_TAKEN. Returns the event names (status counters). A KEEP record
/// (kind 84) of a take rides the same transaction as its CONQUEST
/// KEEP_TAKEN event and is not counted twice.
pub fn horns(ev: &CqEvent) -> Vec<&'static str> {
    use l2::event as e;
    match ev {
        CqEvent::SiegeDeclared { .. } => vec!["SIEGE_DECLARED"],
        CqEvent::Conquest { payload, .. } => payload.events[..payload.n as usize]
            .iter()
            .filter_map(|x| match x.code & !e::DETAIL {
                e::KEEP_CONTEST => Some("KEEP_CONTEST"),
                e::OCCUPIED => Some("OCCUPIED"),
                e::CAPTURE_DUE => Some("CAPTURE_DUE"),
                e::LIBERATED => Some("LIBERATED"),
                e::KEEP_TAKEN => Some("KEEP_TAKEN"),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}

// ------------------------------------------------------------ the contest

/// Why a Province is contested (MC contract §8.2 "Contested bells").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Contest {
    /// Sites (bit i) with a siege.
    pub sieges: u16,
    /// Sites with an occupation.
    pub occupations: u16,
    /// Sites with a capture due (waiting for SettleCapture; not hot).
    pub captures_due: u16,
    /// Sites whose record owes a stake or a slot (SettleSiege; not hot).
    pub owing: u16,
    /// A keep contest is counting.
    pub keep_contest: bool,
    /// Sites (holdings and Free Cities) with a hostile non-civilian
    /// resident on their hex, as the quiet model sees bell `bell`.
    pub hostile_sites: u16,
    /// A hostile non-civilian resident on the keep's hex.
    pub hostile_keep: bool,
}

impl Contest {
    /// The keeper resolves the Province every bell and never batches it
    /// into a skip (§8.2): an active siege, occupation or keep contest, or
    /// hostile residents on a garrison or keep hex.
    pub fn hot(&self) -> bool {
        self.sieges != 0
            || self.occupations != 0
            || self.keep_contest
            || self.hostile_sites != 0
            || self.hostile_keep
    }
    /// Something a settle can pay out now or later.
    pub fn settle_due(&self) -> bool {
        self.captures_due != 0 || self.owing != 0
    }
}

/// The contest of a v2 Province at bell `bell` (its `resolved_next`, the
/// bell the next resolve or skip computes). `None` for a v1 Province or
/// bytes the model refuses.
pub fn contest(pd: &[u8], bell: u32) -> Option<Contest> {
    if pd.len() < p2::SIZE || !crate::decode::layout_is_v2(pd) {
        return None;
    }
    let recs = cm::decode_records(pd).ok()?;
    let mut c = Contest::default();
    for (s, r) in recs.iter().enumerate() {
        let bit = 1u16 << s;
        match r.kind {
            cr::KIND_SIEGE => c.sieges |= bit,
            cr::KIND_OCCUPATION => c.occupations |= bit,
            cr::KIND_CAPTURE_DUE => c.captures_due |= bit,
            _ => {}
        }
        if r.owes() {
            c.owing |= bit;
        }
    }
    let keep = cm::read_keep(pd).ok()?;
    c.keep_contest = keep.is_some_and(|k| k.contender != kp::NONE);
    let rep = cm::report_quiet(pd, bell).ok()?;
    for (s, x) in rep.sites.iter().enumerate() {
        if x.holders != 0 {
            c.hostile_sites |= 1 << s;
        }
    }
    c.hostile_keep = keep.is_some() && rep.keep.holders != 0;
    Some(c)
}

/// The records of a v2 Province SettleSiege applies to at `now_bell`:
/// a stake or slot owed (kind 0, or a kind-2 occupation owing its stake,
/// A-5), and after the season (`now_bell ≥ end_bell`) every siege that
/// lapsed (§3.11) **once the Province is resolved through `end_bell − 1`**
/// (`rn ≥ end_bell`): a siege §3.4 lets complete at `end_bell − 1` must
/// complete in the keeper's own last resolve, not be lapsed by a
/// SettleSiege that lands first (§5.9: no last look).
pub fn siege_settles(recs: &[CqRecord; 12], now_bell: u32, end_bell: u32, rn: u32) -> Vec<u8> {
    let ended = now_bell >= end_bell && rn >= end_bell;
    recs.iter()
        .enumerate()
        .filter(|(_, r)| r.owes() || (r.kind == cr::KIND_SIEGE && ended))
        .map(|(s, _)| s as u8)
        .collect()
}

// ------------------------------------------------------------ the return settle

/// Which Holding's return settle frees a departed `Leave` entry (§5.5
/// RetireHost, §5.6 0x52; CQ2-C `host::return_target`): a retire Leave
/// bound to its home (`op_a = 1`, `op_ref ≠ 0`) returns to the home
/// Holding `op_ref` names, every other Leave to the issuing Holding (the
/// host id's).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReturnTarget {
    /// `(P, Q, site)` of the Holding to name in the return settle.
    pub holding: (i16, i16, u8),
    /// The generation that Holding must be live at to be credited.
    pub gen: u8,
    /// Bound to a home Holding by RetireHost.
    pub bound: bool,
}

/// The return target of an entry with host id `id`, `op_a`, `op_ref`
/// (`None`: a malformed id).
pub fn return_target(id: u64, op_a: u8, op_ref: u32) -> Option<ReturnTarget> {
    let bound = op_a == frontier_abi::v2::entry::RETIRE_OP_A && op_ref != 0;
    let key = if bound { (op_ref as u64) << 32 } else { id };
    let (p, q, site, gen, _) = crate::addr::host_parts(key).ok()?;
    Some(ReturnTarget {
        holding: (p as i16, q as i16, site),
        gen,
        bound,
    })
}

/// Whether the program leaves this return for the victim's RetireHost
/// instead of settling it (K-27: never stranded by a third party): the
/// target Holding is a **live captured** Holding **with a `prev_home`**
/// (a victim whose first holding was already gone at the capture can never
/// RetireHost, so the program strands its returns: `host::settle_return`),
/// `retire_hosts = 1`, the entry is not yet bound, and its host generation
/// is the Holding's previous one.
pub fn return_waits(t: &ReturnTarget, cap: Option<&CapturedHolding>, retire_hosts: bool) -> bool {
    retire_hosts
        && !t.bound
        && cap.is_some_and(|c| {
            c.live && c.captured && c.prev_home != 0 && c.prev_gen == t.gen && c.gen != t.gen
        })
}

/// What the keeper knows of a Holding that may own previous-generation
/// hosts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CapturedHolding {
    pub gen: u8,
    pub prev_gen: u8,
    pub captured: bool,
    /// Provisional or final (the generation counts as live).
    pub live: bool,
    /// The victim's first-holding key (host-id form), `0` when none.
    pub prev_home: u64,
}

// ------------------------------------------------------------ the fold

/// What FoldMarch can do for a March now (§5.5 0xA5, §8.2 "March folds").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FoldReady {
    /// The hour to fold from (`next_hour`, or the first hour of a March
    /// with no MarchState yet).
    pub hour: u32,
    /// Hours foldable now (0 = wait).
    pub count: u8,
    /// Hours of the batch whose sample a member already overwrote (lost).
    pub lost: u8,
    /// Members (index in `march_members` order) that hold the fold back:
    /// resolved only through `≤ 6 × hour` (FoldTooEarly).
    pub lagging: u8,
}

/// The fold readiness of a March: the 7 members in `march_members` order
/// (`None` = absent at its canonical address), `next_hour` (`None` when
/// the MarchState is absent: the first fold inits it at [`cm::first_hour`]),
/// and the season's `end_bell` with whether it has ended (an Ended season
/// folds only hours `6 × h < end_bell`).
pub fn fold_ready(
    members: &[Option<&[u8]>; 7],
    next_hour: Option<u32>,
    end_bell: u32,
) -> Option<FoldReady> {
    let hour = match next_hour {
        Some(h) => h,
        None => cm::first_hour(members).ok()??,
    };
    let mut r = FoldReady {
        hour,
        ..FoldReady::default()
    };
    for h in hour..hour.saturating_add(FOLD_MAX_HOURS as u32) {
        if h.saturating_mul(HOUR_BELLS) >= end_bell {
            break;
        }
        match cm::fold(members, h) {
            Ok(f) => {
                r.count += 1;
                r.lost += f.lost as u8;
            }
            Err(FoldError::TooEarly) => break,
            Err(_) => return None,
        }
    }
    for (i, m) in members.iter().enumerate() {
        if matches!(cm::member_sample(*m, hour), Err(FoldError::TooEarly)) {
            r.lagging |= 1 << i;
        }
    }
    Some(r)
}

/// The age in hours of an unfolded hour `h` at `now_bell`: hours since it
/// ended (0 while it runs). §8.2 (R-23): at ≥ 3 the lagging idle members
/// are skipped at once.
pub fn unfolded_age_hours(h: u32, now_bell: u32) -> u32 {
    (now_bell / HOUR_BELLS).saturating_sub(h.saturating_add(1))
}

/// The lag in whole game hours of hour `h` at `now_bell`, counted **from
/// the hour's start** (bell `6h`, when its sample is taken): the reading the
/// gated "FoldMarch lag p99 ≤ 5 game hours" uses (one hour stricter than
/// [`unfolded_age_hours`], which the R-23 skip trigger keeps).
pub fn fold_lag_hours(h: u32, now_bell: u32) -> u32 {
    (now_bell / HOUR_BELLS).saturating_sub(h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};

    fn province(rn: u32, opened: u32) -> Vec<u8> {
        let mut d = vec![0u8; p2::SIZE];
        assert!(write_header(&mut d, K2::Province, 7));
        d[p2::RESOLVED_NEXT..p2::RESOLVED_NEXT + 4].copy_from_slice(&rn.to_le_bytes());
        d[p2::OPENED_BELL..p2::OPENED_BELL + 4].copy_from_slice(&opened.to_le_bytes());
        cm::write_no_keep(&mut d).unwrap();
        d
    }

    fn snap(d: &mut [u8], h: u32, w: [u16; 7]) {
        use frontier_abi::v2::layout::province::snapshot as sn;
        let o = p2::snap(h as usize % p2::SNAP_N);
        d[o + sn::HOUR..o + sn::HOUR + 4].copy_from_slice(&h.to_le_bytes());
        for (i, x) in w.iter().enumerate() {
            d[o + sn::WEIGHT + 2 * i..o + sn::WEIGHT + 2 * i + 2].copy_from_slice(&x.to_le_bytes());
        }
    }

    #[test]
    fn cq_contest_reads_records_keep_and_hostiles() {
        use frontier_abi::layout::province::entry as e;
        let mut d = province(50, 0);
        assert_eq!(contest(&d, 50), Some(Contest::default()));
        assert!(!contest(&d, 50).unwrap().hot());
        // A v1 Province is no MC Province.
        assert_eq!(contest(&d[..4_096], 50), None);
        // A capture due and an owed stake: settles, not hot.
        CqRecord {
            kind: cr::KIND_CAPTURE_DUE,
            faction: 2,
            bell: 40,
            ..CqRecord::ZERO
        }
        .write(&mut d, 3)
        .unwrap();
        CqRecord {
            flags: cr::FLAG_STAKE_TO_SRC,
            faction: cr::BARRED_NONE,
            ..CqRecord::ZERO
        }
        .write(&mut d, 4)
        .unwrap();
        let c = contest(&d, 50).unwrap();
        assert_eq!((c.captures_due, c.owing), (1 << 3, 1 << 4));
        assert!(!c.hot() && c.settle_due());
        // A siege is hot.
        CqRecord {
            kind: cr::KIND_SIEGE,
            faction: 1,
            bell: 45,
            required: 60,
            ..CqRecord::ZERO
        }
        .write(&mut d, 6)
        .unwrap();
        assert!(contest(&d, 50).unwrap().hot());
        // A hostile Spearman on the keep's tile: hot even without a contest.
        let mut d2 = province(50, 0);
        let k = cm::read_keep(&d).unwrap();
        assert!(k.is_none());
        let keep = frontier_abi::v2::kernel::keep::Keep {
            tile: 30,
            holder: 2,
            contender: kp::NONE,
            progress: 0,
            required: 72,
            heartland_safe: false,
            paused: false,
            changes: 0,
            troops: 400,
            since_bell: 0,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: 0,
            last_taken_from: kp::NONE,
        };
        cm::write_keep(&mut d2, &keep).unwrap();
        let o = p2::entry(0);
        d2[o + e::STATE] = e::STATE_ROSTER;
        d2[o + e::FACTION] = 4;
        d2[o + e::UNIT] = 1; // an Archer (not civilian)
        d2[o + e::TILE] = 30;
        let c2 = contest(&d2, 50).unwrap();
        assert!(c2.hostile_keep && c2.hot(), "{c2:?}");
        // The holder's own host on its keep is no contest.
        d2[o + e::FACTION] = 2;
        assert!(!contest(&d2, 50).unwrap().hot());
        // A host arriving after the bell is not on the hex yet.
        d2[o + e::FACTION] = 4;
        d2[o + e::FROM_BELL..o + e::FROM_BELL + 4].copy_from_slice(&51u32.to_le_bytes());
        assert!(!contest(&d2, 50).unwrap().hot());
    }

    #[test]
    fn cq_return_target_binds_a_retire_leave_to_its_home() {
        let host = crate::addr::host_id(3, 0, 6, 1, 4).unwrap();
        let home = crate::addr::host_id(1, 0, 2, 4, 0).unwrap();
        // Unbound: the issuing Holding, at the host id's generation.
        let t = return_target(host, 0, 0).unwrap();
        assert_eq!((t.holding, t.gen, t.bound), ((3, 0, 6), 1, false));
        // A retire Leave with op_ref = the home key's high word: the home.
        let t = return_target(host, 1, (home >> 32) as u32).unwrap();
        assert_eq!((t.holding, t.gen, t.bound), ((1, 0, 2), 4, true));
        // op_a = 1 with op_ref 0 is not bound (a plain Leave).
        assert!(!return_target(host, 1, 0).unwrap().bound);
        // Waits only for an unbound previous-generation host of a live
        // captured Holding while retire_hosts = 1.
        let cap = CapturedHolding {
            gen: 2,
            prev_gen: 1,
            captured: true,
            live: true,
            prev_home: home,
        };
        let old = return_target(host, 0, 0).unwrap();
        assert!(return_waits(&old, Some(&cap), true));
        assert!(!return_waits(&old, Some(&cap), false), "retire_hosts = 0");
        assert!(!return_waits(&old, None, true), "an absent Holding strands");
        let dead = CapturedHolding { live: false, ..cap };
        assert!(!return_waits(&old, Some(&dead), true));
        let cur = return_target(crate::addr::host_id(3, 0, 6, 2, 4).unwrap(), 0, 0).unwrap();
        assert!(!return_waits(&cur, Some(&cap), true), "current generation");
        let bound = return_target(host, 1, (home >> 32) as u32).unwrap();
        assert!(!return_waits(&bound, Some(&cap), true));
        // W2R2-D2: no `prev_home` (the victim had no first holding at the
        // capture): the program strands the return, so the keeper does not
        // wait for a RetireHost that can never come.
        let homeless = CapturedHolding {
            prev_home: 0,
            ..cap
        };
        assert!(!return_waits(&old, Some(&homeless), true));
    }

    #[test]
    fn cq_fold_lag_counts_from_the_hour_start() {
        // Hour 5 starts at bell 30, ends at 36.
        assert_eq!(fold_lag_hours(5, 31), 0);
        assert_eq!(unfolded_age_hours(5, 31), 0);
        assert_eq!(fold_lag_hours(5, 48), 3);
        assert_eq!(unfolded_age_hours(5, 48), 2);
        assert_eq!(fold_lag_hours(5, 54), 4);
        assert_eq!(unfolded_age_hours(5, 54), 3, "the R-23 trigger's reading");
        assert_eq!(fold_lag_hours(9, 3), 0, "never negative");
    }

    #[test]
    fn cq_siege_settles_and_season_end() {
        let mut recs = [CqRecord::ZERO; 12];
        recs[1].kind = cr::KIND_SIEGE;
        recs[2].flags = cr::FLAG_SLOT_OWED;
        recs[3].kind = cr::KIND_OCCUPATION;
        recs[3].flags = cr::FLAG_STAKE_TO_SRC;
        recs[4].kind = cr::KIND_CAPTURE_DUE;
        assert_eq!(siege_settles(&recs, 100, 1_008, 100), vec![2, 3]);
        assert_eq!(siege_settles(&recs, 1_008, 1_008, 1_008), vec![1, 2, 3]);
        // CQ2-D review: the lapse waits for the Province's own last resolve
        // (rn < end_bell: the siege may still complete at end_bell - 1).
        assert_eq!(siege_settles(&recs, 1_008, 1_008, 1_007), vec![2, 3]);
        assert_eq!(siege_settles(&recs, 1_100, 1_008, 300), vec![2, 3]);
    }

    #[test]
    fn cq_fold_ready_waits_for_the_laggard_and_counts_lost_hours() {
        // Member 0 resolved through bell 30 (hours ≤ 4 sampled), member 1
        // only through bell 12 (hour 2 at most): the fold waits on it.
        let mut a = province(31, 0);
        let mut b = province(13, 0);
        for h in 0..=5 {
            snap(&mut a, h, [10, 0, 0, 0, 0, 0, 0]);
        }
        for h in 0..=2 {
            snap(&mut b, h, [0, 5, 0, 0, 0, 0, 0]);
        }
        let mut m: [Option<&[u8]>; 7] = [None; 7];
        m[0] = Some(&a);
        m[1] = Some(&b);
        let r = fold_ready(&m, Some(0), 1_008).unwrap();
        assert_eq!((r.hour, r.count, r.lost), (0, 3, 0));
        let r = fold_ready(&m, Some(3), 1_008).unwrap();
        assert_eq!((r.count, r.lagging), (0, 0b10), "member 1 lags");
        // No MarchState yet: the first hour is ⌈min opened_bell / 6⌉.
        let r = fold_ready(&m, None, 1_008).unwrap();
        assert_eq!(r.hour, 0);
        // An Ended season folds only hours with 6h < end_bell.
        let r = fold_ready(&m, Some(0), 12).unwrap();
        assert_eq!(r.count, 2);
        // Member 0 ran 6+ hours past hour 0 without a fold: lost.
        let mut c = province(60, 0);
        for h in 4..=9 {
            snap(&mut c, h, [1, 0, 0, 0, 0, 0, 0]);
        }
        let mut m2: [Option<&[u8]>; 7] = [None; 7];
        m2[0] = Some(&c);
        let r = fold_ready(&m2, Some(0), 1_008).unwrap();
        assert_eq!((r.count, r.lost), (6, 4));
        assert_eq!(unfolded_age_hours(3, 24), 0);
        assert_eq!(unfolded_age_hours(3, 42), 3);
    }

    #[test]
    fn cq_parse_typed_records() {
        use crate::log::{chain, Record};
        let k = AnyKind::Cq(CqKind::KEEP);
        let mut kp = Vec::new();
        kp.extend_from_slice(&(-2i32).to_le_bytes());
        kp.extend_from_slice(&5i32.to_le_bytes());
        kp.extend_from_slice(&[l2::keep_cause::TAKEN, 3, 1]);
        kp.extend_from_slice(&700u32.to_le_bytes());
        kp.extend_from_slice(&900u32.to_le_bytes());
        kp.extend_from_slice(&2u32.to_le_bytes());
        assert_eq!(kp.len(), k.key_len() + k.payload_len());
        let r = chain(1, k.code(), 77, &kp, &[(6, 0, [0; 32])]);
        let got = parse(&r.encode()).unwrap();
        assert_eq!(got.bell, 77);
        assert_eq!(
            got.event,
            CqEvent::Keep {
                p: -2,
                q: 5,
                cause: l2::keep_cause::TAKEN,
                holder: 3,
                from: 1,
                troops: 700,
                consolidated_until: 900,
                gen: 2
            }
        );
        assert!(
            horns(&got.event).is_empty(),
            "counted by CONQUEST's KEEP_TAKEN"
        );
        assert_eq!(got.event.province(), Some((-2, 5)));
        // A CONQUEST with two events.
        let mut pl = ConquestPayload {
            events: [l2::Event::default(); l2::CONQUEST_EVENTS_MAX],
            n: 2,
            records_digest: [0; 32],
            keep_holder: 1,
            keep_contender: 3,
            keep_progress: 1,
            keep_troops: 10,
            donor_host_id: 0,
            snapshot: None,
        };
        pl.events[0] = l2::Event {
            site: l2::event::KEEP_SITE,
            code: l2::event::KEEP_CONTEST,
            faction: 3,
            progress: 1,
        };
        pl.events[1] = l2::Event {
            site: 4,
            code: l2::event::CAPTURE_DUE | l2::event::DETAIL,
            faction: 3,
            progress: 0,
        };
        let mut kp = l2::conquest_key(1, 1, 90).to_vec();
        kp.extend_from_slice(&pl.to_bytes());
        let r = chain(1, CqKind::CONQUEST as u8, 90, &kp, &[(6, 0, [0; 32])]);
        let got = parse(&r.encode()).unwrap();
        assert_eq!(horns(&got.event), vec!["KEEP_CONTEST", "CAPTURE_DUE"]);
        // An M1 kind is not an MC record.
        let h = AnyKind::V1(frontier_abi::log::Kind::HARVEST);
        let r1 = chain(1, h.code(), 1, &vec![0; h.key_len() + h.payload_len()], &[]);
        assert!(Record::decode_v2(&r1.encode()).is_ok());
        assert_eq!(parse(&r1.encode()), None);
    }
}
