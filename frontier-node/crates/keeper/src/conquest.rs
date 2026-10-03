//! The keeper's conquest duties (MC contract v1.3 §8.2; CQ2-D).
//!
//! | duty | trigger | write | class | role |
//! |---|---|---|---|---|
//! | Contested bells | a v2 Province with a siege, an occupation or a keep contest, or hostile residents on a garrison or keep hex ([`fclient::conquest::contest`]) | the play duty's gather and resolve **every bell**; the skip planner never batches it | D | `gather`, `resolve` |
//! | Idle provinces | nothing contested | the play duty's SkipQuiet at least every 24 bells (4 game hours); **fold-driven:** when a March's oldest unfolded hour is ≥ 3 game hours old, its lagging idle members are skipped at once (R-23) | D | `skip` |
//! | Capture settlement | a record of kind 3 (capture due) | SettleCapture | D | `settle` |
//! | Stakes and slots | a record owing a stake or a slot, or (after `end_bell`) a siege that lapsed | SettleSiege | N | `settle` |
//! | March folds | the hours from `next_hour` whose members all resolved through `6h` | FoldMarch(≤ 6 hours) | D | `fold` |
//! | Horn watcher | SIEGE_DECLARED, KEEP taken, CONQUEST's KEEP_CONTEST / OCCUPIED / CAPTURE_DUE / LIBERATED / KEEP_TAKEN | the province is read at once and planned first; counters; an alert above [`HORN_ALERT_PER_BELL`] | — | — |
//! | Season-end flush | `end_bell` | the play duty's last resolves and skips; FoldMarch for the last hours; SettleCapture; SettleSiege for every lapsed siege and owed stake or slot; **RetireHost** (permissionless after `end_bell`) for every previous-generation host still on a Province | D / N | `fold`, `settle` |
//! | Closes | `end + 72 h` | CloseMarch | N | `close` |
//!
//! **No new keeper role** (the stack pins `config::ROLES`): the conquest
//! writes ride the role of their kind above.
//!
//! **Crash safety** (§8.2): nothing here is trusted over the chain. The
//! Province view is the play duty's Province reads; the March view is a
//! MarchState read; the captured sites come back from the feed (re-read
//! from cursor 0 after a restart).
//!
//! **Adversary model** (§5.9): holding a contested Province, a MarchState
//! or a capture's accounts only delays a write here; every outcome is fixed
//! at the bell, so the duty only retries.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{json, Value};
use solana_address::Address;

use fclient::abi::{self, tag, Class};
use fclient::conquest::{self as fcq, Contest, CqEvent, CqLog};
use fclient::decode::{Citizen, CqRecord, Holding, MarchState};
use fclient::ix::v2 as ix2;
use fclient::ix::HoldingRef;
use fclient::ports::{ChainPort, PortResult};
use frontier_abi::v2::layout::province::conquest as cr;

use crate::engine::{BuildCtx, Engine, Outcome, WriteSpec};
use crate::journal::Journal;
use crate::Tick;

/// Horns per bell above which the watcher alerts the operator (§8.2 "an
/// operator alert above a rate"): two horns per open province-hour at the
/// exit scale (≈ 170 provinces, ≈ 48 keeps a day) is far above play.
pub const HORN_ALERT_PER_BELL: u32 = 48;
/// An unfolded hour this old (game hours) skips its lagging idle members
/// at once (§8.2, R-23).
pub const FOLD_SKIP_AGE_HOURS: u32 = 3;
/// Slots between two reads of a MarchState with nothing due.
pub const MARCH_READ_SLOTS: u64 = 8;
/// CloseMarch from `end + 72 h` (§5.5 0xA7).
pub const CLOSE_MARCH_AFTER_SECS: i64 = 72 * 3_600;
/// Bells of horn counts the status keeps.
const HORN_LOG_BELLS: u32 = 288;

/// A v2 Province as the play duty last read it.
#[derive(Clone, Debug)]
pub struct CqProv {
    pub data: Arc<Vec<u8>>,
    pub rn: u32,
    pub region: u8,
    pub contest: Contest,
    pub records: [CqRecord; 12],
    pub read_slot: u64,
}

/// A March as last read.
#[derive(Clone, Debug, Default)]
pub struct MarchView {
    /// `None`: no MarchState yet (the first FoldMarch inits it).
    pub next_hour: Option<u32>,
    pub rent_to: Option<Address>,
    pub lost_hours: u32,
    pub read_slot: u64,
    pub closed: bool,
}

/// Counters and samples (status, metrics, tests).
#[derive(Clone, Debug, Default)]
pub struct CqStats {
    pub captures_planned: u64,
    pub captures_settled: u64,
    pub sieges_settled: u64,
    pub folds_landed: u64,
    pub hours_folded: u64,
    pub retires: u64,
    pub march_closes: u64,
    pub fold_skips: u64,
    /// Horns by name.
    pub horns: BTreeMap<&'static str, u64>,
    /// Capture due seen → SettleCapture landed, slots (criterion 12).
    pub capture_latency: Vec<u64>,
    /// Unfolded age in game hours of every hour at its fold (§8.2 p99 ≤ 5).
    pub fold_lag_hours: Vec<u64>,
    /// Close → resolve of contested province-bells, slots (criterion 3).
    pub contested_latency: Vec<u64>,
}

#[derive(Default)]
pub struct ConquestDuty {
    pub provs: BTreeMap<(i16, i16), CqProv>,
    pub marches: BTreeMap<(i32, i32), MarchView>,
    pub stats: CqStats,
    /// Provinces a horn named since the last plan: read at once and
    /// planned first by the play duty.
    pub front: BTreeSet<(i16, i16)>,
    /// Idle members of a March whose oldest unfolded hour is old: skipped
    /// at once (R-23).
    pub fold_urgent: BTreeSet<(i16, i16)>,
    /// Sites captured (CAPTURE_SETTLED): their Holdings may still own
    /// previous-generation hosts (the season-end RetireHost).
    pub captured_sites: BTreeSet<(i16, i16, u8)>,
    /// Conquest write kinds the program answered NotImplemented (99) for.
    pub unsupported: BTreeSet<&'static str>,
    /// Horns per bell (the last [`HORN_LOG_BELLS`] bells).
    pub horns_by_bell: BTreeMap<u32, u32>,
    /// Capture key → the slot it was first planned (the latency base).
    capture_seen: BTreeMap<String, u64>,
    /// FoldMarch key → its hours `(first, count)`.
    fold_hours: BTreeMap<String, (u32, u8)>,
    /// Keys landed (not planned again while the chain catches up).
    done: BTreeSet<String>,
    /// Write key → the slot its accounts were last read without a plan
    /// (read again after [`MARCH_READ_SLOTS`]).
    tried: BTreeMap<String, u64>,
    /// Horn-rate alerts raised (one per bell).
    pub alerts: Vec<(u64, String)>,
}

/// The write kinds of this duty (engine stats, journal).
pub const KINDS: [&str; 5] = ["capture", "ssiege", "fmarch", "retire", "cmarch"];

impl ConquestDuty {
    /// The play duty read a Province: keeps the v2 view and answers
    /// whether it is contested (resolve every bell).
    pub fn observe(&mut self, pq: (i16, i16), data: &[u8], rn: u32, region: u8, slot: u64) -> bool {
        let Some(contest) = fcq::contest(data, rn) else {
            self.provs.remove(&pq);
            return false;
        };
        let records =
            frontier_abi::conquest_model::decode_records(data).unwrap_or([CqRecord::ZERO; 12]);
        self.provs.insert(
            pq,
            CqProv {
                data: Arc::new(data.to_vec()),
                rn,
                region,
                contest,
                records,
                read_slot: slot,
            },
        );
        contest.hot()
    }

    /// Whether the last read found `pq` contested.
    pub fn hot(&self, pq: (i16, i16)) -> bool {
        self.provs.get(&pq).is_some_and(|p| p.contest.hot())
    }

    /// The horn watcher (§8.2): an MC record from the feed.
    pub fn on_log(&mut self, log: &CqLog, slot: u64, journal: Option<&Journal>) {
        if let CqEvent::CaptureSettled { p, q, site, .. } = log.event {
            self.captured_sites.insert((p as i16, q as i16, site));
        }
        let horns = fcq::horns(&log.event);
        if horns.is_empty() {
            return;
        }
        let pq = log.event.province().map(|(p, q)| (p as i16, q as i16));
        if let Some(pq) = pq {
            self.front.insert(pq);
        }
        for h in &horns {
            *self.stats.horns.entry(h).or_default() += 1;
            if let Some(j) = journal {
                let object = pq.map_or(String::new(), |(p, q)| format!("{p},{q}"));
                let _ = j.conquest(slot, Some(log.bell), h, &object, "");
            }
        }
        let n = self.horns_by_bell.entry(log.bell).or_default();
        let before = *n;
        *n += horns.len() as u32;
        if before <= HORN_ALERT_PER_BELL && *n > HORN_ALERT_PER_BELL {
            self.alerts.push((
                slot,
                format!("bell {}: {} horns (> {HORN_ALERT_PER_BELL})", log.bell, *n),
            ));
        }
        let floor = log.bell.saturating_sub(HORN_LOG_BELLS);
        self.horns_by_bell.retain(|b, _| *b >= floor);
    }

    /// Routes the engine's outcomes of conquest writes. Returns the
    /// provinces to read again.
    pub fn on_outcome(
        &mut self,
        key: &str,
        o: &Outcome,
        now_bell: u32,
        journal: Option<&Journal>,
    ) -> bool {
        let kind = key.split(':').next().unwrap_or("");
        let Some(kind) = KINDS.iter().find(|k| **k == kind).copied() else {
            return false;
        };
        match o {
            Outcome::Landed { slot, .. } => {
                self.done.insert(key.to_string());
                match kind {
                    "capture" => {
                        self.stats.captures_settled += 1;
                        if let Some(s0) = self.capture_seen.remove(key) {
                            self.stats.capture_latency.push(slot.saturating_sub(s0));
                        }
                    }
                    "ssiege" => self.stats.sieges_settled += 1,
                    "fmarch" => {
                        self.stats.folds_landed += 1;
                        if let Some((h, c)) = self.fold_hours.remove(key) {
                            self.stats.hours_folded += c as u64;
                            for x in h..h + c as u32 {
                                self.stats
                                    .fold_lag_hours
                                    .push(fcq::unfolded_age_hours(x, now_bell) as u64);
                            }
                            if let Some(mn) = parse_mn(key) {
                                let v = self.marches.entry(mn).or_default();
                                v.next_hour = Some(h + c as u32);
                                v.read_slot = 0;
                            }
                        }
                    }
                    "retire" => self.stats.retires += 1,
                    "cmarch" => {
                        self.stats.march_closes += 1;
                        if let Some(mn) = parse_mn(key) {
                            self.marches.entry(mn).or_default().closed = true;
                        }
                    }
                    _ => {}
                }
                if let Some(j) = journal {
                    let _ = j.conquest(*slot, Some(now_bell), kind, key, "landed");
                }
            }
            Outcome::Failed { code, .. } => {
                if kind == "fmarch" {
                    if let Some(mn) = parse_mn(key) {
                        self.marches.entry(mn).or_default().read_slot = 0;
                    }
                }
                let _ = code;
            }
            Outcome::Dead { code, .. } => {
                if *code == Some(abi::err::NOT_IMPLEMENTED) {
                    self.unsupported.insert(kind);
                }
            }
        }
        true
    }

    /// Plans SettleCapture, SettleSiege, FoldMarch and the season-end
    /// RetireHost. `citizens` is the land index's `citizen → (wallet,
    /// faction)` (a citizen tag's Citizen when its Holding cannot name it).
    pub async fn plan<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        citizens: &BTreeMap<Address, (Address, u8)>,
        opened: &BTreeSet<(i16, i16)>,
    ) -> PortResult<()> {
        if !t.season.is_v2() {
            return Ok(());
        }
        let now_bell = t.clock.bell_at(t.now).unwrap_or(0);
        if t.cfg.has_role("settle") {
            if !self.unsupported.contains("capture") {
                self.captures(t, port, engine, citizens).await?;
            }
            if !self.unsupported.contains("ssiege") {
                self.siege_settles(t, port, engine, citizens, now_bell)
                    .await?;
            }
            let retire_on = t.season.conquest.is_some_and(|c| c.retire_hosts == 1);
            if now_bell >= t.season.end_bell && retire_on && !self.unsupported.contains("retire") {
                self.retires(t, port, engine).await?;
            }
        }
        if t.cfg.has_role("fold") && !self.unsupported.contains("fmarch") {
            self.folds(t, port, engine, opened, now_bell).await?;
        } else {
            self.fold_urgent.clear();
        }
        Ok(())
    }

    /// Class-N housekeeping: CloseMarch from `end + 72 h`.
    pub async fn housekeeping<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
    ) -> PortResult<()> {
        if !t.season.is_v2() || !t.cfg.has_role("close") || self.unsupported.contains("cmarch") {
            return Ok(());
        }
        let end_ts = t.season.genesis_ts + t.season.end_bell as i64 * abi::BELL_SECS;
        if t.now < end_ts + CLOSE_MARCH_AFTER_SECS {
            return Ok(());
        }
        let due: Vec<(i32, i32)> = self
            .marches
            .iter()
            .filter(|(_, v)| !v.closed)
            .map(|(k, _)| *k)
            .collect();
        for chunk in due.chunks(64) {
            let keys: Vec<Address> = chunk
                .iter()
                .map(|&(m, n)| t.addrs.march_state(m, n))
                .collect();
            let got = port.accounts(&keys, 0).await?;
            for (mn, a) in chunk.iter().zip(got) {
                let Some(ms) = a
                    .filter(|a| a.owner == t.addrs.program)
                    .and_then(|a| MarchState::decode(&a.data).ok())
                else {
                    // Absent: never created or closed already.
                    self.marches.entry(*mn).or_default().closed = true;
                    continue;
                };
                let key = format!("cmarch:{},{}", mn.0, mn.1);
                if self.done.contains(&key) {
                    continue;
                }
                let (a2, mn2, rent_to) = (t.addrs.clone(), *mn, ms.rent_to);
                engine.ensure(
                    WriteSpec {
                        key,
                        kind: "cmarch",
                        tag: tag::CLOSE_MARCH,
                        class: Class::N,
                        bell: None,
                        region: None,
                        build: Arc::new(move |c: &BuildCtx| {
                            vec![ix2::close_march(&a2, c.payer, mn2, rent_to)]
                        }),
                        deadline_slot: None,
                        not_before_slot: t.slot,
                        fixed_payer: None,
                    },
                    t.slot,
                );
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ captures

    async fn captures<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        citizens: &BTreeMap<Address, (Address, u8)>,
    ) -> PortResult<()> {
        let due: Vec<((i16, i16), u8, CqRecord, u8)> = self
            .provs
            .iter()
            .flat_map(|(pq, v)| {
                let mirror_state = |s: usize| -> u8 {
                    use frontier_abi::v2::layout::province::{province as p2, site as s2};
                    v.data.get(p2::site(s) + s2::STATE).copied().unwrap_or(0)
                };
                v.records
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.kind == cr::KIND_CAPTURE_DUE)
                    .map(move |(s, r)| (*pq, s as u8, *r, mirror_state(s)))
            })
            .collect();
        for (pq, site, rec, _state) in due {
            let key = format!("capture:{},{}:{site}:{}", pq.0, pq.1, rec.bell);
            if self.done.contains(&key) || engine.is_pending(&key) || self.backoff(&key, t.slot) {
                continue;
            }
            let free_city = cr::target_kind(rec.target) == cr::TARGET_FREE_CITY;
            // The captor: the record's src Holding names its owner Citizen
            // (`citizen_tag == actor`), else the land index.
            let src = t.addrs.holding_of_key(rec.src).ok();
            let target = t.addrs.holding(pq.0 as i32, pq.1 as i32, site);
            let keys: Vec<Address> = src.into_iter().chain([target]).collect();
            let got = port.accounts(&keys, 0).await?;
            let mut it = got.into_iter();
            let src_h = src.and_then(|_| it.next().flatten()).and_then(|a| {
                (a.owner == t.addrs.program)
                    .then(|| Holding::decode(&a.data).ok())
                    .flatten()
            });
            let tgt_h = it.next().flatten().and_then(|a| {
                (a.owner == t.addrs.program)
                    .then(|| Holding::decode(&a.data).ok())
                    .flatten()
            });
            let captor = src_h
                .as_ref()
                .map(|h| h.owner_citizen)
                .filter(|c| fclient::addr::citizen_tag_u64(c) == rec.actor)
                .or_else(|| citizen_of_tag(citizens, rec.actor));
            let Some(captor) = captor else {
                continue;
            };
            let victim_citizen = if free_city {
                None
            } else {
                let Some(h) = tgt_h.as_ref() else { continue };
                Some((h.owner_citizen, h.rent_payer))
            };
            let mut ckeys = vec![captor];
            if let Some((vc, _)) = victim_citizen {
                ckeys.push(vc);
            }
            let cs = port.accounts(&ckeys, 0).await?;
            let dec = |a: &Option<fclient::ports::Account>| {
                a.as_ref()
                    .filter(|a| a.owner == t.addrs.program)
                    .and_then(|a| Citizen::decode(&a.data).ok())
            };
            let Some(cc) = dec(&cs[0]) else { continue };
            let victim = match victim_citizen {
                None => None,
                Some((vc, rp)) => {
                    let Some(v) = cs.get(1).and_then(dec) else {
                        continue;
                    };
                    Some((vc, (v.faction, v.join_shard), rp))
                }
            };
            let args = ix2::SettleCaptureArgs {
                province: pq,
                site,
                captor_citizen: captor,
                captor_shard: (cc.faction, cc.join_shard),
                victim,
                stake_holding: src.unwrap_or(target),
                beneficiary: t.cfg.beneficiary,
            };
            let a = t.addrs.clone();
            let region = self.provs.get(&pq).map(|p| p.region);
            if engine.ensure(
                WriteSpec {
                    key: key.clone(),
                    kind: "capture",
                    tag: tag::SETTLE_CAPTURE,
                    class: Class::D,
                    bell: Some(rec.bell),
                    region,
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix2::settle_capture(&a, c.payer, &args)]
                    }),
                    deadline_slot: None,
                    not_before_slot: t.slot,
                    fixed_payer: None,
                },
                t.slot,
            ) {
                self.stats.captures_planned += 1;
                self.tried.remove(&key);
                self.capture_seen.entry(key).or_insert(t.slot);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ stakes and slots

    async fn siege_settles<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        citizens: &BTreeMap<Address, (Address, u8)>,
        now_bell: u32,
    ) -> PortResult<()> {
        let due: Vec<((i16, i16), u8, CqRecord)> = self
            .provs
            .iter()
            .flat_map(|(pq, v)| {
                fcq::siege_settles(&v.records, now_bell, t.season.end_bell)
                    .into_iter()
                    .map(move |s| (*pq, s, v.records[s as usize]))
            })
            .collect();
        for (pq, site, rec) in due {
            let key = format!(
                "ssiege:{},{}:{site}:{}:{}:{}",
                pq.0, pq.1, rec.kind, rec.bell, rec.flags
            );
            if self.done.contains(&key) || engine.is_pending(&key) || self.backoff(&key, t.slot) {
                continue;
            }
            let site_holding = t.addrs.holding(pq.0 as i32, pq.1 as i32, site);
            let recipient =
                if rec.kind == cr::KIND_NONE && rec.flags & cr::FLAG_STAKE_TO_HOLDING != 0 {
                    site_holding
                } else {
                    t.addrs.holding_of_key(rec.src).unwrap_or(site_holding)
                };
            // A slot owed back (bit 5): the record's actor's Citizen and its
            // ticket funder (the escrow refund, CQ1-C D-6).
            let (slot_citizen, funder) = if rec.kind == cr::KIND_NONE
                && rec.flags & cr::FLAG_SLOT_OWED != 0
                || (rec.kind == cr::KIND_SIEGE && cr::target_slot(rec.target) != 0)
            {
                let Some(c) = self
                    .citizen_by_tag(t, port, citizens, rec.actor, rec.src)
                    .await?
                else {
                    continue;
                };
                (c.0, Some(c.1))
            } else {
                // D-3: no slot owed: the site's canonical Holding address
                // stands in (the program reads position 4 only for bit 5).
                (site_holding, None)
            };
            let a = t.addrs.clone();
            let region = self.provs.get(&pq).map(|p| p.region);
            self.tried.remove(&key);
            engine.ensure(
                WriteSpec {
                    key,
                    kind: "ssiege",
                    tag: tag::SETTLE_SIEGE,
                    class: Class::N,
                    bell: None,
                    region,
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix2::settle_siege(
                            &a,
                            c.payer,
                            pq,
                            site,
                            recipient,
                            slot_citizen,
                            funder,
                        )]
                    }),
                    deadline_slot: None,
                    not_before_slot: t.slot,
                    fixed_payer: None,
                },
                t.slot,
            );
        }
        Ok(())
    }

    /// Whether `key`'s accounts were read without a plan within the last
    /// [`MARCH_READ_SLOTS`] (an unknown captor, a Holding not there yet);
    /// marks the read otherwise. A planned write clears it.
    fn backoff(&mut self, key: &str, slot: u64) -> bool {
        if self
            .tried
            .get(key)
            .is_some_and(|&s| slot < s + MARCH_READ_SLOTS)
        {
            return true;
        }
        self.tried.insert(key.to_string(), slot);
        false
    }

    /// The Citizen of `tag` and its ticket funder: from the Holding `hint`
    /// names (its owner), else from the land index.
    async fn citizen_by_tag<P: ChainPort>(
        &self,
        t: &Tick<'_>,
        port: &P,
        citizens: &BTreeMap<Address, (Address, u8)>,
        tag_: u64,
        hint_key: u64,
    ) -> PortResult<Option<(Address, Address)>> {
        let mut cand = None;
        if let Ok(h) = t.addrs.holding_of_key(hint_key) {
            let got = port.accounts(&[h], 0).await?;
            cand = got[0]
                .as_ref()
                .filter(|a| a.owner == t.addrs.program)
                .and_then(|a| Holding::decode(&a.data).ok())
                .map(|h| h.owner_citizen)
                .filter(|c| fclient::addr::citizen_tag_u64(c) == tag_);
        }
        let Some(c) = cand.or_else(|| citizen_of_tag(citizens, tag_)) else {
            return Ok(None);
        };
        let got = port.accounts(&[c], 0).await?;
        Ok(got[0]
            .as_ref()
            .filter(|a| a.owner == t.addrs.program)
            .and_then(|a| Citizen::decode(&a.data).ok())
            .map(|z| (c, z.ticket_funder)))
    }

    // ------------------------------------------------------------ folds

    async fn folds<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        opened: &BTreeSet<(i16, i16)>,
        now_bell: u32,
    ) -> PortResult<()> {
        // Every March with an opened member.
        let mut marches: BTreeSet<(i32, i32)> = BTreeSet::new();
        for &(p, q) in opened.iter().chain(self.provs.keys()) {
            marches.insert(frontier_abi::v2::addr::march_of(p as i32, q as i32));
        }
        // MarchState reads (due ones).
        let due: Vec<(i32, i32)> = marches
            .iter()
            .filter(|mn| {
                self.marches.get(mn).is_none_or(|v| {
                    !v.closed && (v.read_slot == 0 || t.slot >= v.read_slot + MARCH_READ_SLOTS)
                })
            })
            .copied()
            .collect();
        for chunk in due.chunks(64) {
            let keys: Vec<Address> = chunk
                .iter()
                .map(|&(m, n)| t.addrs.march_state(m, n))
                .collect();
            let got = port.accounts(&keys, 0).await?;
            for (mn, a) in chunk.iter().zip(got) {
                let v = self.marches.entry(*mn).or_default();
                v.read_slot = t.slot.max(1);
                if let Some(ms) = a
                    .filter(|a| a.owner == t.addrs.program)
                    .and_then(|a| MarchState::decode(&a.data).ok())
                {
                    v.next_hour = Some(ms.next_hour);
                    v.rent_to = Some(ms.rent_to);
                    v.lost_hours = ms.lost_hours;
                }
            }
        }
        self.fold_urgent.clear();
        for mn in marches {
            let members = frontier_abi::v2::addr::march_members(mn.0, mn.1);
            // Every opened member must be read (a member we have not read
            // would be counted absent).
            let mut bytes: [Option<Arc<Vec<u8>>>; 7] = Default::default();
            let mut unread = false;
            for (i, (p, q)) in members.iter().enumerate() {
                let pq = (*p as i16, *q as i16);
                match self.provs.get(&pq) {
                    Some(v) => bytes[i] = Some(v.data.clone()),
                    None if opened.contains(&pq) => unread = true,
                    None => {}
                }
            }
            if unread {
                continue;
            }
            let refs: [Option<&[u8]>; 7] =
                core::array::from_fn(|i| bytes[i].as_deref().map(|v| v.as_slice()));
            let view = self.marches.get(&mn).cloned().unwrap_or_default();
            if view.closed {
                continue;
            }
            let Some(r) = fcq::fold_ready(&refs, view.next_hour, t.season.end_bell) else {
                continue;
            };
            // R-23: an old unfolded hour skips its lagging idle members now.
            if r.count == 0 && fcq::unfolded_age_hours(r.hour, now_bell) >= FOLD_SKIP_AGE_HOURS {
                for (i, (p, q)) in members.iter().enumerate() {
                    let pq = (*p as i16, *q as i16);
                    if r.lagging & (1 << i) != 0 && !self.hot(pq) {
                        self.fold_urgent.insert(pq);
                    }
                }
            }
            if r.count == 0 {
                continue;
            }
            let key = format!("fmarch:{},{}:{}", mn.0, mn.1, r.hour);
            if self.done.contains(&key) || engine.is_pending(&key) {
                continue;
            }
            let (a, ben, hour, count) = (t.addrs.clone(), t.cfg.beneficiary, r.hour, r.count);
            if engine.ensure(
                WriteSpec {
                    key: key.clone(),
                    kind: "fmarch",
                    tag: tag::FOLD_MARCH,
                    class: Class::D,
                    bell: Some(hour * fcq::HOUR_BELLS),
                    region: None,
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix2::fold_march(&a, c.payer, mn, hour, count, &ben)]
                    }),
                    deadline_slot: None,
                    not_before_slot: t.slot,
                    fixed_payer: None,
                },
                t.slot,
            ) {
                self.fold_hours.insert(key, (hour, count));
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ the flush

    /// After `end_bell`: RetireHost (permissionless, §5.5 0xA6) for every
    /// previous-generation host still on a Province (K-27; R-02).
    async fn retires<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
    ) -> PortResult<()> {
        use frontier_abi::layout::province::entry as e;
        if self.captured_sites.is_empty() {
            return Ok(());
        }
        // Candidates: roster entries whose host names a captured site.
        let mut cands: Vec<RetireCand> = vec![];
        for (pq, v) in &self.provs {
            for i in 0..frontier_abi::v2::layout::province::province::ENTRIES_N {
                let o = frontier_abi::v2::layout::province::province::entry(i);
                let Some(en) = v.data.get(o..o + e::SIZE) else {
                    break;
                };
                if en[e::STATE] != e::STATE_ROSTER || en[e::PEND_OP] != e::OP_NONE {
                    continue;
                }
                let id = u64::from_le_bytes(en[e::ID..e::ID + 8].try_into().unwrap_or([0; 8]));
                let Ok((hp, hq, hs, _, _)) = fclient::addr::host_parts(id) else {
                    continue;
                };
                let site = (hp as i16, hq as i16, hs);
                if self.captured_sites.contains(&site) {
                    cands.push((*pq, i as u8, id, site));
                }
            }
        }
        for (pq, entry, id, (hp, hq, hs)) in cands {
            let key = format!("retire:{},{}:{entry}:{id}", pq.0, pq.1);
            if self.done.contains(&key) || engine.is_pending(&key) {
                continue;
            }
            let captured = HoldingRef {
                p: hp,
                q: hq,
                site: hs,
            };
            let got = port.accounts(&[captured.address(t.addrs)], 0).await?;
            let Some(h) = got[0]
                .as_ref()
                .filter(|a| a.owner == t.addrs.program)
                .and_then(|a| Holding::decode(&a.data).ok())
            else {
                continue;
            };
            let Some(hc) = h.cq else { continue };
            let Ok((_, _, _, gen, _)) = fclient::addr::host_parts(id) else {
                continue;
            };
            if !hc.captured() || gen != hc.prev_gen || gen == h.gen {
                continue;
            }
            let Ok((pp, pq2, ps, _, _)) = fclient::addr::host_parts(hc.prev_home) else {
                continue;
            };
            let home = HoldingRef {
                p: pp as i16,
                q: pq2 as i16,
                site: ps,
            };
            let got = port.accounts(&[home.address(t.addrs)], 0).await?;
            let Some(hh) = got[0]
                .as_ref()
                .filter(|a| a.owner == t.addrs.program)
                .and_then(|a| Holding::decode(&a.data).ok())
            else {
                continue;
            };
            let (a, victim) = (t.addrs.clone(), hh.owner_citizen);
            engine.ensure(
                WriteSpec {
                    key,
                    kind: "retire",
                    tag: tag::RETIRE_HOST,
                    class: Class::N,
                    bell: None,
                    region: self.provs.get(&pq).map(|p| p.region),
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix2::retire_host(
                            &a, c.payer, c.payer, victim, pq, captured, home, entry,
                        )]
                    }),
                    deadline_slot: None,
                    not_before_slot: t.slot,
                    fixed_payer: None,
                },
                t.slot,
            );
        }
        Ok(())
    }

    // ------------------------------------------------------------ status

    /// `/v1/status` `conquest` (§8.2).
    pub fn status(&self, now_bell: Option<u32>) -> Value {
        let count = |f: fn(&Contest) -> u16| -> u32 {
            self.provs
                .values()
                .map(|p| f(&p.contest).count_ones())
                .sum()
        };
        let keeps = self
            .provs
            .values()
            .filter(|p| p.contest.keep_contest)
            .count();
        let horns_last_bell = now_bell
            .and_then(|b| b.checked_sub(1))
            .and_then(|b| self.horns_by_bell.get(&b))
            .copied()
            .unwrap_or(0);
        json!({
            "sieges_active": count(|c| c.sieges),
            "keeps_contested": keeps,
            "occupations": count(|c| c.occupations),
            "settle_pending": self.settle_pending(),
            "fold_lag_hours_p99": crate::quantile(&self.stats.fold_lag_hours, 0.99),
            "horns_last_bell": horns_last_bell,
            "contested_provinces": self.provs.values().filter(|p| p.contest.hot()).count(),
            "contested_resolve_latency_slots_p99": crate::quantile(&self.stats.contested_latency, 0.99),
            "capture_settle_latency_slots_p99": crate::quantile(&self.stats.capture_latency, 0.99),
            "captures_settled": self.stats.captures_settled,
            "sieges_settled": self.stats.sieges_settled,
            "folds_landed": self.stats.folds_landed,
            "hours_folded": self.stats.hours_folded,
            "fold_skips": self.stats.fold_skips,
            "retires": self.stats.retires,
            "march_closes": self.stats.march_closes,
            "horns": self.stats.horns,
            "unsupported": self.unsupported.iter().collect::<Vec<_>>(),
        })
    }

    /// Records owing a settle: captures due and stakes or slots owed.
    pub fn settle_pending(&self) -> u32 {
        self.provs
            .values()
            .map(|p| (p.contest.captures_due | p.contest.owing).count_ones())
            .sum()
    }

    /// Prometheus lines (§8.2: `fk_contested_resolve_latency_slots`,
    /// `fk_fold_lag_hours`, `fk_capture_settle_pending`).
    pub fn metrics(&self, line: &mut dyn FnMut(&str, String)) {
        for q in [0.5, 0.99] {
            if let Some(p) = crate::quantile(&self.stats.contested_latency, q) {
                line(
                    &format!("fk_contested_resolve_latency_slots{{q=\"{q}\"}}"),
                    p.to_string(),
                );
            }
            if let Some(p) = crate::quantile(&self.stats.fold_lag_hours, q) {
                line(&format!("fk_fold_lag_hours{{q=\"{q}\"}}"), p.to_string());
            }
        }
        line(
            "fk_capture_settle_pending",
            self.settle_pending().to_string(),
        );
        for (k, v) in &self.stats.horns {
            line(&format!("fk_horns_total{{kind=\"{k}\"}}"), v.to_string());
        }
    }
}

/// A season-end RetireHost candidate: `(province, entry, host id, the
/// captured site)`.
type RetireCand = ((i16, i16), u8, u64, (i16, i16, u8));

fn parse_mn(key: &str) -> Option<(i32, i32)> {
    let s = key.split(':').nth(1)?;
    let (m, n) = s.split_once(',')?;
    Some((m.parse().ok()?, n.parse().ok()?))
}

/// The Citizen whose address starts with `tag` (little-endian u64), from
/// the land index.
pub fn citizen_of_tag(citizens: &BTreeMap<Address, (Address, u8)>, tag_: u64) -> Option<Address> {
    citizens
        .keys()
        .find(|c| fclient::addr::citizen_tag_u64(c) == tag_)
        .copied()
}

/// CQ2-D's keeper tests over the native `conquest_model` and a fake chain
/// (MC §8.2; the in-process tests on the test-beacon `.so` wait for
/// CQ2-A/B/C, see `docs/frontier/conquest/CQ2-D-NOTES.md`).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::beacon::AnchorInfo;
    use crate::config::KeeperConfig;
    use crate::engine::EngineParams;
    use crate::play::PlayDuty;
    use crate::rounds::Rounds;
    use crate::seeds::SeedFinder;
    use crate::testkit::{self, FakeDrand, FakePort};
    use crate::Shared;
    use fclient::addr::Addresses;
    use fclient::budgets::Budgets;
    use fclient::clock::SeasonClock;
    use fclient::decode::Season;
    use frontier_abi::conquest_model as cm;
    use solana_instruction::Instruction;

    const G: i64 = 1_800_000_000;
    const BELL: i64 = 600;

    fn program() -> Address {
        Address::new_from_array([0x5F; 32])
    }

    struct Env {
        port: FakePort,
        drand: FakeDrand,
        season: Season,
        addrs: Addresses,
        cfg: KeeperConfig,
        engine: Engine,
        rounds: Rounds,
        seeds: SeedFinder,
        shared: Shared,
        beacon: BTreeMap<(u32, u8), AnchorInfo>,
    }

    fn env(roles: &[&str], end_bell: u32) -> Env {
        let drand = FakeDrand::new();
        let season = testkit::season_v2(G, end_bell, &drand.key.info());
        let mut cfg = KeeperConfig::new(program(), 7, Address::new_from_array([0xBE; 32]));
        cfg.roles = roles.iter().map(|r| r.to_string()).collect();
        Env {
            port: FakePort::default(),
            rounds: Rounds::new(drand.key.pk96),
            drand,
            season,
            addrs: Addresses::new(program(), 7),
            cfg,
            engine: Engine::new(Budgets::canonical_v2(), EngineParams::default()),
            seeds: SeedFinder::default(),
            shared: Shared::default(),
            beacon: BTreeMap::new(),
        }
    }

    impl Env {
        async fn play(&mut self, d: &mut PlayDuty, slot: u64, now: i64, opened: &[(i32, i32)]) {
            let t = Tick {
                slot,
                now,
                season: &self.season,
                clock: SeasonClock::from_season(&self.season),
                addrs: &self.addrs,
                cfg: &self.cfg,
            };
            self.port.set_clock(slot, now);
            d.plan(
                &t,
                &self.port,
                &self.drand,
                &mut self.rounds,
                &mut self.engine,
                &self.beacon,
                &mut self.seeds,
                &mut self.shared,
                None,
                opened,
            )
            .await
            .unwrap();
        }
        async fn conquest(
            &mut self,
            c: &mut ConquestDuty,
            slot: u64,
            now: i64,
            citizens: &BTreeMap<Address, (Address, u8)>,
            opened: &BTreeSet<(i16, i16)>,
        ) {
            self.port.set_clock(slot, now);
            let t = Tick {
                slot,
                now,
                season: &self.season,
                clock: SeasonClock::from_season(&self.season),
                addrs: &self.addrs,
                cfg: &self.cfg,
            };
            c.plan(&t, &self.port, &mut self.engine, citizens, opened)
                .await
                .unwrap();
        }
        fn anchor(&mut self, bell: u32, region: u8) {
            self.beacon.insert(
                (bell, region),
                AnchorInfo {
                    a: G + (bell as i64 + 1) * BELL + 5,
                    slot: 1,
                    round: 1,
                    rent_to: Address::new_from_array([1; 32]),
                    cache: None,
                    archived: false,
                },
            );
        }
        fn put(&self, k: Address, d: Vec<u8>) {
            self.port.put(k, testkit::acct(program(), d));
        }
        fn preview(&self, key: &str) -> (Class, u8, Vec<Instruction>) {
            self.engine
                .preview(key, Address::new_from_array([0xEE; 32]))
                .unwrap_or_else(|| panic!("{key} pending"))
        }
        fn keys(&self, prefix: &str) -> Vec<String> {
            self.engine
                .pending_keys()
                .into_iter()
                .filter(|k| k.starts_with(prefix))
                .collect()
        }
    }

    /// The Clock just after bell `b`'s reveal window closed.
    fn after_close(b: u32) -> i64 {
        G + (b as i64 + 1) * BELL + 5 + 600 + 1
    }

    /// MC §8.2 "Contested bells": a keep contest is gathered and resolved
    /// every bell, never batched into a skip; driving the native
    /// `conquest_model` bell by bell, the keep is taken after
    /// `keep_bells` (MC_TEST 24) and the Province goes back to idle
    /// skips. A Province without a contest waits for a 24-bell batch.
    #[tokio::test]
    async fn cq_keep_contest_resolves_every_bell_then_idles() {
        let mut e = env(&["gather", "resolve", "skip"], 1_008);
        let mut d = PlayDuty::default();
        let (p, q) = (3i16, 0i16);
        let rg = fclient::ix::region_of(3, 0);
        let b0 = 200u32;
        let mut pd = testkit::province_v2(p, q, b0);
        let keep_bells = e.season.conquest.unwrap().keep_bells as u8;
        testkit::set_keep(&mut pd, 30, 2, keep_bells);
        let host = fclient::addr::host_id(2, 0, 4, 0, 1).unwrap();
        testkit::set_entry(&mut pd, 0, host, 4, 0, 30, 2_000_000);
        e.put(e.addrs.province(3, 0), pd.clone());
        let prm = cm::StepParams {
            genesis_ts: G,
            end_bell: e.season.end_bell,
            cq: e.season.conquest.unwrap(),
        };
        let mut taken_at = None;
        let mut slot = 10u64;
        for b in b0..b0 + keep_bells as u32 + 3 {
            e.anchor(b, rg);
            slot += 4;
            e.play(&mut d, slot, after_close(b), &[(3, 0)]).await;
            let gather = format!("gather:{p},{q}:{b}:all");
            let hot = fclient::conquest::contest(&pd, b).unwrap().hot();
            assert_eq!(
                e.engine.is_pending(&gather),
                hot,
                "bell {b}: contested ⇔ gathered at once"
            );
            assert!(e.keys("skip:").is_empty(), "bell {b}: never skipped");
            if !hot {
                break;
            }
            assert!(d.conquest.hot((p, q)));
            // The chain: GatherClash and ResolveFromInputs land; the step
            // of bell b is the native model's.
            e.engine.cancel(&gather);
            let rep = cm::report_quiet(&pd, b).unwrap();
            let out = cm::step(&mut pd, b, &rep, &prm).unwrap();
            if out.keep_taken.is_some() {
                taken_at = Some(b);
            }
            testkit::set_resolved_next(&mut pd, b + 1);
            e.put(e.addrs.province(3, 0), pd.clone());
            d.on_outcome(
                &format!("resolve:{p},{q}:{b}"),
                &Outcome::Landed {
                    slot,
                    sig: Default::default(),
                    payer: Address::default(),
                    versions: 1,
                    first_slot: slot,
                    already_done: false,
                },
            );
        }
        let tb = taken_at.expect("the keep was taken");
        assert_eq!(tb, b0 + keep_bells as u32 - 1, "after keep_bells bells");
        let k = cm::read_keep(&pd).unwrap().unwrap();
        assert_eq!(k.holder, 4);
        assert!(!d.conquest.hot((p, q)), "taken: no contest");
        // Idle now: a skip goes out only once 24 bells are closed.
        let rn = tb + 1;
        for b in rn..rn + 24 {
            e.anchor(b, rg);
        }
        e.play(&mut d, slot + 100, after_close(rn + 2), &[(3, 0)])
            .await;
        assert!(e.keys("skip:").is_empty() && e.keys("gather:").is_empty());
        e.play(&mut d, slot + 200, after_close(rn + 23), &[(3, 0)])
            .await;
        assert_eq!(e.keys("skip:"), vec![format!("skip:{p},{q}:{rn}:24")]);
    }

    fn citizens_of(e: &Env, wallets: &[(Address, u8)]) -> BTreeMap<Address, (Address, u8)> {
        wallets
            .iter()
            .map(|(w, f)| (e.addrs.citizen(w), (*w, *f)))
            .collect()
    }

    /// MC §8.2 "Capture settlement": a kind-3 record is settled by
    /// SettleCapture (class D) naming the captor (the src Holding's owner,
    /// `citizen_tag == actor`), its JoinShard, and for a holding the
    /// victim, its JoinShard and the Holding's rent payer; for a Free City
    /// the D-2 placeholders. Landed: counted once with its latency.
    #[tokio::test]
    async fn cq_settle_capture_names_captor_and_victim() {
        let mut e = env(&["settle"], 1_008);
        let mut c = ConquestDuty::default();
        let (cw, vw) = (
            Address::new_from_array([0xC1; 32]),
            Address::new_from_array([0xD2; 32]),
        );
        let (captor, victim) = (e.addrs.citizen(&cw), e.addrs.citizen(&vw));
        let funder = Address::new_from_array([0xF0; 32]);
        let rent = Address::new_from_array([0xAA; 32]);
        // The captor's source holding (2,0,4) and its Citizen.
        let src_key = fclient::addr::host_id(2, 0, 4, 0, 0).unwrap();
        e.put(
            e.addrs.holding(2, 0, 4),
            testkit::holding_v2(2, 0, 4, 0, captor, funder, None),
        );
        e.put(captor, testkit::citizen_v2(3, 5, funder));
        e.put(victim, testkit::citizen_v2(1, 2, funder));
        // Site 6 of (3,0): another holding (captured); site 7: a Free City.
        e.put(
            e.addrs.holding(3, 0, 6),
            testkit::holding_v2(3, 0, 6, 1, victim, rent, None),
        );
        let mut pd = testkit::province_v2(3, 0, 300);
        testkit::set_site_v2(&mut pd, 6, 20, 1, 3, 2);
        testkit::set_site_v2(&mut pd, 7, 21, 1, 3, 1);
        for (site, kind) in [(6usize, cr::TARGET_OTHER), (7, cr::TARGET_FREE_CITY)] {
            CqRecord {
                kind: cr::KIND_CAPTURE_DUE,
                faction: 3,
                flags: cr::FLAG_CREDITED,
                target: cr::target(kind, 2),
                bell: 290,
                actor: fclient::addr::citizen_tag_u64(&captor),
                src: src_key,
                ..CqRecord::ZERO
            }
            .write(&mut pd, site)
            .unwrap();
        }
        assert!(!c.observe((3, 0), &pd, 300, 0, 1), "capture due: not hot");
        let cits = citizens_of(&e, &[]);
        e.conquest(&mut c, 20, after_close(300), &cits, &BTreeSet::new())
            .await;
        let (class, tg, ixs) = e.preview("capture:3,0:6:290");
        assert_eq!((class, tg), (Class::D, tag::SETTLE_CAPTURE));
        let acc: Vec<Address> = ixs[0].accounts.iter().map(|m| m.pubkey).collect();
        assert_eq!(acc[2], e.addrs.holding(3, 0, 6));
        assert_eq!(acc[3], e.addrs.province(3, 0));
        assert_eq!(acc[4], captor);
        assert_eq!(acc[5], e.addrs.join_shard(3, 5));
        assert_eq!(acc[6], victim);
        assert_eq!(acc[7], e.addrs.join_shard(1, 2));
        assert_eq!(acc[8], rent);
        assert_eq!(acc[9], e.addrs.holding(2, 0, 4), "the stake's src");
        let (_, _, fc) = e.preview("capture:3,0:7:290");
        let acc: Vec<Address> = fc[0].accounts.iter().map(|m| m.pubkey).collect();
        assert_eq!(acc[4], captor);
        assert_eq!(acc[6], e.addrs.holding(3, 0, 7), "D-2 placeholder");
        // The captor named only by the land index (src Holding gone).
        e.port
            .accounts
            .lock()
            .unwrap()
            .remove(&e.addrs.holding(2, 0, 4));
        e.engine.cancel("capture:3,0:6:290");
        let mut c2 = ConquestDuty::default();
        c2.observe((3, 0), &pd, 300, 0, 1);
        e.conquest(
            &mut c2,
            21,
            after_close(300),
            &BTreeMap::new(),
            &BTreeSet::new(),
        )
        .await;
        assert!(
            !e.engine.is_pending("capture:3,0:6:290"),
            "no captor known: wait"
        );
        let cits = citizens_of(&e, &[(cw, 3)]);
        e.conquest(&mut c2, 22, after_close(300), &cits, &BTreeSet::new())
            .await;
        assert!(
            !e.engine.is_pending("capture:3,0:6:290"),
            "read again only after the backoff"
        );
        e.conquest(&mut c2, 29, after_close(300), &cits, &BTreeSet::new())
            .await;
        assert!(e.engine.is_pending("capture:3,0:6:290"));
        // Landed: counted, latency from the first plan, not planned again.
        e.engine.cancel("capture:3,0:6:290");
        c2.on_outcome(
            "capture:3,0:6:290",
            &Outcome::Landed {
                slot: 30,
                sig: Default::default(),
                payer: Address::default(),
                versions: 1,
                first_slot: 29,
                already_done: false,
            },
            301,
            None,
        );
        assert_eq!(c2.stats.captures_settled, 1);
        assert_eq!(c2.stats.capture_latency, vec![1]);
        e.conquest(&mut c2, 31, after_close(300), &cits, &BTreeSet::new())
            .await;
        assert!(!e.engine.is_pending("capture:3,0:6:290"));
        assert_eq!(c2.settle_pending(), 2, "until the Province is read again");
    }

    /// MC §8.2 "Stakes and slots": SettleSiege (class N) pays an owed stake
    /// to the site's Holding (bit 1) or to `src` (bit 2), releases an owed
    /// slot to the actor's Citizen with its funder (bit 5, D-6), and after
    /// `end_bell` settles every lapsed siege.
    #[tokio::test]
    async fn cq_settle_siege_stakes_slots_and_season_end() {
        let mut e = env(&["settle"], 1_008);
        let mut c = ConquestDuty::default();
        let aw = Address::new_from_array([0xA1; 32]);
        let actor = e.addrs.citizen(&aw);
        let funder = Address::new_from_array([0xF1; 32]);
        let src_key = fclient::addr::host_id(2, 0, 4, 0, 0).unwrap();
        e.put(
            e.addrs.holding(2, 0, 4),
            testkit::holding_v2(2, 0, 4, 0, actor, funder, None),
        );
        e.put(actor, testkit::citizen_v2(2, 1, funder));
        let mut pd = testkit::province_v2(3, 0, 300);
        let tag_a = fclient::addr::citizen_tag_u64(&actor);
        // Site 1: stake owed to the site's holding. Site 2: stake to src and
        // a slot owed back. Site 3: a running capture siege (slot 3).
        CqRecord {
            flags: cr::FLAG_STAKE_TO_HOLDING,
            faction: 2,
            ..CqRecord::ZERO
        }
        .write(&mut pd, 1)
        .unwrap();
        CqRecord {
            flags: cr::FLAG_STAKE_TO_SRC | cr::FLAG_SLOT_OWED,
            faction: 2,
            required: 2,
            actor: tag_a,
            src: src_key,
            ..CqRecord::ZERO
        }
        .write(&mut pd, 2)
        .unwrap();
        CqRecord {
            kind: cr::KIND_SIEGE,
            faction: 2,
            target: cr::target(cr::TARGET_OTHER, 3),
            required: 60,
            bell: 990,
            actor: tag_a,
            src: src_key,
            ..CqRecord::ZERO
        }
        .write(&mut pd, 3)
        .unwrap();
        c.observe((3, 0), &pd, 300, 0, 1);
        e.conquest(
            &mut c,
            20,
            after_close(300),
            &BTreeMap::new(),
            &BTreeSet::new(),
        )
        .await;
        let k1 = e.keys("ssiege:3,0:1:");
        let k2 = e.keys("ssiege:3,0:2:");
        assert_eq!((k1.len(), k2.len()), (1, 1));
        assert!(
            e.keys("ssiege:3,0:3:").is_empty(),
            "a running siege: not before the end"
        );
        let (class, tg, i1) = e.preview(&k1[0]);
        assert_eq!((class, tg), (Class::N, tag::SETTLE_SIEGE));
        assert_eq!(i1[0].accounts[3].pubkey, e.addrs.holding(3, 0, 1));
        assert_eq!(i1[0].accounts.len(), 5, "no slot owed: no funder");
        let (_, _, i2) = e.preview(&k2[0]);
        assert_eq!(i2[0].accounts[3].pubkey, e.addrs.holding(2, 0, 4));
        assert_eq!(i2[0].accounts[4].pubkey, actor);
        assert_eq!(i2[0].accounts[5].pubkey, funder, "D-6 escrow refund");
        // After end_bell the lapsed siege settles to src with its slot.
        e.engine.cancel(&k1[0]);
        e.engine.cancel(&k2[0]);
        e.conquest(
            &mut c,
            30,
            after_close(1_008),
            &BTreeMap::new(),
            &BTreeSet::new(),
        )
        .await;
        let k3 = e.keys("ssiege:3,0:3:");
        assert_eq!(k3.len(), 1);
        let (_, _, i3) = e.preview(&k3[0]);
        assert_eq!(i3[0].accounts[3].pubkey, e.addrs.holding(2, 0, 4));
        assert_eq!(i3[0].accounts[4].pubkey, actor);
    }

    /// MC §8.2 "March folds" and R-23: FoldMarch from `next_hour` (or the
    /// first hour when the MarchState is absent) over every hour whose
    /// members resolved past it (≤ 6); a laggard holds the fold, and once
    /// the unfolded hour is ≥ 3 game hours old the laggard, idle, is
    /// skipped at once by the play duty (fold-driven skip).
    #[tokio::test]
    async fn cq_fold_march_folds_ready_hours_and_skips_laggards() {
        let mut e = env(&["fold", "skip", "gather", "resolve"], 1_008);
        let (m, n) = frontier_abi::v2::addr::march_of(3, 0);
        let members = frontier_abi::v2::addr::march_members(m, n);
        let (a, b) = (members[0], members[1]);
        let (pa, pb) = ((a.0 as i16, a.1 as i16), (b.0 as i16, b.1 as i16));
        let mut da = testkit::province_v2(pa.0, pa.1, 61);
        let mut db = testkit::province_v2(pb.0, pb.1, 25);
        let prm = cm::StepParams {
            genesis_ts: G,
            end_bell: 1_008,
            cq: e.season.conquest.unwrap(),
        };
        // Snapshots through the model (bells 0, 6, …).
        for bb in (0..61).step_by(6) {
            cm::step(&mut da, bb, &Default::default(), &prm).unwrap();
        }
        for bb in (0..25).step_by(6) {
            cm::step(&mut db, bb, &Default::default(), &prm).unwrap();
        }
        let mut c = ConquestDuty::default();
        c.observe(pa, &da, 61, 0, 1);
        c.observe(pb, &db, 25, 0, 1);
        let opened: BTreeSet<(i16, i16)> = [pa, pb].into_iter().collect();
        // No MarchState: the first fold starts at hour 0 and takes the
        // hours both members passed (b resolved through bell 24: hours 0–4).
        e.conquest(&mut c, 10, after_close(62), &BTreeMap::new(), &opened)
            .await;
        let k = format!("fmarch:{m},{n}:0");
        let (class, tg, ix) = e.preview(&k);
        assert_eq!((class, tg), (Class::D, tag::FOLD_MARCH));
        let f = frontier_abi::v2::ix::FoldMarch::decode(&ix[0].data).unwrap();
        assert_eq!((f.hour, f.count), (0, 5));
        assert_eq!(ix[0].accounts[2].pubkey, e.addrs.march_state(m, n));
        assert!(c.fold_urgent.is_empty());
        // Landed: next_hour 5; hour 5 waits for b (resolved through 24).
        e.engine.cancel(&k);
        c.on_outcome(
            &k,
            &Outcome::Landed {
                slot: 12,
                sig: Default::default(),
                payer: Address::default(),
                versions: 1,
                first_slot: 10,
                already_done: false,
            },
            62,
            None,
        );
        assert_eq!(c.stats.hours_folded, 5);
        e.put(
            e.addrs.march_state(m, n),
            testkit::march_state(m, n, 5, Address::new_from_array([3; 32])),
        );
        e.conquest(&mut c, 14, after_close(62), &BTreeMap::new(), &opened)
            .await;
        assert!(e.keys("fmarch:").is_empty(), "hour 5 waits for the laggard");
        // Hour 5 ended at bell 36; at bell 54 it is 3 hours old: b skips now.
        e.conquest(&mut c, 16, after_close(54), &BTreeMap::new(), &opened)
            .await;
        assert_eq!(c.fold_urgent.iter().copied().collect::<Vec<_>>(), vec![pb]);
        let mut d = PlayDuty::default();
        d.conquest = c;
        e.put(e.addrs.province(b.0, b.1), db.clone());
        let rg = fclient::ix::region_of(b.0, b.1);
        for bb in 25..60 {
            e.anchor(bb, rg);
        }
        // Only 5 bells closed past 25 would not batch; fold-driven goes now.
        e.play(&mut d, 20, after_close(29), &[b]).await;
        assert_eq!(
            e.keys("skip:"),
            vec![format!("skip:{},{}:25:5", pb.0, pb.1)]
        );
        assert_eq!(d.conquest.stats.fold_skips, 1);
    }

    /// MC §8.2 horn watcher: an MC record from the feed puts its Province
    /// at the front (read at once, planned first), counts the horn, and
    /// alerts above [`HORN_ALERT_PER_BELL`] horns in a bell.
    #[test]
    fn cq_horn_watcher_fronts_counts_and_alerts() {
        use frontier_abi::v2::log as l2;
        let mut pl = l2::ConquestPayload {
            events: [l2::Event::default(); l2::CONQUEST_EVENTS_MAX],
            n: 1,
            records_digest: [0; 32],
            keep_holder: 2,
            keep_contender: 4,
            keep_progress: 1,
            keep_troops: 0,
            donor_host_id: 0,
            snapshot: None,
        };
        pl.events[0] = l2::Event {
            site: l2::event::KEEP_SITE,
            code: l2::event::KEEP_CONTEST,
            faction: 4,
            progress: 1,
        };
        let mut kp = l2::conquest_key(3, 0, 77).to_vec();
        kp.extend_from_slice(&pl.to_bytes());
        let body = fclient::log::chain(1, 82, 77, &kp, &[(6, 0, [0; 32])]).encode();
        let mut idx = crate::playindex::PlayIndex::default();
        idx.ingest(&body, 9);
        assert_eq!(idx.bad, 0);
        assert!(idx.touched.contains(&(3, 0)));
        let j = crate::journal::Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut c = ConquestDuty::default();
        for (slot, log) in std::mem::take(&mut idx.cq_logs) {
            c.on_log(&log, slot, Some(&j));
        }
        assert!(c.front.contains(&(3, 0)));
        assert_eq!(c.stats.horns.get("KEEP_CONTEST"), Some(&1));
        assert_eq!(
            j.conquest_rows("KEEP_CONTEST").unwrap(),
            vec![(9, Some(77), "3,0".into())]
        );
        assert_eq!(c.status(Some(78))["horns_last_bell"], 1);
        // A storm: one alert once the bell passes the rate.
        let log = fclient::conquest::parse(&body).unwrap();
        for _ in 0..HORN_ALERT_PER_BELL + 5 {
            c.on_log(&log, 10, None);
        }
        assert_eq!(c.alerts.len(), 1);
        // A land index ignores MC records (no `bad`).
        let mut li = crate::landindex::LandIndex::default();
        li.ingest(&body, 9, &Addresses::new(program(), 7));
        assert_eq!(li.bad, 0);
    }

    /// MC §8.2 season-end flush (K-27): after `end_bell`, RetireHost
    /// (class N, any actor) for every host of a captured site's previous
    /// generation still on a Province, naming the victim Citizen (the
    /// owner of `prev_home`) and both Holdings. A host of the current
    /// generation stays.
    #[tokio::test]
    async fn cq_season_end_retires_previous_generation_hosts() {
        let mut e = env(&["settle"], 1_008);
        let mut c = ConquestDuty::default();
        let vw = Address::new_from_array([0xD3; 32]);
        let victim = e.addrs.citizen(&vw);
        let home_key = fclient::addr::host_id(1, 0, 2, 0, 0).unwrap();
        e.put(
            e.addrs.holding(1, 0, 2),
            testkit::holding_v2(1, 0, 2, 0, victim, vw, None),
        );
        let captor = e.addrs.citizen(&Address::new_from_array([0xC3; 32]));
        e.put(
            e.addrs.holding(3, 0, 6),
            testkit::holding_v2(
                3,
                0,
                6,
                2,
                captor,
                vw,
                Some((fclient::addr::citizen_tag_u64(&victim), 1, home_key)),
            ),
        );
        c.captured_sites.insert((3, 0, 6));
        let old = fclient::addr::host_id(3, 0, 6, 1, 4).unwrap();
        let new = fclient::addr::host_id(3, 0, 6, 2, 5).unwrap();
        let mut pd = testkit::province_v2(4, 0, 1_008);
        testkit::set_entry(&mut pd, 2, old, 1, 0, 11, 500_000);
        testkit::set_entry(&mut pd, 3, new, 3, 0, 12, 500_000);
        c.observe((4, 0), &pd, 1_008, 0, 1);
        e.conquest(
            &mut c,
            20,
            after_close(1_000),
            &BTreeMap::new(),
            &BTreeSet::new(),
        )
        .await;
        assert!(e.keys("retire:").is_empty(), "not during the season");
        e.conquest(
            &mut c,
            21,
            after_close(1_008),
            &BTreeMap::new(),
            &BTreeSet::new(),
        )
        .await;
        assert_eq!(e.keys("retire:"), vec![format!("retire:4,0:2:{old}")]);
        let (class, tg, ix) = e.preview(&format!("retire:4,0:2:{old}"));
        assert_eq!((class, tg), (Class::N, tag::RETIRE_HOST));
        let acc: Vec<Address> = ix[0].accounts.iter().map(|m| m.pubkey).collect();
        assert_eq!(acc[3], victim);
        assert_eq!(acc[4], e.addrs.province(4, 0));
        assert_eq!(acc[5], e.addrs.holding(3, 0, 6));
        assert_eq!(acc[6], e.addrs.holding(1, 0, 2));
        assert_eq!(ix[0].data, vec![tag::RETIRE_HOST, 2]);
    }

    /// MC §8.2 "Closes": CloseMarch (class N) from `end + 72 h` for a
    /// present MarchState, its rent to `rent_to`; an absent one is done.
    #[tokio::test]
    async fn cq_close_march_after_end_plus_72h() {
        let mut e = env(&["close"], 1_008);
        let mut c = ConquestDuty::default();
        let rent_to = Address::new_from_array([0x77; 32]);
        e.put(
            e.addrs.march_state(0, 0),
            testkit::march_state(0, 0, 168, rent_to),
        );
        c.marches.insert((0, 0), MarchView::default());
        c.marches.insert((1, 0), MarchView::default());
        let end = G + 1_008 * BELL;
        for (slot, now, want) in [(5u64, end + 71 * 3_600, 0usize), (6, end + 72 * 3_600, 1)] {
            e.port.set_clock(slot, now);
            let t = Tick {
                slot,
                now,
                season: &e.season,
                clock: SeasonClock::from_season(&e.season),
                addrs: &e.addrs,
                cfg: &e.cfg,
            };
            c.housekeeping(&t, &e.port, &mut e.engine).await.unwrap();
            assert_eq!(e.keys("cmarch:").len(), want, "{now}");
        }
        let (class, tg, ix) = e.preview("cmarch:0,0");
        assert_eq!((class, tg), (Class::N, tag::CLOSE_MARCH));
        assert_eq!(ix[0].accounts[2].pubkey, e.addrs.march_state(0, 0));
        assert_eq!(ix[0].accounts[3].pubkey, rent_to);
        assert!(c.marches[&(1, 0)].closed, "absent: nothing to close");
    }

    /// R-22: an M1 season and an M1 Province plan nothing here (the M1
    /// keeper is unchanged); an MC Province in an M1 season is not read
    /// as one either.
    #[tokio::test]
    async fn cq_m1_season_plans_no_conquest_write() {
        let mut e = env(&["settle", "fold", "close"], 1_008);
        e.season = testkit::season(G, 1_008, &e.drand.key.info());
        let mut c = ConquestDuty::default();
        let mut pd = testkit::province_v2(3, 0, 300);
        CqRecord {
            kind: cr::KIND_CAPTURE_DUE,
            ..CqRecord::ZERO
        }
        .write(&mut pd, 1)
        .unwrap();
        c.observe((3, 0), &pd, 300, 0, 1);
        e.conquest(
            &mut c,
            5,
            after_close(300),
            &BTreeMap::new(),
            &[(3, 0)].into_iter().collect(),
        )
        .await;
        assert_eq!(e.engine.pending_len(), 0);
        // A v1 Province has no conquest view.
        let v1 = testkit::province(300, &[]);
        assert!(!c.observe((3, 0), &v1, 300, 0, 1));
        assert!(c.provs.is_empty());
    }
}
