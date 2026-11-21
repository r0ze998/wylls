//! Wide provinces kept resolved (devnet runbook gap P9; the playable lane
//! 0x4804, feature `playable-lane`). Role `wide-resolve`, class D.
//!
//! **Why.** A wide province moves its `resolved_next` only by the wide
//! Resolve (0xDC op 1, `proc/wide.rs resolve_inner`), one bell at a time, in
//! order, once THE anchor of `(bell, region)` is posted and its reveal window
//! has closed, and the bell's seed is on chain. The wide host actions read
//! that cursor: WideMuster (`proc/wide.rs muster_as`) and WideGarrison refuse
//! `NotResident` unless `frontier_abi::prologue::resident_ok(resolved_next,
//! now_bell)` (`resolved_next + 1 ≥ now_bell`). On a devnet season nobody else
//! resolves a wide province: the `expeditions` role resolves a destination
//! only up to an arrival, and the local runner's drivers are TEST only. So a
//! wide village could Muster only in its first bells (devnet-keeper-p8 P9).
//! WideEconomy does not read the cursor and was never affected.
//!
//! **What.** Every [`SCAN_SLOTS`] slots, for every wide province this keeper
//! knows of, the next bell is planned exactly as the program will judge it:
//! `bell = resolved_next < now_bell` (a bell that has ended), below the
//! Season's end bell, THE anchor present (the beacon role posts it) and its
//! reveal window closed, no arrival at the bell (the ArrivalDay bit clear and
//! no ClashInputs: such a bell needs its gather first, which the
//! `expeditions` role sends — this role leaves it alone), the seed on chain
//! (the SeedCache of any nonce or the archive). Then ONE quiet wide Resolve
//! of that bell, keyed `wres:<P>,<Q>:<bell>`; the next bell is planned once
//! the cursor has moved on the chain. A lagging province is so caught up bell
//! by bell (one write in flight per province), and then kept within a bell.
//!
//! **Which provinces** (no program-account scan exists on `ChainPort`):
//! - every wide province the feed index has seen in an accounted PSW1 record
//!   (a wide village's economy, garrison or muster, a wide Resolve, the
//!   expedition's records) — [`crate::landindex::LandIndex::wide_provinces`],
//!   rebuilt from cursor 0 after a restart;
//! - the province of every wide village won by a claim: the known Citizens'
//!   wide ticket records (`ticket_address(citizen)`, kept until the
//!   season-end close), settled, whose holding at `(coord, site)` exists and
//!   is that Citizen's — read every `wide_scan_slots` slots, as `wide-tickets`.
//!
//! Once known, a province stays in the set for the process (a resolve of an
//! emptied province is still a valid, cheap write: 5,000 lamports a bell).
//!
//! **Races.** The `expeditions` role resolves the same cursor of an arrival's
//! destination (`exp-resolve:<P>,<Q>:<bell>`). Each role skips a bell whose
//! other key is pending, and a write that loses anyway is refused
//! `OutOfOrder` by the program (no state change; the engine backs the key
//! off; the next scan re-reads the cursor).
//!
//! **Who pays.** keeper A's class-D pool: the fee, and the rent of a roster
//! the program creates when a bell's arrival claims an entry (never in a
//! quiet bell). No player pays anything here.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fclient::abi::{status, Class};
use fclient::ix::SeedSource;
use fclient::ports::{Account, ChainPort, PortResult};
use frontier_abi::addr::day_of;
use frontier_abi::layout::player::holding as H;
use frontier_abi::world_index::arrival::{
    arrival_day_address, clash_inputs_address, WideArrivalDay,
};
use frontier_abi::world_index::holding as wh;
use frontier_abi::world_index::land::{self as wl, WideProvince};
use frontier_abi::world_index::ticket::{self as wt, TicketStatus, WideTicket};
use frontier_abi::world_index::wide_ix::WideIx;
use frontier_abi::world_index::{ProvinceKey, WideCoord};
use serde_json::{json, Value};
use solana_address::Address;

use crate::beacon::AnchorInfo;
use crate::engine::{BuildCtx, Engine, Outcome, WriteSpec};
use crate::expedition_steps as steps;
use crate::landindex::LandIndex;
use crate::seeds::SeedFinder;
use crate::Tick;

/// Slots between two scans (as the `expeditions` role).
pub const SCAN_SLOTS: u64 = crate::expeditions::SCAN_SLOTS;
/// Provinces planned per scan at most (the rest wait for the next scan).
pub const PER_SCAN: usize = 64;
/// The CU limit of one quiet wide Resolve (as the `expeditions` role's).
pub const CU_RESOLVE: u32 = crate::expeditions::CU_RESOLVE;
/// Landed keys kept for the status (the newest).
pub const KEEP_LANDED: usize = 64;

/// The write key of this role's resolve of `(p, q)` at `bell`.
pub fn key(p: i64, q: i64, bell: u32) -> String {
    format!("wres:{p},{q}:{bell}")
}

/// Whether a write key is this role's.
pub fn is_key(k: &str) -> bool {
    k.starts_with("wres:")
}

/// What a scan decides for one province (pure; the planner's order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing to do: the cursor is at the current bell (or past the end).
    UpToDate,
    /// The bell's anchor is not posted yet (the beacon role's).
    WaitAnchor(u32),
    /// The bell's reveal window is still open.
    WaitWindow(u32),
    /// The bell has arrivals: the `expeditions` role gathers and resolves it.
    Arrivals(u32),
    /// The seed of the bell is not on chain yet (the beacon role's).
    WaitSeed(u32),
    /// The other role's resolve of this bell is in flight.
    OtherPending(u32),
    /// Send the quiet Resolve of this bell.
    Resolve(u32),
}

/// The facts a scan read for one province's cursor bell.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct View {
    pub resolved_next: u32,
    pub now_bell: u32,
    pub end_bell: u32,
    pub anchor: bool,
    pub window_closed: bool,
    /// The ArrivalDay bit of the bell, or a ClashInputs present.
    pub arrivals: bool,
    pub seed: bool,
    pub other_pending: bool,
}

/// The planner's rule (module doc), in the program's order.
pub fn decide(v: &View) -> Step {
    let b = v.resolved_next;
    if b >= v.now_bell || b >= v.end_bell {
        return Step::UpToDate;
    }
    if !v.anchor {
        return Step::WaitAnchor(b);
    }
    if !v.window_closed {
        return Step::WaitWindow(b);
    }
    if v.arrivals {
        return Step::Arrivals(b);
    }
    if v.other_pending {
        return Step::OtherPending(b);
    }
    if !v.seed {
        return Step::WaitSeed(b);
    }
    Step::Resolve(b)
}

#[derive(Default)]
pub struct WideResolveDuty {
    last_scan: Option<u64>,
    last_discover: Option<u64>,
    /// Wide provinces found through the wide ticket records (module doc).
    pub claimed: BTreeSet<(i64, i64)>,
    /// The last decision per province (status).
    pub last: BTreeMap<(i64, i64), String>,
    /// Landed resolves (count) and the newest keys `(key, slot)`.
    pub landed: u64,
    pub recent: Vec<(String, u64)>,
    /// Refused resolves `(key, why)` (the newest [`KEEP_LANDED`]).
    pub refused: Vec<(String, String)>,
}

fn adr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
}

async fn read_all<P: ChainPort>(port: &P, keys: &[Address]) -> PortResult<Vec<Option<Account>>> {
    let mut got = Vec::with_capacity(keys.len());
    for chunk in keys.chunks(100) {
        got.extend(port.accounts(chunk, 0).await?);
    }
    Ok(got)
}

impl WideResolveDuty {
    pub fn on_outcome(&mut self, key: &str, o: &Outcome) {
        match o {
            Outcome::Landed { slot, .. } => {
                self.landed += 1;
                self.recent.push((key.to_string(), *slot));
                if self.recent.len() > KEEP_LANDED {
                    self.recent.remove(0);
                }
            }
            Outcome::Failed { err, code, .. } | Outcome::Dead { reason: err, code } => {
                eprintln!("frontier-keeper: wide-resolve: {key} refused: {err} (code {code:?})");
                self.refused
                    .push((key.to_string(), format!("{err} (code {code:?})")));
                if self.refused.len() > KEEP_LANDED {
                    self.refused.remove(0);
                }
            }
            Outcome::Unresolved { .. } => {}
        }
    }

    pub fn status(&self, index: &LandIndex) -> Value {
        let all = self.provinces(index);
        json!({
            "provinces": all.len(),
            "from_feed": index.wide_provinces.len(),
            "from_claims": self.claimed.len(),
            "landed": self.landed,
            "recent": self.recent.iter().rev().take(8).map(|(k, s)| json!({"key": k, "slot": s})).collect::<Vec<_>>(),
            "refused": self.refused.iter().map(|(k, s)| json!({"key": k, "why": s})).collect::<Vec<_>>(),
            "last": self.last.iter().map(|((p, q), v)| (format!("{p},{q}"), v.clone())).collect::<BTreeMap<_, _>>(),
        })
    }

    /// Every wide province known (module doc).
    pub fn provinces(&self, index: &LandIndex) -> BTreeSet<(i64, i64)> {
        let mut all = self.claimed.clone();
        all.extend(index.wide_provinces.iter().copied());
        all
    }

    /// The wide villages won by a claim: their provinces (module doc).
    async fn discover<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        index: &LandIndex,
    ) -> PortResult<()> {
        let program = t.addrs.program;
        let c = crate::widelane::ctx(t.addrs);
        let citizens: Vec<Address> = index.citizens.keys().copied().collect();
        let rkeys: Vec<Address> = citizens
            .iter()
            .map(|z| adr(wt::ticket_address(&c, &z.to_bytes())))
            .collect();
        let mut won: Vec<(WideCoord, u8, Address)> = vec![];
        for (z, acct) in citizens.iter().zip(read_all(port, &rkeys).await?) {
            let Some(rec) = acct
                .filter(|a| a.owner == program)
                .and_then(|a| WideTicket::read(&a.data).ok())
                .filter(|r| r.citizen == z.to_bytes() && r.status == TicketStatus::Settled)
            else {
                continue;
            };
            if !self.claimed.contains(&(rec.coord.p(), rec.coord.q())) {
                won.push((rec.coord, rec.site, *z));
            }
        }
        let hkeys: Vec<Address> = won
            .iter()
            .map(|(x, s, _)| adr(wh::holding_address(&c, *x, *s)))
            .collect();
        for ((x, _, z), h) in won.iter().zip(read_all(port, &hkeys).await?) {
            let owner = h.filter(|a| a.owner == program).and_then(|a| {
                a.data
                    .get(H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32)
                    .map(|b| b.to_vec())
            });
            if owner.as_deref() == Some(&z.to_bytes()[..]) {
                self.claimed.insert((x.p(), x.q()));
            }
        }
        Ok(())
    }

    /// One scan (module doc): at most one Resolve per province.
    pub async fn plan<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        index: &LandIndex,
        seeds: &mut SeedFinder,
        anchors: &BTreeMap<(u32, u8), AnchorInfo>,
    ) -> PortResult<()> {
        if !t.cfg.has_role("wide-resolve") || t.season.effective_status(t.now) != status::RUNNING {
            return Ok(());
        }
        if self
            .last_discover
            .is_none_or(|s| t.slot >= s.saturating_add(t.cfg.wide_scan_slots))
        {
            self.last_discover = Some(t.slot);
            self.discover(t, port, index).await?;
        }
        if self
            .last_scan
            .is_some_and(|s| t.slot < s.saturating_add(SCAN_SLOTS))
        {
            return Ok(());
        }
        self.last_scan = Some(t.slot);
        let Some(now_bell) = t.clock.bell_at(t.now) else {
            return Ok(());
        };
        let program = t.addrs.program;
        let c = crate::widelane::ctx(t.addrs);
        let all: Vec<(i64, i64)> = self.provinces(index).into_iter().collect();
        // (the provinces whose cursor lags the most first; none is skipped for long: the cursor moves)
        let coords: Vec<WideCoord> = all
            .iter()
            .filter_map(|&(p, q)| WideCoord::checked(p, q).ok())
            .collect();
        let pkeys: Vec<Address> = coords
            .iter()
            .map(|&x| adr(wl::province_address(&c, x)))
            .collect();
        let mut rows: Vec<(WideProvince, u32)> = vec![];
        for (x, acct) in coords.iter().zip(read_all(port, &pkeys).await?) {
            let Some(a) = acct.filter(|a| a.owner == program) else {
                self.last
                    .insert((x.p(), x.q()), "no wide Province at the coordinate".into());
                continue;
            };
            let (Ok(pv), Some(rn)) = (
                WideProvince::read(&a.data),
                a.data
                    .get(frontier_abi::v2::layout::province::province::RESOLVED_NEXT..)
                    .and_then(|b| b.get(..4))
                    .map(|b| u32::from_le_bytes(b.try_into().unwrap())),
            ) else {
                self.last
                    .insert((x.p(), x.q()), "the wide Province does not decode".into());
                continue;
            };
            if pv.season_id != t.addrs.season_id || pv.coord != *x {
                continue;
            }
            rows.push((pv, rn));
        }
        rows.sort_by_key(|(_, rn)| *rn);
        for (pv, rn) in rows.into_iter().take(PER_SCAN) {
            let (p, q) = (pv.coord.p(), pv.coord.q());
            let dest = ProvinceKey::new(pv.world, pv.coord);
            let mut v = View {
                resolved_next: rn,
                now_bell,
                end_bell: t.season.end_bell,
                ..View::default()
            };
            let b = rn;
            let mut anchor_src = None;
            if b < now_bell && b < t.season.end_bell {
                if let Some((a_ts, archived)) =
                    crate::expeditions::anchor_of(port, t, b, pv.region).await?
                {
                    v.anchor = true;
                    v.window_closed = t.now >= t.clock.reveal_close(b, a_ts);
                    anchor_src = Some(if archived {
                        t.addrs.archive(pv.region, fclient::addr::archive_part(b))
                    } else {
                        t.addrs.anchor(b, pv.region)
                    });
                }
            }
            let mut seed = None;
            if v.anchor && v.window_closed {
                let got = read_all(
                    port,
                    &[
                        adr(clash_inputs_address(&c, dest, b)),
                        adr(arrival_day_address(&c, dest, day_of(b))),
                    ],
                )
                .await?;
                let inputs = got[0].as_ref().is_some_and(|a| !a.data.is_empty());
                let bit = got[1]
                    .as_ref()
                    .filter(|a| a.owner == program)
                    .and_then(|a| WideArrivalDay::read(&a.data).ok())
                    .is_some_and(|d| d.dest == dest && d.has(b));
                v.arrivals = inputs || bit;
                v.other_pending = engine.is_pending(&format!("exp-resolve:{p},{q}:{b}"));
                if !v.arrivals && !v.other_pending {
                    seed = seeds
                        .find(port, t.addrs, anchors, b, pv.region, t.slot)
                        .await?;
                    v.seed = seed.is_some();
                }
            }
            let step = decide(&v);
            let note = match &step {
                Step::UpToDate => format!("resolved_next {rn} (now {now_bell})"),
                Step::WaitAnchor(b) => format!("bell {b}: waiting for THE anchor (beacon role)"),
                Step::WaitWindow(b) => format!("bell {b}: reveal window open"),
                Step::Arrivals(b) => format!("bell {b}: arrivals (left to the expeditions role)"),
                Step::WaitSeed(b) => format!("bell {b}: waiting for the seed (beacon role)"),
                Step::OtherPending(b) => {
                    format!("bell {b}: the expeditions role's resolve in flight")
                }
                Step::Resolve(b) => format!("quiet Resolve of bell {b} (now {now_bell})"),
            };
            self.last.insert((p, q), note);
            let (Step::Resolve(b), Some(s), Some(anchor_src)) = (step, seed, anchor_src) else {
                continue;
            };
            let (seed_src, anchor_src) = match s.src {
                SeedSource::Cache { nonce } => {
                    (t.addrs.seed_cache(b, pv.region, nonce), anchor_src)
                }
                SeedSource::Archive => {
                    let ar = t.addrs.archive(pv.region, fclient::addr::archive_part(b));
                    (ar, ar)
                }
            };
            let k = key(p, q, b);
            let a = t.addrs.clone();
            if engine.ensure(
                WriteSpec {
                    key: k.clone(),
                    kind: "wide-resolve",
                    tag: WideIx::SettleTicket.tag(), // (0xDC: the class tag of the wide Resolve, op 1)
                    class: Class::D,
                    bell: Some(b),
                    region: Some(pv.region),
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![steps::resolve_ix_at(
                            &a,
                            &c.payer,
                            dest,
                            b,
                            &seed_src,
                            &anchor_src,
                        )]
                    }),
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: None,
                },
                t.slot,
            ) {
                engine.set_cu_limit(&k, CU_RESOLVE);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(rn: u32, now: u32) -> View {
        View {
            resolved_next: rn,
            now_bell: now,
            end_bell: 1008,
            anchor: true,
            window_closed: true,
            arrivals: false,
            seed: true,
            other_pending: false,
        }
    }

    #[test]
    fn a_province_at_the_current_bell_or_the_end_waits() {
        assert_eq!(decide(&v(10, 10)), Step::UpToDate);
        assert_eq!(decide(&v(11, 10)), Step::UpToDate);
        assert_eq!(
            decide(&View {
                end_bell: 5,
                ..v(5, 10)
            }),
            Step::UpToDate
        );
    }

    #[test]
    fn an_ended_bell_is_resolved_in_the_programs_order() {
        assert_eq!(decide(&v(3, 10)), Step::Resolve(3));
        assert_eq!(
            decide(&View {
                anchor: false,
                ..v(3, 10)
            }),
            Step::WaitAnchor(3)
        );
        assert_eq!(
            decide(&View {
                window_closed: false,
                ..v(3, 10)
            }),
            Step::WaitWindow(3)
        );
        assert_eq!(
            decide(&View {
                seed: false,
                ..v(3, 10)
            }),
            Step::WaitSeed(3)
        );
    }

    #[test]
    fn a_bell_with_arrivals_or_the_other_roles_write_is_left_alone() {
        assert_eq!(
            decide(&View {
                arrivals: true,
                ..v(3, 10)
            }),
            Step::Arrivals(3)
        );
        assert_eq!(
            decide(&View {
                other_pending: true,
                ..v(3, 10)
            }),
            Step::OtherPending(3)
        );
    }

    /// The muster rule this role keeps true (`prologue::resident_ok`): a province resolved up to the bell before the
    /// current one is resident; one more bell behind is not.
    #[test]
    fn the_cursor_kept_within_a_bell_keeps_the_muster_resident() {
        use frontier_abi::prologue::resident_ok;
        assert!(resident_ok(9, 10));
        assert!(resident_ok(10, 10));
        assert!(!resident_ok(8, 10));
        // (a cursor this role leaves at `now_bell − 1` at worst: the bell just ended, its window still open)
        assert_eq!(
            decide(&View {
                window_closed: false,
                ..v(9, 10)
            }),
            Step::WaitWindow(9)
        );
    }

    #[test]
    fn keys_are_the_roles_own() {
        assert_eq!(key(129, -3, 7), "wres:129,-3:7");
        assert!(is_key("wres:1,2:3"));
        assert!(!is_key("wide-settle:x:1"));
        assert!(!crate::expeditions::is_key("wres:1,2:3"));
    }
}
