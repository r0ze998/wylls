//! The herald's conquest fold (MC contract §8.4, §6; unit CQ2-E).
//!
//! **Where it runs.** [`crate::fold::Fold::apply`] calls three entry
//! points from its `// MC hook` blocks (§4.5), and nothing else of the M1
//! fold changes:
//!
//! | hook | entry | what |
//! |---|---|---|
//! | the record loop | [`on_record`] | a PS2 body of kind 80–89 (decoded with `frontier_abi::v2::log`): numbered as an `/h/events` event, sent as a WS `event`, folded into the conquest state (sieges, keeps, folds, tallies, the day's events, alerts) |
//! | before the per-bell closing | [`after_records`] | every province-bell the transaction closed in a Province v2: its bytes after the bell (the post-state for a single bell; for a SkipQuiet run, **replayed bell by bell with `conquest_model`** from the bytes before: `report_quiet → settle_bell → step → finish_bell`), the CONQUEST records digest checked against them (`conquest_mismatch`), and a [`View`] kept until its files are written |
//! | after the per-bell closing | [`complete`] | **completeness**: when every opened province has resolved or skipped through bell b (M1's overview rule), bell b's `PSFCT1` (`/h/control/{b}.bin`), `/h/sieges/{b}.json`, the WS `control` and `siege` deltas; `PSFOV2` beside each `PSFOV1` written; day files, the standings hour, Herald's Call, and `final.json` after EndSeason |
//!
//! **Version dispatch (R-22).** An M1 season never turns the conquest
//! state on (no v2 record, no v2 Province, `program_version` 1), so every
//! M1 file, WS message and checkpoint stays byte-identical.
//!
//! **Determinism.** Only the archive is read (ordered maps, fixed JSON,
//! no clock); the whole state is checkpointed beside the M1 fold's
//! ([`Cq::to_json`]), so a restart re-folds to the same bytes.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use fclient::ports::TxRecord;
use frontier_abi::bytes::{rd_i32, rd_u16, rd_u32, rd_u64, rd_u8};
use frontier_abi::clash_model as cm;
use frontier_abi::conquest_model::{self as qm, StepParams};
use frontier_abi::v2::layout::province::{keep as KP, province as P};
use frontier_abi::v2::layout::world::season as SE;
use frontier_abi::v2::log::{
    self as v2log, capture_outcome, event, AnyKind, ConquestPayload, CqKind, Event,
};
use permutation_rules::frontier::control::{self, ControlMap, MapProvince};
use permutation_rules::frontier::geometry::{MarchCoord, ProvinceCoord};

use crate::control::{self as ctl, is_v2_province, View};
use crate::cqfmt::{
    self as fmt, tag_hex, CallFile, ConquestDay, ConquestEvent, ContestOutcome, ContestRec,
    ControlFile, EventKind, FinalFile, HoldingContest, KeepCapture, KeepHistory, Overview2File,
    Overview2Record, RecordRef, SiegeBell, SiegeDelta, SiegeEnd, SiegeHistory, SiegeKind,
    SiegeOutcome, SiegesFile, StandingsSeries, Title,
};
use crate::fold::{Diff, Fold, Scope};
use crate::OVERVIEW_RECORD;

/// Alerts kept per wallet for `/h/me` (newest last).
pub const ALERTS_PER_WALLET: usize = 32;
/// Control bells a day file waits after its last bell, so that MARCH_FOLD
/// records (folded up to 5 game hours late, R-23) and other late records
/// of the day still land in it before it becomes immutable.
pub const DAY_GRACE_BELLS: u32 = 36;
/// Control bells a standings hour waits for its March folds before it is
/// written with the folds known (a held MarchState must not stall it).
pub const HOUR_FOLD_WAIT_BELLS: u32 = 72;
/// Bells of banner history the Rally reads (§3.10: 2 days).
pub const RALLY_BELLS: u32 = 2 * 144;
/// Bells closed at most per transaction (M1's `MAX_CLOSE`).
const MAX_STEP: u32 = 4_096;

/// Tally rows (per event bell, per faction).
pub const T_KEEPS_TAKEN: usize = 0;
pub const T_KEEPS_LOST: usize = 1;
pub const T_CAPTURES: usize = 2;
pub const T_SIEGES_WON: usize = 3;
pub const T_SIEGES_LOST: usize = 4;
pub const T_LIBERATIONS: usize = 5;
pub const TALLY_N: usize = 6;

/// The conquest fold's alarms (`/h/status/conquest`); never fatal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CqAlarms {
    /// A CONQUEST record whose records digest (or keep fields) differs
    /// from the herald's bytes of that bell (§8.4 `conquest_mismatch`).
    pub conquest_mismatch: u64,
    /// A bell that had to log CONQUEST (a live record or contest, a
    /// snapshot bell) logged none.
    pub conquest_missing: u64,
    /// A comparison the source cannot make exact (RPC post-state).
    pub conquest_unchecked: u64,
    /// A SkipQuiet run the model could not replay (its post-state used).
    pub replay_errors: u64,
    /// An MC body that did not decode, or a payload of the wrong size.
    pub bad_records: u64,
    /// A file the format refused to encode (a herald bug; not written).
    pub format_errors: u64,
    /// An event of a day already written (the file was rewritten).
    pub late_events: u64,
}

/// One March's Dominion as the folds report it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MarchDom {
    /// The last fold's controller (0–6; 0xFF none or contested).
    pub controller: u8,
    pub folded: bool,
}

/// The folds of one hour: control-bells credited per faction and the
/// Marches folded.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FoldHour {
    pub dom: [u32; 6],
    pub marches: BTreeSet<(i32, i32)>,
}

/// An hour's map figures, taken at its last control bell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HourSnap {
    pub bell: u32,
    pub provinces: [u16; 6],
    pub banners: [u16; 6],
    pub holdings: [u16; 6],
    pub occupations: [u16; 6],
}

/// What the season account says (an MC season only).
#[derive(Clone, Copy, Debug)]
pub struct SeasonInfo {
    pub prm: StepParams,
    pub end_bell: u32,
    pub genesis_seed: [u8; 32],
    pub ended: bool,
}

/// The conquest state (checkpointed with the fold).
#[derive(Clone, Debug, Default)]
pub struct Cq {
    /// An MC season: something v2 was seen.
    pub on: bool,
    pub alarms: CqAlarms,
    /// Province-bell views awaiting their control and overview v2 files.
    pub views: BTreeMap<(i16, i16, u32), View>,
    /// The CONQUEST record of a province-bell: `(seq, sig)`.
    pub srcs: BTreeMap<(i16, i16, u32), (u64, String)>,
    /// A province's last CONQUEST or KEEP record.
    pub last_src: BTreeMap<(i16, i16), (u64, String)>,
    /// Next control bell to write.
    pub ct_next: Option<u32>,
    /// Next overview v2 bell per ring.
    pub ov2_next: BTreeMap<u16, u32>,
    pub prev_ct: Option<ControlFile>,
    pub prev_sieges: Option<SiegesFile>,
    /// Next day file to write.
    pub day_next: u32,
    /// Events of the days not yet written (and of later ones).
    pub days: BTreeMap<u32, Vec<ConquestEvent>>,
    /// Every siege of the season.
    pub sieges: BTreeMap<(i16, i16, u8, u32), SiegeHistory>,
    /// The latest siege declared on a site.
    pub site_siege: BTreeMap<(i16, i16, u8), u32>,
    pub keeps: BTreeMap<(i16, i16), KeepHistory>,
    pub keeps_dirty: BTreeSet<(i16, i16)>,
    pub marches: BTreeMap<(i32, i32), MarchDom>,
    /// Marches whose Dominion lead changed since the last control file.
    pub lead_changed: BTreeSet<(i32, i32)>,
    pub fold_hours: BTreeMap<u32, FoldHour>,
    /// Faction tallies per event bell (rows `T_*`).
    pub tally: BTreeMap<u32, [[u16; 6]; TALLY_N]>,
    pub hour_snaps: BTreeMap<u32, HourSnap>,
    pub series: Option<StandingsSeries>,
    /// Faction banners per March: `(bell, faction)` at each change.
    pub banner_hist: BTreeMap<(i32, i32), Vec<(u32, u8)>>,
    /// The current day's Call.
    pub call: Option<CallFile>,
    /// Per player: keeps taken, keep-bells, sieges won, captures, liberations.
    pub players: BTreeMap<u64, [u32; 5]>,
    pub alerts: BTreeMap<[u8; 32], Vec<Value>>,
    pub contest: HoldingContest,
    pub first_transferred: u32,
    pub final_done: bool,
    // ---- per transaction / rebuilt from accounts (not checkpointed)
    tx_seq: u64,
    tx_conquest: BTreeMap<(i16, i16, u32), (ConquestPayload, u64, String)>,
    /// Citizen tag → (wallet, faction).
    tags: BTreeMap<u64, ([u8; 32], u8)>,
    tags_built: bool,
}

// ------------------------------------------------------------------ small helpers

pub(crate) fn kind_v1(d: &[u8]) -> Option<frontier_abi::layout::AccountKind> {
    frontier_abi::layout::AccountKind::from_magic(d.get(..8)?.try_into().ok()?)
}

/// The season figures of an MC Season (`None` for M1 or before capture).
pub fn season_info(f: &Fold) -> Option<SeasonInfo> {
    let s = f.account(&f.ctx.season)?;
    let d = &s.data;
    if rd_u16(d, SE::PROGRAM_VERSION)? != SE::PROGRAM_VERSION_V2 {
        return None;
    }
    let prm = StepParams::of_season(d)?;
    let status = rd_u8(d, SE::STATUS)?;
    Some(SeasonInfo {
        prm,
        end_bell: prm.end_bell,
        genesis_seed: d
            .get(SE::GENESIS_SEED..SE::GENESIS_SEED + 32)?
            .try_into()
            .ok()?,
        ended: status == SE::STATUS_ENDED || status == SE::STATUS_CLOSED,
    })
}

/// The citizen tag of a Holding's owner (`OWNER_CITIZEN`'s first 8 bytes).
fn holding_owner_tag(f: &Fold, p: i32, q: i32, site: u8) -> Option<u64> {
    use frontier_abi::layout::player::holding as HL;
    let c = f.account(&f.ctx.holding(p, q, site))?;
    let t = rd_u64(&c.data, HL::OWNER_CITIZEN)?;
    (t != 0).then_some(t)
}

/// The owner tag of the Holding that issued host `id`.
fn host_owner_tag(f: &Fold, id: u64) -> Option<u64> {
    let h = frontier_abi::addr::split_host_id(id)?;
    holding_owner_tag(f, h.province.p, h.province.q, h.site)
}

fn sig_of(tx: &TxRecord) -> String {
    tx.signature.to_string()
}

fn record_key(kind: CqKind, key: &[u8]) -> String {
    let spec = kind.spec();
    let mut parts = vec![];
    let mut o = 0;
    for (n, w) in spec.key {
        let v = match (*n, *w) {
            ("p" | "q" | "m" | "n", 4) => rd_i32(key, o).map(|x| x.to_string()),
            (_, 1) => rd_u8(key, o).map(|x| x.to_string()),
            (_, 4) => rd_u32(key, o).map(|x| x.to_string()),
            (_, 8) => rd_u64(key, o).map(|x| x.to_string()),
            _ => None,
        };
        parts.push(v.unwrap_or_default());
        o += w;
    }
    format!("{}:{}", spec.name, parts.join(","))
}

/// A decoded MC record as JSON (`/h/events` `decoded`; display only).
pub fn record_json(body: &[u8]) -> Option<Value> {
    let r = v2log::decode(body).ok()?;
    let AnyKind::Cq(k) = r.kind else {
        return None;
    };
    let spec = k.spec();
    let fields = |list: &[(&str, usize)], b: &[u8]| -> Value {
        let mut m = serde_json::Map::new();
        let mut o = 0;
        for (n, w) in list {
            if let Some(s) = b.get(o..o + w) {
                let v = match (*n, s.len()) {
                    ("p" | "q" | "m" | "n", 4) => json!(rd_i32(s, 0)),
                    (_, 1) => json!(s[0]),
                    (_, 2) => json!(rd_u16(s, 0)),
                    (_, 4) => json!(rd_u32(s, 0)),
                    (_, 8) => json!(rd_u64(s, 0).map(|x| x.to_string())),
                    _ => json!(hex::encode(s)),
                };
                m.insert((*n).into(), v);
            }
            o += w;
        }
        Value::Object(m)
    };
    let links: Vec<Value> = r
        .links
        .iter()
        .take(r.n_links)
        .flatten()
        .map(|l| json!({"entity": l.entity as u8, "seq": l.seq.to_string(), "head": hex::encode(l.head)}))
        .collect();
    Some(json!({
        "kind": k as u8, "name": spec.name, "bell": r.bell,
        "key": fields(spec.key, r.key), "payload": fields(spec.payload, r.payload), "links": links,
    }))
}

impl Cq {
    fn take(f: &mut Fold) -> Cq {
        std::mem::take(&mut f.cq)
    }

    /// Citizen tags → wallet and faction, from every captured Citizen.
    fn index_tags(&mut self, f: &Fold, tx: Option<&TxRecord>) {
        use frontier_abi::layout::player::citizen as C;
        let mut add = |d: &[u8]| {
            if kind_v1(d) != Some(frontier_abi::layout::AccountKind::Citizen) {
                return;
            }
            if let (Some(tag), Some(w), Some(fac)) = (
                rd_u64(d, C::CITIZEN_TAG),
                d.get(C::WALLET..C::WALLET + 32)
                    .and_then(|x| <[u8; 32]>::try_from(x).ok()),
                rd_u8(d, C::FACTION),
            ) {
                if tag != 0 {
                    self.tags.insert(tag, (w, fac));
                }
            }
        };
        if !self.tags_built {
            for c in f.st.accounts.values() {
                add(&c.data);
            }
            self.tags_built = true;
        } else if let Some(tx) = tx {
            for a in tx.post.iter().filter_map(|(_, a)| a.as_ref()) {
                add(&a.data);
            }
        }
    }

    pub(crate) fn faction_of_tag(&self, tag: u64) -> Option<u8> {
        self.tags.get(&tag).map(|x| x.1).filter(|&x| x < 6)
    }

    fn tally(&mut self, bell: u32, row: usize, faction: u8) {
        if (faction as usize) < 6 {
            let t = self.tally.entry(bell).or_insert([[0; 6]; TALLY_N]);
            t[row][faction as usize] = t[row][faction as usize].saturating_add(1);
        }
    }

    fn player(&mut self, tag: u64, i: usize) {
        if tag != 0 {
            let r = self.players.entry(tag).or_insert([0; 5]);
            r[i] = r[i].saturating_add(1);
        }
    }

    fn event(&mut self, e: ConquestEvent, written_through: u32) {
        let day = e.bell / fmt::BELLS_PER_DAY;
        if day < written_through {
            // The day's file is written and served `immutable`: a late
            // event is counted (an alarm), never merged into it.
            self.alarms.late_events += 1;
            return;
        }
        self.days.entry(day).or_default().push(e);
    }

    fn alert(&mut self, f: &mut Fold, tag: u64, v: Value, slot: u64) {
        let Some(&(w, _)) = self.tags.get(&tag) else {
            return;
        };
        let bytes = serde_json::to_vec(&v).unwrap_or_default();
        let a = self.alerts.entry(w).or_default();
        a.push(v);
        if a.len() > ALERTS_PER_WALLET {
            let n = a.len() - ALERTS_PER_WALLET;
            a.drain(..n);
        }
        f.diffs.push(Diff {
            kind: "alert",
            key: format!("/h/me/{}", solana_address::Address::new_from_array(w)),
            slot,
            head: None,
            bytes,
            scope: Scope::Wallet(w),
            t_ms: 0,
            wire: Default::default(),
        });
    }

    fn track_mut(&mut self, p: i16, q: i16, site: u8) -> Option<&mut SiegeHistory> {
        let d = *self.site_siege.get(&(p, q, site))?;
        self.sieges.get_mut(&(p, q, site, d))
    }
}

// ------------------------------------------------------------------ hook 1: records

/// The record-loop hook: `true` when `body` is an MC record (kinds 80–89)
/// and was folded here; `false` sends it down M1's path unchanged.
pub fn on_record(f: &mut Fold, tx: &TxRecord, body: &[u8]) -> bool {
    let Ok(r) = v2log::decode(body) else {
        // An undecodable body of an MC kind is counted here, not as M1's.
        if body.len() >= 2 && (80..=89).contains(&body[1]) {
            f.st.alarms.bad_records += 1;
            f.cq.alarms.bad_records += 1;
            return true;
        }
        return false;
    };
    let AnyKind::Cq(kind) = r.kind else {
        return false;
    };
    let mut cq = Cq::take(f);
    cq.on = true;
    if cq.tx_seq != tx.seq {
        cq.tx_seq = tx.seq;
        cq.tx_conquest.clear();
        cq.index_tags(f, Some(tx));
    }
    f.st.events += 1;
    let seq = f.st.events;
    let sig = sig_of(tx);
    let pq = (rd_i32(r.key, 0).unwrap_or(0), rd_i32(r.key, 4).unwrap_or(0));
    let scope = match kind {
        CqKind::MARCH_FOLD => Scope::None,
        CqKind::RETIRE => rd_u64(r.key, 0)
            .and_then(frontier_abi::addr::split_host_id)
            .map_or(Scope::None, |h| Scope::Province(h.province.p, h.province.q)),
        _ => Scope::Province(pq.0, pq.1),
    };
    f.diffs.push(Diff {
        kind: "event",
        key: record_key(kind, r.key),
        slot: tx.slot,
        head: None,
        bytes: body.to_vec(),
        scope,
        t_ms: 0,
        wire: Default::default(),
    });
    fold_record(&mut cq, f, tx, kind, &r, seq, &sig);
    f.cq = cq;
    true
}

fn pay<'a>(r: &v2log::Record<'a>, name: &str) -> Option<&'a [u8]> {
    let (o, w) = v2log::field(r.kind, name, true)?;
    r.payload.get(o..o + w)
}
fn p8(r: &v2log::Record<'_>, n: &str) -> u8 {
    pay(r, n).map_or(0, |b| b[0])
}
fn p32(r: &v2log::Record<'_>, n: &str) -> u32 {
    pay(r, n).and_then(|b| rd_u32(b, 0)).unwrap_or(0)
}
fn p64(r: &v2log::Record<'_>, n: &str) -> u64 {
    pay(r, n).and_then(|b| rd_u64(b, 0)).unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
fn ev(
    seq: u64,
    bell: u32,
    sig: &str,
    kind: EventKind,
    pq: Option<(i32, i32)>,
    site: Option<u8>,
    from: Option<u8>,
    to: Option<u8>,
    citizens: Vec<u64>,
    detail: Value,
) -> ConquestEvent {
    ConquestEvent {
        seq,
        bell,
        sig: sig.to_string(),
        kind,
        p: pq.map(|x| x.0),
        q: pq.map(|x| x.1),
        site,
        march: None,
        from: from.map(|x| x.min(7)),
        to: to.map(|x| x.min(7)),
        citizens: citizens.into_iter().filter(|&t| t != 0).collect(),
        detail,
    }
}

fn fold_record(
    cq: &mut Cq,
    f: &mut Fold,
    tx: &TxRecord,
    kind: CqKind,
    r: &v2log::Record<'_>,
    seq: u64,
    sig: &str,
) {
    let (p, q) = (rd_i32(r.key, 0).unwrap_or(0), rd_i32(r.key, 4).unwrap_or(0));
    let (p16, q16) = (p as i16, q as i16);
    // The bell this record is about. A CONQUEST record's step bell is in
    // its key (`P, Q, bell`, §6); its header bell is the landing bell
    // (`bell_log`, M1 §6's "current bell"), which differs for a SkipQuiet
    // run and for any resolve landing after the bell's end. Every other
    // MC record is about the bell it was logged at.
    let b = if kind == CqKind::CONQUEST {
        rd_u32(r.key, 8).unwrap_or(r.bell)
    } else {
        r.bell
    };
    let wt = cq.day_next;
    let rref = |kind: &str, detail: Value| RecordRef {
        kind: kind.into(),
        bell: b,
        seq,
        sig: sig.to_string(),
        detail,
    };
    match kind {
        CqKind::SIEGE_DECLARED => {
            let site = rd_u8(r.key, 8).unwrap_or(0);
            let target = p8(r, "target");
            let tk = frontier_abi::v2::layout::province::conquest::target_kind(target);
            let free = tk == frontier_abi::v2::layout::province::conquest::TARGET_FREE_CITY;
            let attacker = p8(r, "attacker");
            let owner_faction = if free { 6 } else { p8(r, "owner_faction") };
            let declarer = p64(r, "declarer_tag");
            let owner = p64(r, "owner_tag");
            let detail = json!({
                "required": p8(r, "required"), "stake": p32(r, "stake"), "target": target,
                "srcKey": p64(r, "src_key").to_string(), "leadHost": p64(r, "lead_host_id").to_string(),
                "vigil": {"start": pay(r, "vigil_start").and_then(|x| rd_u16(x, 0)),
                          "next": pay(r, "vigil_next").and_then(|x| rd_u16(x, 0)),
                          "fromDay": pay(r, "vigil_from_day").and_then(|x| rd_u16(x, 0))},
            });
            let h = SiegeHistory {
                p,
                q,
                site,
                declared: b,
                kind: match tk {
                    frontier_abi::v2::layout::province::conquest::TARGET_FIRST => SiegeKind::First,
                    _ if free => SiegeKind::Free,
                    _ => SiegeKind::Other,
                },
                owner: (!free).then_some(owner),
                owner_faction,
                attacker: declarer,
                attacker_faction: attacker,
                required: p8(r, "required").clamp(1, 60),
                horn: rref("siege_declared", detail.clone()),
                series: vec![],
                end: None,
                followed: vec![],
            };
            cq.sieges.insert((p16, q16, site, b), h);
            cq.site_siege.insert((p16, q16, site), b);
            cq.contest.sieges_declared += 1;
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    EventKind::SiegeDeclared,
                    Some((p, q)),
                    Some(site),
                    Some(owner_faction),
                    Some(attacker),
                    vec![declarer, owner],
                    detail,
                ),
                wt,
            );
            if !free {
                let a = json!({"v": 1, "kind": "horn", "bell": b, "p": p, "q": q, "site": site,
                    "faction": attacker, "seq": seq.to_string(), "sig": sig});
                cq.alert(f, owner, a, tx.slot);
            }
        }
        CqKind::SIEGE_SETTLED => {
            let site = rd_u8(r.key, 8).unwrap_or(0);
            let d = json!({"reason": p8(r, "reason"), "recipientKey": p64(r, "recipient_key").to_string(),
                "amount": p32(r, "amount"), "burned": p32(r, "burned"), "slotReleased": p8(r, "slot_released")});
            if let Some(t) = cq.track_mut(p16, q16, site) {
                t.followed.push(rref("siege_settled", d));
            }
        }
        CqKind::CONQUEST => {
            let Some(pl) = pay(r, "n").and_then(|_| ConquestPayload::from_bytes(r.payload)) else {
                cq.alarms.bad_records += 1;
                return;
            };
            cq.tx_conquest
                .insert((p16, q16, b), (pl, seq, sig.to_string()));
            cq.srcs.insert((p16, q16, b), (seq, sig.to_string()));
            cq.last_src.insert((p16, q16), (seq, sig.to_string()));
            for e in &pl.events[..(pl.n as usize).min(pl.events.len())] {
                conquest_event(cq, f, tx, (p, q), b, e, &pl, seq, sig);
            }
        }
        CqKind::CAPTURE_SETTLED => {
            let site = rd_u8(r.key, 8).unwrap_or(0);
            let free = p8(r, "outcome") == capture_outcome::FREE_CITY;
            let captor = p64(r, "captor_tag");
            let victim = p64(r, "victim_tag");
            let d = json!({"outcome": p8(r, "outcome"), "credited": p8(r, "credited") != 0, "newGen": p8(r, "new_gen"),
                "slot": p8(r, "slot"), "rentMoved": p64(r, "rent_moved").to_string(),
                "bondsRefunded": p64(r, "bonds_refunded").to_string(), "wallsAfter": p32(r, "walls_after")});
            let from = if free {
                Some(6)
            } else {
                cq.faction_of_tag(victim)
            };
            let to = cq.faction_of_tag(captor);
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    EventKind::Captured,
                    Some((p, q)),
                    Some(site),
                    from,
                    to,
                    vec![captor, victim],
                    d.clone(),
                ),
                wt,
            );
            if let Some(t) = cq.track_mut(p16, q16, site) {
                t.followed.push(rref("captured", d));
            }
        }
        CqKind::KEEP => {
            cq.last_src.insert((p16, q16), (seq, sig.to_string()));
            let holder = p8(r, "holder");
            let pd = f.account(&f.ctx.province(p, q)).map(|c| c.data.clone());
            let k = pd.as_deref().and_then(|d| qm::read_keep(d).ok().flatten());
            if let (Some(k), true) = (k, holder < 6) {
                let e = cq.keeps.entry((p16, q16)).or_insert_with(|| KeepHistory {
                    p,
                    q,
                    tile: k.tile,
                    holder,
                    since: k.since_bell,
                    troops: k.troops,
                    gen: k.gen,
                    heartland: k.heartland_safe,
                    holders: vec![(holder, k.since_bell.min(b))],
                    contests: vec![],
                    captures: vec![],
                });
                e.troops = p32(r, "troops");
                e.gen = p32(r, "gen");
                cq.keeps_dirty.insert((p16, q16));
            }
        }
        CqKind::MARCH_FOLD => {
            let hour = rd_u32(r.key, 8).unwrap_or(0);
            let controller = p8(r, "controller");
            let credit = p8(r, "credit");
            let lost = p8(r, "lost") != 0;
            let dph = season_info(f).map_or(6, |s| s.prm.cq.dominion_per_hour) as u32;
            let fh = cq.fold_hours.entry(hour).or_default();
            // One fold per (March, hour): a second record for the same
            // hour (a MarchState re-created after its close, which the
            // program refuses since W2R2-C2) never counts twice
            // (W2R2-C2; the verifier's V-rule flags it).
            if !fh.marches.insert((p, q)) {
                return;
            }
            if !lost && (credit as usize) < 6 {
                fh.dom[credit as usize] = fh.dom[credit as usize].saturating_add(dph);
            }
            let md = cq.marches.entry((p, q)).or_insert(MarchDom {
                controller: 0xFF,
                folded: false,
            });
            let before = md.controller;
            md.folded = true;
            if !lost {
                md.controller = controller;
            }
            if !lost && before != controller {
                cq.lead_changed.insert((p, q));
                let code = |c: u8| if c <= 6 { c } else { 7 };
                let mut e = ev(
                    seq,
                    b,
                    sig,
                    EventKind::MarchPointsLead,
                    None,
                    None,
                    Some(code(before)),
                    Some(code(controller)),
                    vec![],
                    json!({"hour": hour}),
                );
                e.march = Some(MarchCoord { m: p, n: q });
                cq.event(e, wt);
            }
        }
        CqKind::RETIRE => {
            let id = rd_u64(r.key, 0).unwrap_or(0);
            if let Some(h) = frontier_abi::addr::split_host_id(id) {
                let d = json!({"host": id.to_string(), "troops": p32(r, "troops"), "by": p8(r, "by"),
                    "homeKey": p64(r, "home_key").to_string()});
                let tag = holding_owner_tag(f, h.province.p, h.province.q, h.site).unwrap_or(0);
                cq.event(
                    ev(
                        seq,
                        b,
                        sig,
                        EventKind::Retired,
                        Some((h.province.p, h.province.q)),
                        Some(h.site),
                        None,
                        None,
                        vec![tag],
                        d,
                    ),
                    wt,
                );
            }
        }
        CqKind::NEUTRAL => {
            let site = rd_u8(r.key, 8).unwrap_or(0);
            let d = json!({"neutralKind": p8(r, "kind"), "garrison": p32(r, "garrison"), "tier": p8(r, "tier")});
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    EventKind::FreeCity,
                    Some((p, q)),
                    Some(site),
                    None,
                    Some(6),
                    vec![],
                    d,
                ),
                wt,
            );
        }
        CqKind::OUTPOST_SETTLED => {
            let site = rd_u8(r.key, 8).unwrap_or(0);
            let tag = p64(r, "citizen_tag");
            cq.contest.outposts += 1;
            let d = json!({"order": p8(r, "order"), "gen": p8(r, "gen"),
                "shieldUntil": pay(r, "shield_until").and_then(|x| frontier_abi::bytes::rd_i64(x, 0)),
                "anchorKey": p64(r, "anchor_key").to_string()});
            let to = cq.faction_of_tag(tag);
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    EventKind::Outpost,
                    Some((p, q)),
                    Some(site),
                    None,
                    to,
                    vec![tag],
                    d,
                ),
                wt,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn conquest_event(
    cq: &mut Cq,
    f: &mut Fold,
    tx: &TxRecord,
    (p, q): (i32, i32),
    b: u32,
    e: &Event,
    pl: &ConquestPayload,
    seq: u64,
    sig: &str,
) {
    let (p16, q16) = (p as i16, q as i16);
    let code = e.code & !event::DETAIL;
    let detail_bit = e.code & event::DETAIL != 0;
    let wt = cq.day_next;
    let rref = |kind: &str, detail: Value| RecordRef {
        kind: kind.into(),
        bell: b,
        seq,
        sig: sig.to_string(),
        detail,
    };
    if e.site == event::KEEP_SITE {
        let holder = pl.keep_holder;
        match code {
            event::KEEP_CONTEST => {
                let d = json!({"progress": e.progress});
                cq.event(
                    ev(
                        seq,
                        b,
                        sig,
                        EventKind::KeepContest,
                        Some((p, q)),
                        None,
                        Some(holder),
                        Some(e.faction),
                        vec![],
                        d,
                    ),
                    wt,
                );
                // alert every holder of the keep's faction in the province
                let tags: BTreeSet<u64> = f
                    .account(&f.ctx.province(p, q))
                    .map(|c| c.data.clone())
                    .map(|pd| {
                        let n = (pd[P::SITE_COUNT] as usize).min(12);
                        (0..n)
                            .filter(|&s| {
                                let o = P::site(s);
                                pd[o] == frontier_abi::v2::layout::province::site::STATE_HOLDING
                                    && pd[o + 1] == holder
                            })
                            .filter_map(|s| holding_owner_tag(f, p, q, s as u8))
                            .collect()
                    })
                    .unwrap_or_default();
                for t in tags {
                    let a = json!({"v": 1, "kind": "keep_contest", "bell": b, "p": p, "q": q, "site": null,
                        "faction": e.faction, "seq": seq.to_string(), "sig": sig});
                    cq.alert(f, t, a, tx.slot);
                }
            }
            event::KEEP_BROKEN => {
                let d = json!({"progress": e.progress});
                cq.event(
                    ev(
                        seq,
                        b,
                        sig,
                        EventKind::KeepBroken,
                        Some((p, q)),
                        None,
                        Some(e.faction),
                        Some(holder),
                        vec![],
                        d,
                    ),
                    wt,
                );
            }
            event::KEEP_TAKEN => {
                let (to, from) = (e.faction, e.progress);
                let d = json!({"troops": pl.keep_troops, "donor": pl.donor_host_id.to_string()});
                cq.event(
                    ev(
                        seq,
                        b,
                        sig,
                        EventKind::KeepTaken,
                        Some((p, q)),
                        None,
                        Some(from),
                        Some(to),
                        vec![],
                        d,
                    ),
                    wt,
                );
                cq.tally(b, T_KEEPS_TAKEN, to);
                cq.tally(b, T_KEEPS_LOST, from);
            }
            _ => {}
        }
        return;
    }
    let site = e.site;
    let (owner, owner_f, attacker) = match cq
        .site_siege
        .get(&(p16, q16, site))
        .and_then(|d| cq.sieges.get(&(p16, q16, site, *d)))
    {
        Some(t) => (t.owner.unwrap_or(0), t.owner_faction, t.attacker),
        None => (holding_owner_tag(f, p, q, site).unwrap_or(0), 7, 0),
    };
    match code {
        event::SIEGE_FAILED => {
            cq.contest.sieges_failed += 1;
            let d = json!({"brokenByDefender": detail_bit, "progress": e.progress});
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    EventKind::SiegeFailed,
                    Some((p, q)),
                    Some(site),
                    Some(e.faction),
                    Some(owner_f),
                    vec![attacker, owner],
                    d,
                ),
                wt,
            );
            if let Some(t) = cq.track_mut(p16, q16, site) {
                if t.end.is_none() {
                    t.end = Some(SiegeEnd {
                        bell: b,
                        outcome: SiegeOutcome::Failed,
                        broken_by_defender: detail_bit,
                        credited: None,
                    });
                }
            }
        }
        event::OCCUPIED => {
            cq.contest.sieges_completed += 1;
            cq.contest.occupations += 1;
            cq.tally(b, T_SIEGES_WON, e.faction);
            cq.tally(b, T_SIEGES_LOST, owner_f);
            cq.player(attacker, 2);
            let d = json!({"required": e.progress});
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    EventKind::Occupied,
                    Some((p, q)),
                    Some(site),
                    Some(owner_f),
                    Some(e.faction),
                    vec![attacker, owner],
                    d,
                ),
                wt,
            );
            if let Some(t) = cq.track_mut(p16, q16, site) {
                if t.end.is_none() {
                    t.end = Some(SiegeEnd {
                        bell: b,
                        outcome: SiegeOutcome::Occupied,
                        broken_by_defender: false,
                        credited: None,
                    });
                }
            }
            let a = json!({"v": 1, "kind": "occupied", "bell": b, "p": p, "q": q, "site": site,
                "faction": e.faction, "seq": seq.to_string(), "sig": sig});
            cq.alert(f, owner, a, tx.slot);
        }
        event::CAPTURE_DUE => {
            cq.contest.sieges_completed += 1;
            cq.contest.captures += 1;
            cq.tally(b, T_SIEGES_WON, e.faction);
            cq.tally(b, T_SIEGES_LOST, owner_f);
            if detail_bit {
                cq.tally(b, T_CAPTURES, e.faction);
                cq.player(attacker, 3);
            }
            cq.player(attacker, 2);
            let first = cq
                .track_mut(p16, q16, site)
                .is_some_and(|t| t.kind == SiegeKind::First);
            if first {
                cq.first_transferred += 1;
            }
            let d = json!({"credited": detail_bit, "required": e.progress});
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    EventKind::CaptureDue,
                    Some((p, q)),
                    Some(site),
                    Some(owner_f),
                    Some(e.faction),
                    vec![attacker, owner],
                    d,
                ),
                wt,
            );
            if let Some(t) = cq.track_mut(p16, q16, site) {
                if t.end.is_none() {
                    t.end = Some(SiegeEnd {
                        bell: b,
                        outcome: SiegeOutcome::CaptureDue,
                        broken_by_defender: false,
                        credited: Some(detail_bit),
                    });
                }
            }
            let a = json!({"v": 1, "kind": "captured", "bell": b, "p": p, "q": q, "site": site,
                "faction": e.faction, "seq": seq.to_string(), "sig": sig});
            cq.alert(f, owner, a, tx.slot);
        }
        event::LIBERATED | event::OCCUPATION_EXPIRED => {
            let lib = code == event::LIBERATED;
            let respite = !(lib && detail_bit);
            let pd = f.account(&f.ctx.province(p, q)).map(|c| c.data.clone());
            let title_f = pd
                .as_deref()
                .and_then(|d| d.get(P::site(site as usize) + 1).copied())
                .unwrap_or(owner_f);
            let d = json!({"respite": respite});
            let kind = if lib {
                cq.contest.liberations += 1;
                cq.tally(b, T_LIBERATIONS, title_f);
                EventKind::Liberated
            } else {
                EventKind::OccupationExpired
            };
            let otag = holding_owner_tag(f, p, q, site).unwrap_or(owner);
            cq.event(
                ev(
                    seq,
                    b,
                    sig,
                    kind,
                    Some((p, q)),
                    Some(site),
                    Some(e.faction),
                    Some(title_f),
                    vec![otag],
                    d.clone(),
                ),
                wt,
            );
            if let Some(t) = cq.track_mut(p16, q16, site) {
                t.followed.push(rref(kind.as_str(), d));
            }
            if lib {
                let a = json!({"v": 1, "kind": "liberated", "bell": b, "p": p, "q": q, "site": site,
                    "faction": e.faction, "seq": seq.to_string(), "sig": sig});
                cq.alert(f, otag, a, tx.slot);
            }
        }
        _ => {}
    }
}

// ------------------------------------------------------------------ hook 2: per-bell views

/// One bell of a skip run with the shared model (the order of
/// `conquest_model`'s module note): `(step output, the bell's report)`.
pub fn replay_bell(
    pd: &mut [u8],
    b: u32,
    prm: &StepParams,
) -> cm::R<(qm::StepOut, qm::BellReport)> {
    let rep = qm::report_quiet(pd, b)?;
    let settled = cm::settle_bell(pd, b)?;
    let so = qm::step(pd, b, &rep, prm)?;
    cm::finish_bell(pd, b, settled || so.roster_changed)?;
    Ok((so, rep))
}

/// A replayed bell's step output and report.
type Replayed = (qm::StepOut, qm::BellReport);

/// One resolved bell with the shared models in the program's order
/// (`resolve: build_v2 → kernel clash → apply_v2 → report_from_outcome →
/// settle_bell → step → finish_bell`, `conquest_model`'s module note): the
/// Province bytes before the transaction, the bell's ClashInputs and its
/// seed. `Ok(None)` when the clash cannot be rebuilt (a CLASH was logged
/// but its inputs or seed were not captured).
fn replay_resolve(
    f: &Fold,
    pq: (i16, i16),
    b: u32,
    before: &[u8],
    region: u8,
    prm: &StepParams,
) -> cm::R<Option<(Replayed, Vec<u8>)>> {
    let (p, q) = (pq.0 as i32, pq.1 as i32);
    let (inputs, seed) = if f.st.clashes.contains(&(pq.0, pq.1, b)) {
        let ci = f
            .account(&f.ctx.clash_inputs(p, q, b))
            .map(|c| c.data.clone())
            .filter(|d| !d.is_empty());
        match (ci, f.seed_of(b, region)) {
            (Some(ci), Some((s, _))) => (Some(ci), s),
            _ => return Ok(None),
        }
    } else {
        // no CLASH record: nothing engaged, the clash is the quiet one
        (None, [0u8; 32])
    };
    let mut pd = before.to_vec();
    let built = cm::build_v2(&pd, inputs.as_deref(), b)?;
    let out = permutation_rules::frontier::clash::resolve_clash(
        &permutation_rules::frontier::clash::frontier_ruleset(),
        &built.input(&seed),
    )
    .map_err(|_| cm::ModelError::BadAccount)?;
    let ap = cm::apply_v2(&mut pd, &built, &out)?;
    let rep = qm::report_from_outcome(&built, &out)?;
    let settled = cm::settle_bell(&mut pd, b)?;
    let so = qm::step(&mut pd, b, &rep, prm)?;
    cm::finish_bell(&mut pd, b, ap.changed() || settled || so.roster_changed)?;
    Ok(Some(((so, rep), pd)))
}

/// One closed bell of a Province: its bytes after the bell and, when
/// replayed, the step's output and the bell's report.
type BellState = (u32, Vec<u8>, Option<(qm::StepOut, qm::BellReport)>);

/// Whether bell `b`'s step had to log CONQUEST (§5.7 step 5) as far as the
/// bytes after it tell: a live record or contest, or a snapshot bell.
fn must_emit(pd: &[u8], b: u32, events: usize) -> bool {
    events > 0
        || b.is_multiple_of(qm::HOUR_BELLS)
        || qm::decode_records(pd).is_ok_and(|r| r.iter().any(|x| x.active()))
        || qm::read_keep(pd)
            .ok()
            .flatten()
            .is_some_and(|k| k.contender != KP::NONE)
}

/// The hook before the per-bell closing: views of every province-bell
/// the transaction closed in a Province v2 (module note).
pub fn after_records(
    f: &mut Fold,
    tx: &TxRecord,
    before: &BTreeMap<[u8; 32], Vec<u8>>,
    resolved: &[((i16, i16), u32, u32)],
) {
    let mut cq = Cq::take(f);
    if !cq.on {
        let v2 = season_info(f).is_some()
            || resolved.iter().any(|(pq, _, _)| {
                f.provinces
                    .get(pq)
                    .and_then(|m| f.account(&m.addr))
                    .is_some_and(|c| is_v2_province(&c.data))
            });
        if !v2 {
            f.cq = cq;
            return;
        }
        cq.on = true;
    }
    if cq.tx_seq != tx.seq {
        cq.tx_seq = tx.seq;
        cq.tx_conquest.clear();
        cq.index_tags(f, Some(tx));
    }
    let si = season_info(f);
    let genesis = si.map_or(f.season.as_ref().map_or(0, |s| s.genesis_ts), |s| {
        s.prm.genesis_ts
    });
    for &(pq, old, new) in resolved {
        let Some(meta) = f.provinces.get(&pq).copied() else {
            continue;
        };
        let Some(post) = f.account(&meta.addr).map(|c| c.data.clone()) else {
            continue;
        };
        if !is_v2_province(&post) || new <= old || new - old > MAX_STEP {
            continue;
        }
        let bef = before
            .get(&meta.addr)
            .filter(|d| is_v2_province(d))
            .cloned();
        let mut states: Vec<BellState> = vec![];
        // One resolved bell is replayed through the clash (§5.7's resolve
        // order); a run of skipped bells with the quiet model. Both end in
        // the comparison with the post-state's conquest block.
        let mut replayed: Option<(Vec<BellState>, Vec<u8>)> = None;
        if let (Some(bd), Some(si)) = (bef.as_ref(), si) {
            if new - old > 1 {
                let mut pd = bd.clone();
                let mut out = vec![];
                let mut ok = true;
                for b in old..new {
                    match replay_bell(&mut pd, b, &si.prm) {
                        Ok(x) => out.push((b, pd.clone(), Some(x))),
                        Err(_) => {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok {
                    replayed = Some((out, pd));
                } else {
                    cq.alarms.replay_errors += 1;
                }
            } else {
                match replay_resolve(f, pq, old, bd, meta.region, &si.prm) {
                    Ok(Some((x, pd))) => replayed = Some((vec![(old, pd.clone(), Some(x))], pd)),
                    Ok(None) => cq.alarms.conquest_unchecked += 1,
                    Err(_) => cq.alarms.replay_errors += 1,
                }
            }
        } else if new - old > 1 {
            cq.alarms.conquest_unchecked += 1;
        }
        if let Some((st, end)) = replayed {
            states = st;
            if end.get(P::CQ_BLOCK) != post.get(P::CQ_BLOCK) {
                if f.cfg.exact_post {
                    cq.alarms.conquest_mismatch += 1;
                    eprintln!("herald: ALARM conquest {pq:?} bells {old}..{new}: the replayed conquest block differs from the post-state");
                } else {
                    cq.alarms.conquest_unchecked += 1;
                }
            }
            if let Some(last) = states.last_mut() {
                last.1 = post.clone();
            }
        }
        if states.is_empty() {
            for b in old..new {
                states.push((b, post.clone(), None));
            }
        }
        let mut prev = bef;
        for (b, pd_b, so) in states {
            let logged = cq.tx_conquest.get(&(pq.0, pq.1, b)).cloned();
            let digest: [u8; 32] =
                Sha256::digest(pd_b.get(P::RECORDS_AND_KEEP).unwrap_or(&[])).into();
            let events: Vec<Event> = match (&logged, &so) {
                (Some((pl, _, _)), _) => pl.events[..(pl.n as usize).min(pl.events.len())].to_vec(),
                (None, Some((o, _))) => o.events().to_vec(),
                _ => vec![],
            };
            match &logged {
                Some((pl, _, _)) => {
                    let k = qm::read_keep(&pd_b).ok().flatten();
                    let keep_ok = pl.keep_holder == k.map_or(KP::NONE, |k| k.holder)
                        && pl.keep_contender == k.map_or(KP::NONE, |k| k.contender)
                        && pl.keep_progress == k.map_or(0, |k| k.progress)
                        && pl.keep_troops == k.map_or(0, |k| k.troops);
                    let exact = f.cfg.exact_post && (so.is_some() || b + 1 == new);
                    if pl.records_digest != digest || !keep_ok {
                        if exact {
                            cq.alarms.conquest_mismatch += 1;
                            eprintln!("herald: ALARM conquest_mismatch {pq:?}@{b}: the CONQUEST records digest differs from the herald's bytes");
                        } else {
                            cq.alarms.conquest_unchecked += 1;
                        }
                    }
                }
                None => {
                    let n = so.as_ref().map_or(0, |(o, _)| o.n as usize);
                    if must_emit(&pd_b, b, n) && f.cfg.exact_post {
                        cq.alarms.conquest_missing += 1;
                    }
                }
            }
            let clash = f.st.clashes.contains(&(pq.0, pq.1, b));
            let fr: &Fold = f;
            let owner = |s: usize| holding_owner_tag(fr, pq.0 as i32, pq.1 as i32, s as u8);
            let view =
                match ctl::view_of(&pd_b, prev.as_deref(), b, genesis, clash, &events, &owner) {
                    Ok(v) => v,
                    Err(_) => {
                        cq.alarms.replay_errors += 1;
                        prev = Some(pd_b);
                        continue;
                    }
                };
            let rep = so.map(|x| x.1);
            track_bell(
                &mut cq,
                f,
                pq,
                b,
                &pd_b,
                prev.as_deref(),
                &events,
                rep,
                genesis,
                &logged,
            );
            cq.views.insert((pq.0, pq.1, b), view);
            if cq.ct_next.is_none() || (cq.prev_ct.is_none() && cq.ct_next.is_some_and(|c| b < c)) {
                cq.ct_next = Some(b);
            }
            prev = Some(pd_b);
        }
    }
    f.cq = cq;
}

/// Siege series, keep history and the players' recognition for one
/// province-bell.
#[allow(clippy::too_many_arguments)]
fn track_bell(
    cq: &mut Cq,
    f: &Fold,
    pq: (i16, i16),
    b: u32,
    pd: &[u8],
    prev: Option<&[u8]>,
    events: &[Event],
    rep: Option<qm::BellReport>,
    genesis: i64,
    logged: &Option<(ConquestPayload, u64, String)>,
) {
    let (p, q) = (pq.0 as i32, pq.1 as i32);
    let rep = rep.or_else(|| qm::report_quiet(pd, b).ok());
    let tag_of = |id: u64| host_owner_tag(f, id);
    // sieges: a point per counted bell, for live records and those that
    // ended this bell
    let recs = qm::decode_records(pd).ok();
    let prev_recs = prev.and_then(|x| qm::decode_records(x).ok());
    for s in 0..P::SITES_N {
        let Some(d) = cq.site_siege.get(&(pq.0, pq.1, s as u8)).copied() else {
            continue;
        };
        if b <= d {
            continue;
        }
        let ended_now = events.iter().find(|e| {
            e.site == s as u8
                && matches!(
                    e.code & !event::DETAIL,
                    event::SIEGE_FAILED | event::OCCUPIED | event::CAPTURE_DUE
                )
        });
        let rec = recs.as_ref().map(|r| r[s]);
        let live = rec.filter(|r| {
            r.kind == frontier_abi::v2::layout::province::conquest::KIND_SIEGE && r.bell == d
        });
        let base = prev_recs.as_ref().map(|r| r[s]).filter(|r| {
            r.bell == d && r.kind == frontier_abi::v2::layout::province::conquest::KIND_SIEGE
        });
        let Some(t) = cq.sieges.get_mut(&(pq.0, pq.1, s as u8, d)) else {
            continue;
        };
        if t.series.last().is_some_and(|x| x.bell >= b) || (live.is_none() && ended_now.is_none()) {
            continue;
        }
        let progress = match (live, ended_now) {
            (Some(r), _) => r.progress,
            (None, Some(e)) => e.progress,
            _ => 0,
        }
        .min(t.required);
        let sr = rep.map(|r| r.sites[s]).unwrap_or_default();
        let vig = live
            .or(base)
            .is_some_and(|r| ctl::vigil_covers(&r, genesis, b));
        t.series.push(SiegeBell {
            bell: b,
            holds: sr.holders & (1u8 << t.attacker_faction.min(7)) != 0,
            defender: sr.defender_present,
            vigil: vig,
            progress,
        });
    }
    // liberations with Respite: the owner's hosts on the hex
    for e in events
        .iter()
        .filter(|e| e.site != event::KEEP_SITE && e.code == event::LIBERATED)
    {
        let s = e.site as usize;
        if let (Some(tile), Some(owner_f)) = (ctl::site_tile(pd, s), pd.get(P::site(s) + 1)) {
            for t in ctl::hosts_on(pd, tile, *owner_f, &[], &tag_of) {
                cq.player(t, 4);
            }
        }
    }
    // the keep
    let Ok(Some(k)) = qm::read_keep(pd) else {
        return;
    };
    let (seq, sig) = logged
        .as_ref()
        .map(|(_, s, g)| (*s, g.clone()))
        .or_else(|| cq.last_src.get(&pq).cloned())
        .unwrap_or((0, "1".into()));
    let donor = logged.as_ref().map_or(0, |(pl, _, _)| pl.donor_host_id);
    let mut takers: BTreeSet<u64> = BTreeSet::new();
    let mut bellers: BTreeSet<u64> = BTreeSet::new();
    if k.contender != KP::NONE {
        // keep-bells: the counting contender's hosts on the tile
        let counted = prev
            .and_then(|x| qm::read_keep(x).ok().flatten())
            .is_none_or(|pk| pk.contender != k.contender || pk.progress < k.progress);
        if counted {
            bellers = ctl::hosts_on(pd, k.tile, k.contender, &[], &tag_of);
        }
    }
    let mut dirty = false;
    {
        let kh = cq.keeps.entry(pq).or_insert_with(|| KeepHistory {
            p,
            q,
            tile: k.tile,
            holder: k.holder.min(5),
            since: k.since_bell,
            troops: k.troops,
            gen: k.gen,
            heartland: k.heartland_safe,
            holders: vec![(k.holder.min(5), k.since_bell.min(b))],
            contests: vec![],
            captures: vec![],
        });
        for e in events.iter().filter(|e| e.site == event::KEEP_SITE) {
            match e.code & !event::DETAIL {
                event::KEEP_CONTEST => {
                    kh.contests.push(ContestRec {
                        contender: e.faction.min(5),
                        from: b,
                        to: None,
                        outcome: ContestOutcome::Running,
                        progress: e.progress,
                    });
                    dirty = true;
                }
                event::KEEP_BROKEN => {
                    if let Some(c) = kh
                        .contests
                        .iter_mut()
                        .rev()
                        .find(|c| c.outcome == ContestOutcome::Running)
                    {
                        c.to = Some(b);
                        c.outcome = ContestOutcome::Broken;
                        c.progress = e.progress;
                    }
                    dirty = true;
                }
                event::KEEP_TAKEN => {
                    let (to, from) = (e.faction.min(5), e.progress.min(5));
                    if let Some(c) = kh
                        .contests
                        .iter_mut()
                        .rev()
                        .find(|c| c.outcome == ContestOutcome::Running)
                    {
                        c.to = Some(b);
                        c.outcome = ContestOutcome::Taken;
                        c.progress = k.required;
                    }
                    if kh.captures.last().is_none_or(|c| c.bell < b) && from != to {
                        kh.captures.push(KeepCapture {
                            bell: b,
                            from,
                            to,
                            troops: k.troops,
                            donor,
                            seq,
                            sig: sig.clone(),
                        });
                    }
                    takers.extend(ctl::hosts_on(pd, k.tile, to, &[donor], &tag_of));
                    dirty = true;
                }
                _ => {}
            }
        }
        if k.contender != KP::NONE {
            if let Some(c) = kh
                .contests
                .iter_mut()
                .rev()
                .find(|c| c.outcome == ContestOutcome::Running)
            {
                c.progress = k.progress;
            }
        }
        if kh.holder != k.holder.min(5) || kh.troops != k.troops || kh.gen != k.gen {
            kh.holder = k.holder.min(5);
            kh.since = k.since_bell;
            kh.troops = k.troops;
            kh.gen = k.gen;
            if kh.holders.last().map(|h| h.0) != Some(kh.holder) {
                let at = k.since_bell.max(kh.holders.last().map_or(0, |h| h.1));
                kh.holders.push((kh.holder, at));
            }
            dirty = true;
        }
    }
    if dirty {
        cq.keeps_dirty.insert(pq);
    }
    for t in takers {
        cq.player(t, 0);
    }
    for t in bellers {
        cq.player(t, 1);
    }
}

// ------------------------------------------------------------------ hook 3: completeness

pub(crate) fn write(f: &mut Fold, rel: &str, bytes: &[u8], immutable: bool) {
    match f.out.write(rel, bytes) {
        Ok(crate::files::Written::Changed) if immutable => {
            f.st.alarms.rewrites += 1;
            eprintln!("herald: ALARM immutable file {rel} rewritten with different bytes");
        }
        Ok(_) => {}
        Err(e) => {
            f.st.alarms.write_errors += 1;
            eprintln!("herald: write {rel}: {e}");
        }
    }
}

pub(crate) fn push_diff(
    f: &mut Fold,
    kind: &'static str,
    key: String,
    slot: u64,
    bytes: Vec<u8>,
    scope: Scope,
) {
    f.diffs.push(Diff {
        kind,
        key,
        slot,
        head: None,
        bytes,
        scope,
        t_ms: 0,
        wire: Default::default(),
    });
}

/// The provinces' current `resolved_next` minimum (the control files'
/// completeness, M1's overview rule over every opened province).
fn complete_through(f: &Fold) -> Option<u32> {
    let mut t = u32::MAX;
    for m in f.provinces.values() {
        if let Some(rn) = f
            .account(&m.addr)
            .and_then(|c| rd_u32(&c.data, P::RESOLVED_NEXT))
        {
            t = t.min(rn);
        }
    }
    (t != u32::MAX).then_some(t)
}

/// The completeness hook (module note).
pub fn complete(f: &mut Fold, tx: &TxRecord) {
    if !f.cq.on {
        return;
    }
    let mut cq = Cq::take(f);
    let si = season_info(f);
    let slot = tx.slot;
    if let (Some(target), Some(mut b)) = (complete_through(f), cq.ct_next) {
        let mut n = 0;
        while b < target && n < MAX_STEP {
            control_bell(&mut cq, f, b, si.as_ref(), slot);
            b += 1;
            n += 1;
        }
        cq.ct_next = Some(b);
    }
    overview2(&mut cq, f, slot);
    // views no file still needs
    if let Some(ct) = cq.ct_next {
        let ov = cq.ov2_next.clone();
        cq.views
            .retain(|(_, _, b), v| *b >= ct || ov.get(&v.ring).is_none_or(|x| *b >= *x));
        cq.srcs.retain(|(_, _, b), _| *b + 1 >= ct);
    }
    days(&mut cq, f, si.as_ref());
    crate::standings::write_rows(&mut cq, f, si.as_ref(), slot);
    keeps_out(&mut cq, f);
    final_file(&mut cq, f, si.as_ref());
    f.cq = cq;
}

/// Bell `b`'s control file, sieges file and their WS deltas.
fn control_bell(cq: &mut Cq, f: &mut Fold, b: u32, si: Option<&SeasonInfo>, slot: u64) {
    let genesis = si.map_or(0, |s| s.prm.genesis_ts);
    // the opened provinces and their records at b
    let mut rings = 0u32;
    let mut any = false;
    let mut recs: BTreeMap<u32, fmt::ControlProvince> = BTreeMap::new();
    let mut views: Vec<(ProvinceCoord, View)> = vec![];
    let metas: Vec<((i16, i16), crate::fold::ProvMeta)> =
        f.provinces.iter().map(|(k, m)| (*k, *m)).collect();
    for (pq, m) in metas {
        if m.first > b {
            continue;
        }
        let c = ProvinceCoord::new(pq.0 as i32, pq.1 as i32);
        let Some(i) = c.checked_index() else {
            continue;
        };
        let v = match cq.views.get(&(pq.0, pq.1, b)) {
            Some(v) => Some(v.clone()),
            None => f.account(&m.addr).and_then(|a| {
                let fr: &Fold = f;
                let owner = |s: usize| holding_owner_tag(fr, pq.0 as i32, pq.1 as i32, s as u8);
                ctl::view_of(&a.data, None, b, genesis, false, &[], &owner).ok()
            }),
        };
        let Some(v) = v else {
            continue;
        };
        any = true;
        rings = rings.max(c.ring());
        recs.insert(i, v.ct);
        views.push((c, v));
    }
    if !any || rings > fmt::CONTROL_MAX_RING {
        return;
    }
    let day = b / fmt::BELLS_PER_DAY;
    // Herald's Call at the first bell of the day (§3.10)
    if b.is_multiple_of(fmt::BELLS_PER_DAY) {
        let call = herald_call(cq, &views, b, day, si);
        if let Ok(j) = call.to_json() {
            write(f, &format!("h/call/{day}.json"), j.as_bytes(), true);
        }
        cq.call = Some(call);
    }
    let call_set: BTreeSet<(i32, i32)> = cq
        .call
        .as_ref()
        .filter(|c| c.day == day)
        .map(|c| c.calls.iter().flatten().map(|(m, _)| (m.m, m.n)).collect())
        .unwrap_or_default();
    let lead: BTreeMap<(i32, i32), u8> = cq
        .marches
        .iter()
        .map(|(k, v)| (*k, if v.controller <= 6 { v.controller } else { 7 }))
        .collect();
    let mi = ctl::MarchInputs {
        lead: &lead,
        lead_changed: &cq.lead_changed,
        call: &call_set,
    };
    let season = f.cfg.season_id;
    let file = ctl::control_file(season, b, rings, &recs, cq.prev_ct.as_ref(), &mi);
    let bytes = match file.encode() {
        Ok(x) => x,
        Err(e) => {
            cq.alarms.format_errors += 1;
            eprintln!("herald: control {b}: {e}");
            return;
        }
    };
    let rel = format!("h/control/{b}.bin");
    write(f, &rel, &bytes, true);
    let delta = cq
        .prev_ct
        .as_ref()
        .and_then(|p| fmt::control_delta(p, &file))
        .filter(|d| !d.is_empty())
        .and_then(|d| fmt::encode_control_delta(&d).ok());
    let changed = cq
        .prev_ct
        .as_ref()
        .is_none_or(|p| p.provinces != file.provinces);
    if changed || delta.is_some() {
        push_diff(
            f,
            "control",
            format!("/{rel}"),
            slot,
            delta.unwrap_or_default(),
            Scope::None,
        );
    }
    // derived events: lasting colour changes of provinces and banners
    let wt = cq.day_next;
    if let Some(prev) = cq.prev_ct.clone() {
        for (i, (a, z)) in prev.provinces.iter().zip(&file.provinces).enumerate() {
            if a.control != z.control && a.control < 6 && z.control < 6 {
                let c = ProvinceCoord::from_index(i as u32);
                let src = cq
                    .srcs
                    .get(&(c.p as i16, c.q as i16, b))
                    .or_else(|| cq.last_src.get(&(c.p as i16, c.q as i16)))
                    .cloned();
                if let Some((seq, sig)) = src {
                    let e = ev(
                        seq,
                        b,
                        &sig,
                        EventKind::ProvinceControl,
                        Some((c.p, c.q)),
                        None,
                        Some(a.control),
                        Some(z.control),
                        vec![],
                        json!({}),
                    );
                    cq.event(e, wt);
                }
            }
        }
        let po = fmt::march_order(prev.rings().unwrap_or(0));
        let prev_b: BTreeMap<(i32, i32), u8> = po
            .iter()
            .zip(&prev.marches)
            .map(|(m, r)| ((m.m, m.n), r.banner))
            .collect();
        let order = fmt::march_order(rings);
        for (m, r) in order.iter().zip(&file.marches) {
            let Some(&pb) = prev_b.get(&(m.m, m.n)) else {
                continue;
            };
            if pb == r.banner {
                continue;
            }
            let src = permutation_rules::frontier::geometry::march_members(*m)
                .iter()
                .find_map(|c| cq.srcs.get(&(c.p as i16, c.q as i16, b)).cloned())
                .or_else(|| {
                    permutation_rules::frontier::geometry::march_members(*m)
                        .iter()
                        .find_map(|c| cq.last_src.get(&(c.p as i16, c.q as i16)).cloned())
                });
            if let Some((seq, sig)) = src {
                let mut e = ev(
                    seq,
                    b,
                    &sig,
                    EventKind::MarchBanner,
                    None,
                    None,
                    Some(pb),
                    Some(r.banner),
                    vec![],
                    json!({}),
                );
                e.march = Some(*m);
                cq.event(e, wt);
            }
        }
    }
    // banner history (the Rally)
    let order = fmt::march_order(rings);
    for (m, r) in order.iter().zip(&file.marches) {
        if r.banner < 6 {
            let h = cq.banner_hist.entry((m.m, m.n)).or_default();
            if h.last().is_none_or(|x| x.1 != r.banner) {
                h.push((b, r.banner));
            }
        }
    }
    for h in cq.banner_hist.values_mut() {
        while h.len() > 1 && h[1].0 + RALLY_BELLS <= b {
            h.remove(0);
        }
    }
    // the sieges file
    let mut sieges: Vec<fmt::SiegeEntry> =
        views.iter().flat_map(|(_, v)| v.sieges.clone()).collect();
    sieges.sort_by_key(|s| (s.p, s.q, s.site));
    let mut keeps: Vec<fmt::KeepContest> =
        views.iter().filter_map(|(_, v)| v.keep.clone()).collect();
    keeps.sort_by_key(|k| (k.p, k.q));
    let sf = SiegesFile {
        bell: b,
        sieges,
        keeps,
    };
    match sf.to_json() {
        Ok(j) => {
            write(f, &format!("h/sieges/{b}.json"), j.as_bytes(), true);
            if let Some(d) = SiegeDelta::between(cq.prev_sieges.as_ref(), &sf) {
                push_diff(
                    f,
                    "siege",
                    format!("/h/sieges/{b}.json"),
                    slot,
                    d.to_json().into_bytes(),
                    Scope::None,
                );
            }
            cq.prev_sieges = Some(sf);
        }
        Err(e) => {
            cq.alarms.format_errors += 1;
            eprintln!("herald: sieges {b}: {e}");
        }
    }
    // the hour's map figures
    let end = si.map_or(u32::MAX, |s| s.end_bell);
    if (b + 1).is_multiple_of(qm::HOUR_BELLS) || b + 1 == end {
        let mut hs = HourSnap {
            bell: b,
            ..Default::default()
        };
        for (c, v) in &views {
            if c.ring() >= 2 && v.ct.control < 6 {
                hs.provinces[v.ct.control as usize] += 1;
            }
            for x in 0..6 {
                hs.holdings[x] = hs.holdings[x].saturating_add(v.holdings[x]);
                hs.occupations[x] = hs.occupations[x].saturating_add(v.occupations[x]);
            }
        }
        for r in &file.marches {
            if r.banner < 6 {
                hs.banners[r.banner as usize] += 1;
            }
        }
        cq.hour_snaps.insert(b / qm::HOUR_BELLS, hs);
    }
    cq.lead_changed.clear();
    cq.prev_ct = Some(file);
}

/// Herald's Call of `day` over the views of bell `b` (§3.10).
fn herald_call(
    cq: &Cq,
    views: &[(ProvinceCoord, View)],
    b: u32,
    day: u32,
    si: Option<&SeasonInfo>,
) -> CallFile {
    let provinces = views
        .iter()
        .map(|(c, v)| MapProvince {
            coord: *c,
            control: ctl::control_of_code(v.ct.control, c.ring()),
            contestable: v.contestable,
        })
        .collect();
    let mut recently_lost = vec![];
    let n = views
        .iter()
        .filter_map(|(c, _)| c.checked_index())
        .max()
        .map_or(0, |x| x as usize + 1);
    let mut codes = vec![fmt::CONTROL_NONE; n];
    for (c, v) in views {
        if let Some(i) = c.checked_index() {
            codes[i as usize] = v.ct.control;
        }
    }
    let now = |m: &(i32, i32)| {
        ctl::banner_of(MarchCoord { m: m.0, n: m.1 }, &codes)
            .0
            .code()
    };
    for (m, h) in &cq.banner_hist {
        let cur = now(m);
        let mut seen = BTreeSet::new();
        for (bell, fac) in h {
            if bell + RALLY_BELLS > b && *fac != cur {
                seen.insert(*fac);
            }
        }
        // the faction holding the banner when the window opened counts too
        if let Some((_, fac)) = h.iter().rev().find(|(bell, _)| bell + RALLY_BELLS <= b) {
            if *fac != cur {
                seen.insert(*fac);
            }
        }
        for fac in seen {
            recently_lost.push((fac, MarchCoord { m: m.0, n: m.1 }));
        }
    }
    recently_lost.sort();
    let map = ControlMap {
        provinces,
        recently_lost,
    };
    let seed = fmt::call_day_seed(&si.map_or([0; 32], |s| s.genesis_seed), day);
    let calls = control::herald_call_detail(&map, &seed).map(|c| c.map(|c| (c.march, c.rally)));
    CallFile {
        day,
        bell: b,
        day_seed: seed,
        calls,
    }
}

/// `PSFOV2` beside every `PSFOV1` the M1 fold wrote (CF-4: bytes 0–23 are
/// the v1 record, read back from its file).
fn overview2(cq: &mut Cq, f: &mut Fold, slot: u64) {
    let rings: Vec<(u16, u32)> = f.st.ov_next.iter().map(|(d, b)| (*d, *b)).collect();
    for (d, next) in rings {
        let first = cq
            .views
            .iter()
            .filter(|(_, v)| v.ring == d)
            .map(|((_, _, b), _)| *b)
            .min();
        let start = *cq
            .ov2_next
            .entry(d)
            .or_insert(first.unwrap_or(next).min(next));
        let mut b = start;
        while b < next && b - start < MAX_STEP {
            let rel = format!("h/overview/{d}/{b}.bin");
            if let Some(v1) = f.out.path(&rel).and_then(|p| std::fs::read(p).ok()) {
                if let Some(file) = ov2_of(cq, f, &v1, d, b) {
                    match file.encode() {
                        Ok(bytes) => {
                            let rel2 = format!("h/overview2/{d}/{b}.bin");
                            write(f, &rel2, &bytes, true);
                            push_diff(f, "bell", format!("/{rel2}"), slot, vec![], Scope::Ring(d));
                        }
                        Err(_) => cq.alarms.format_errors += 1,
                    }
                }
            }
            b += 1;
        }
        cq.ov2_next.insert(d, b);
    }
}

/// The `PSFOV2` of a `PSFOV1` file's bytes.
fn ov2_of(cq: &Cq, f: &Fold, v1: &[u8], ring: u16, b: u32) -> Option<Overview2File> {
    let n = u16::from_le_bytes([*v1.get(18)?, *v1.get(19)?]) as usize;
    let h = crate::overview::OVERVIEW_HEADER;
    if v1.len() != h + n * OVERVIEW_RECORD {
        return None;
    }
    let genesis = season_info(f).map_or(0, |s| s.prm.genesis_ts);
    let mut records = Vec::with_capacity(n);
    for i in 0..n {
        let rec: [u8; OVERVIEW_RECORD] = v1[h + i * OVERVIEW_RECORD..h + (i + 1) * OVERVIEW_RECORD]
            .try_into()
            .ok()?;
        let p = i16::from_le_bytes([rec[0], rec[1]]);
        let q = i16::from_le_bytes([rec[2], rec[3]]);
        let ext = match cq.views.get(&(p, q, b)) {
            Some(v) => Some(v.ext),
            None => f
                .account(&f.ctx.province(p as i32, q as i32))
                .and_then(|a| {
                    let owner = |_s: usize| None;
                    ctl::view_of(&a.data, None, b, genesis, false, &[], &owner)
                        .ok()
                        .map(|v| v.ext)
                }),
        };
        let mut r = ext.unwrap_or_else(|| Overview2Record::from_v1([0; OVERVIEW_RECORD]));
        r.v1 = rec;
        records.push(r);
    }
    Some(Overview2File {
        season: u64::from_le_bytes(v1[8..16].try_into().ok()?),
        ring,
        bell: b,
        slot: u64::from_le_bytes(v1[24..32].try_into().ok()?),
        records,
    })
}

/// The live `PSFOV2` of ring `d` (`latest.bin`).
pub fn overview2_latest(f: &Fold, d: u16) -> Option<Vec<u8>> {
    let v1 = f.overview_latest(d)?;
    let bell = u32::from_le_bytes(v1.get(20..24)?.try_into().ok()?);
    let cq = Cq::default();
    ov2_of(&cq, f, &v1, d, bell)?.encode().ok()
}

/// Day files: written when the control is complete through the day's
/// last bell plus [`DAY_GRACE_BELLS`], or once the season has ended.
fn days(cq: &mut Cq, f: &mut Fold, si: Option<&SeasonInfo>) {
    let Some(ct) = cq.ct_next else {
        return;
    };
    let ended = si.is_some_and(|s| s.ended && ct >= s.end_bell);
    let last_day = si.map(|s| s.end_bell.saturating_sub(1) / fmt::BELLS_PER_DAY);
    loop {
        let d = cq.day_next;
        let due = (d + 1) * fmt::BELLS_PER_DAY + DAY_GRACE_BELLS <= ct
            || (ended && last_day.is_some_and(|l| d <= l));
        if !due {
            break;
        }
        write_day(cq, f, d);
        cq.day_next = d + 1;
    }
}

/// Writes day `d`'s file, once (`immutable`).
fn write_day(cq: &mut Cq, f: &mut Fold, d: u32) {
    let mut events = cq.days.remove(&d).unwrap_or_default();
    let rel = format!("h/conquest/{d}.json");
    events.sort_by_key(|e| e.seq);
    let file = ConquestDay { day: d, events };
    match file.to_json() {
        Ok(j) => write(f, &rel, j.as_bytes(), true),
        Err(e) => {
            cq.alarms.format_errors += 1;
            eprintln!("herald: conquest day {d}: {e}");
        }
    }
}

/// The live day file of a day not yet written.
pub fn day_live(f: &Fold, d: u32) -> Option<String> {
    let mut events = f.cq.days.get(&d).cloned().unwrap_or_default();
    events.sort_by_key(|e| e.seq);
    ConquestDay { day: d, events }.to_json().ok()
}

fn keeps_out(cq: &mut Cq, f: &mut Fold) {
    let dirty = std::mem::take(&mut cq.keeps_dirty);
    for pq in dirty {
        if let Some(k) = cq.keeps.get(&pq) {
            match k.to_json() {
                Ok(j) => {
                    let rel = format!("h/keep/{},{}.json", pq.0, pq.1);
                    write(f, &rel, j.as_bytes(), false);
                }
                Err(_) => cq.alarms.format_errors += 1,
            }
        }
    }
}

/// `final.json`, the siege files and the keeps' final state, once
/// EndSeason landed, the control is complete through `end_bell − 1` and
/// every standings hour is written.
fn final_file(cq: &mut Cq, f: &mut Fold, si: Option<&SeasonInfo>) {
    let Some(si) = si else {
        return;
    };
    let Some(ct) = cq.ct_next else {
        return;
    };
    if cq.final_done || !si.ended || ct < si.end_bell || !cq.hour_snaps.is_empty() {
        return;
    }
    let end = si.end_bell;
    // the season's series, read back from the control files
    let mut series = ctl::Series {
        bells: vec![],
        banners: BTreeMap::new(),
    };
    let first = (0..end).find(|b| {
        f.out
            .path(&format!("h/control/{b}.bin"))
            .is_some_and(|p| p.is_file())
    });
    let mut last_bytes = vec![];
    if let Some(first) = first {
        for b in first..end {
            let Some(bytes) = f
                .out
                .path(&format!("h/control/{b}.bin"))
                .and_then(|p| std::fs::read(p).ok())
            else {
                continue;
            };
            if let Ok(file) = ControlFile::decode(&bytes) {
                series.push(&file);
            }
            last_bytes = bytes;
        }
    }
    let metas: Vec<ctl::ProvMeta> = f
        .provinces
        .iter()
        .filter_map(|(pq, m)| {
            let c = ProvinceCoord::new(pq.0 as i32, pq.1 as i32);
            Some(ctl::ProvMeta {
                index: c.checked_index()?,
                ring: c.ring(),
                first: m.first,
            })
        })
        .collect();
    let mut movement = ctl::movement(&series, &metas, si.prm.cq.heartland_max_ring, end);
    movement.holding_contest = cq.contest;
    movement.first_holdings_transferred = cq.first_transferred;
    let pf = crate::standings::players_file(cq);
    let title = |name: &str, i: usize| -> Option<Title> {
        let best = pf
            .players
            .iter()
            .map(|r| {
                (
                    r,
                    [
                        r.keeps_taken,
                        r.keep_bells,
                        r.sieges_won,
                        r.captures,
                        r.liberations,
                    ][i],
                )
            })
            .filter(|(_, v)| *v > 0)
            .max_by_key(|(r, v)| (*v, std::cmp::Reverse(r.tag)))?;
        Some(Title {
            title: name.into(),
            tag: best.0.tag,
            faction: best.0.faction,
            value: best.1,
        })
    };
    let titles: Vec<Title> = [
        title("Breaker of Keeps", 0),
        title("Warden of the Marches", 1),
    ]
    .into_iter()
    .flatten()
    .collect();
    let file = FinalFile {
        season: f.cfg.season_id,
        end_bell: end,
        control_sha256: Sha256::digest(&last_bytes).into(),
        standings: crate::standings::standings_latest(cq, f, Some(si)),
        movement,
        titles,
    };
    match file.to_json() {
        Ok(j) => write(f, "h/season/final.json", j.as_bytes(), true),
        Err(e) => {
            cq.alarms.format_errors += 1;
            eprintln!("herald: final.json: {e}");
            return;
        }
    }
    // every siege's history (lapsed sieges end at end_bell)
    let keys: Vec<(i16, i16, u8, u32)> = cq.sieges.keys().copied().collect();
    for k in keys {
        if let Some(t) = cq.sieges.get_mut(&k) {
            if t.end.is_none() {
                t.end = Some(SiegeEnd {
                    bell: end,
                    outcome: SiegeOutcome::Lapsed,
                    broken_by_defender: false,
                    credited: None,
                });
            }
        }
        if let Some(t) = cq.sieges.get(&k) {
            if let Ok(j) = t.to_json() {
                let rel = format!("h/siege/{},{},{}/{}.json", k.0, k.1, k.2, k.3);
                write(f, &rel, j.as_bytes(), true);
            }
        }
    }
    for k in cq.keeps.values_mut() {
        for c in k
            .contests
            .iter_mut()
            .filter(|c| c.outcome == ContestOutcome::Running)
        {
            c.outcome = ContestOutcome::Stopped;
            c.to = Some(end.saturating_sub(1).max(c.from));
        }
    }
    cq.keeps_dirty.extend(cq.keeps.keys().copied());
    keeps_out(cq, f);
    // the last days
    let lastd = end.saturating_sub(1) / fmt::BELLS_PER_DAY;
    while cq.day_next <= lastd {
        let d = cq.day_next;
        write_day(cq, f, d);
        cq.day_next = d + 1;
    }
    cq.final_done = true;
}

// ------------------------------------------------------------------ /h/me

/// `/h/me` additions for an MC season: the wallet's alerts, the sieges
/// on its holdings or by it, and its own `players.json` row (§8.4: "the
/// caller's row via `/h/me`"; `null` before it has one).
pub fn me_additions(f: &Fold, wallet: &[u8; 32]) -> Option<(Value, Value, Value)> {
    if !f.cq.on {
        return None;
    }
    use frontier_abi::layout::player::citizen as C;
    let alerts = Value::Array(f.cq.alerts.get(wallet).cloned().unwrap_or_default());
    let tag = f
        .account(&f.ctx.citizen(wallet))
        .and_then(|c| rd_u64(&c.data, C::CITIZEN_TAG));
    let mut sieges = vec![];
    if let Some(tag) = tag {
        for t in f.cq.sieges.values().filter(|t| t.end.is_none()) {
            let role = if t.owner == Some(tag) {
                "owner"
            } else if t.attacker == tag {
                "attacker"
            } else {
                continue;
            };
            sieges.push(json!({
                "key": t.key(), "role": role, "p": t.p, "q": t.q, "site": t.site, "kind": t.kind.as_str(),
                "declared": t.declared, "required": t.required,
                "progress": t.series.last().map_or(0, |s| s.progress),
                "attackerFaction": t.attacker_faction, "ownerFaction": t.owner_faction,
            }));
        }
    }
    let player = tag
        .and_then(|t| Some((t, f.cq.players.get(&t)?, f.cq.faction_of_tag(t)?)))
        .map_or(Value::Null, |(t, c, fac)| {
            json!({"tag": tag_hex(t), "faction": fac, "keepsTaken": c[0], "keepBells": c[1],
                "siegesWon": c[2], "captures": c[3], "liberations": c[4]})
        });
    Some((alerts, Value::Array(sieges), player))
}

// ------------------------------------------------------------------ checkpoint

fn hexs(b: &[u8]) -> Value {
    Value::String(hex::encode(b))
}

fn unhex(v: &Value) -> Option<Vec<u8>> {
    hex::decode(v.as_str()?).ok()
}

fn arr6<T: Copy + Into<u64>>(a: &[T; 6]) -> Value {
    json!(a.iter().map(|&x| x.into()).collect::<Vec<u64>>())
}

fn get6_u16(v: &Value) -> Option<[u16; 6]> {
    let a = v.as_array()?;
    let mut o = [0u16; 6];
    for (i, x) in a.iter().enumerate().take(6) {
        o[i] = x.as_u64()? as u16;
    }
    Some(o)
}

fn get6_u32(v: &Value) -> Option<[u32; 6]> {
    let a = v.as_array()?;
    let mut o = [0u32; 6];
    for (i, x) in a.iter().enumerate().take(6) {
        o[i] = x.as_u64()? as u32;
    }
    Some(o)
}

fn src_json(s: &(u64, String)) -> Value {
    json!([s.0.to_string(), s.1])
}

fn src_of(v: &Value) -> Option<(u64, String)> {
    Some((
        v.get(0)?.as_str()?.parse().ok()?,
        v.get(1)?.as_str()?.to_string(),
    ))
}

impl Cq {
    /// The checkpoint form (JSON; deterministic: ordered maps).
    pub fn to_json(&self) -> Value {
        let views: Vec<Value> = self
            .views
            .iter()
            .map(|((p, q, b), v)| {
                let sf = SiegesFile {
                    bell: *b,
                    sieges: v.sieges.clone(),
                    keeps: v.keep.clone().into_iter().collect(),
                };
                json!({"k": [p, q, b], "ring": v.ring, "ct": hexs(&v.ct.encode()), "ext": hexs(&v.ext.encode()),
                    "sg": sf.to_json().unwrap_or_default(), "h": arr6(&v.holdings), "o": arr6(&v.occupations),
                    "c": v.contestable})
            })
            .collect();
        let a = &self.alarms;
        json!({
            "v": 1, "on": self.on,
            "alarms": [a.conquest_mismatch, a.conquest_missing, a.conquest_unchecked, a.replay_errors,
                a.bad_records, a.format_errors, a.late_events],
            "views": views,
            "srcs": self.srcs.iter().map(|((p, q, b), s)| json!([p, q, b, src_json(s)])).collect::<Vec<_>>(),
            "lastSrc": self.last_src.iter().map(|((p, q), s)| json!([p, q, src_json(s)])).collect::<Vec<_>>(),
            "ctNext": self.ct_next,
            "ov2Next": self.ov2_next.iter().map(|(d, b)| json!([d, b])).collect::<Vec<_>>(),
            "prevCt": self.prev_ct.as_ref().and_then(|c| c.encode().ok()).map(|b| hexs(&b)),
            "prevSieges": self.prev_sieges.as_ref().and_then(|s| s.to_json().ok()),
            "dayNext": self.day_next,
            "days": self.days.iter().map(|(d, e)| {
                let mut e = e.clone();
                e.sort_by_key(|x| x.seq);
                ConquestDay { day: *d, events: e }.to_json().unwrap_or_default()
            }).collect::<Vec<_>>(),
            "sieges": self.sieges.values().filter_map(|s| s.to_json().ok()).collect::<Vec<_>>(),
            "keeps": self.keeps.values().filter_map(|k| k.to_json().ok()).collect::<Vec<_>>(),
            "keepsDirty": self.keeps_dirty.iter().map(|(p, q)| json!([p, q])).collect::<Vec<_>>(),
            "marches": self.marches.iter().map(|((m, n), d)| json!([m, n, d.controller, d.folded])).collect::<Vec<_>>(),
            "leadChanged": self.lead_changed.iter().map(|(m, n)| json!([m, n])).collect::<Vec<_>>(),
            "foldHours": self.fold_hours.iter().map(|(h, x)| json!([h, arr6(&x.dom),
                x.marches.iter().map(|(m, n)| json!([m, n])).collect::<Vec<_>>()])).collect::<Vec<_>>(),
            "tally": self.tally.iter().map(|(b, t)| json!([b, t.iter().map(arr6).collect::<Vec<_>>()])).collect::<Vec<_>>(),
            "hourSnaps": self.hour_snaps.iter().map(|(h, s)| json!([h, s.bell, arr6(&s.provinces), arr6(&s.banners),
                arr6(&s.holdings), arr6(&s.occupations)])).collect::<Vec<_>>(),
            "series": self.series.as_ref().and_then(|s| s.encode().ok()).map(|b| hexs(&b)),
            "bannerHist": self.banner_hist.iter().map(|((m, n), h)| json!([m, n, h])).collect::<Vec<_>>(),
            "call": self.call.as_ref().and_then(|c| c.to_json().ok()),
            "players": self.players.iter().map(|(t, c)| json!([t.to_string(), c])).collect::<Vec<_>>(),
            "alerts": self.alerts.iter().map(|(w, a)| json!([hex::encode(w), a])).collect::<Vec<_>>(),
            "contest": [self.contest.sieges_declared, self.contest.sieges_completed, self.contest.sieges_failed,
                self.contest.occupations, self.contest.liberations, self.contest.captures, self.contest.outposts],
            "firstTransferred": self.first_transferred,
            "finalDone": self.final_done,
        })
    }

    /// The inverse of [`Cq::to_json`] (`None` when damaged).
    pub fn from_json(v: &Value) -> Option<Cq> {
        if v.get("v")?.as_u64()? != 1 {
            return None;
        }
        let mut c = Cq {
            on: v["on"].as_bool()?,
            ..Default::default()
        };
        let a: Vec<u64> = v["alarms"]
            .as_array()?
            .iter()
            .filter_map(|x| x.as_u64())
            .collect();
        if a.len() != 7 {
            return None;
        }
        c.alarms = CqAlarms {
            conquest_mismatch: a[0],
            conquest_missing: a[1],
            conquest_unchecked: a[2],
            replay_errors: a[3],
            bad_records: a[4],
            format_errors: a[5],
            late_events: a[6],
        };
        for x in v["views"].as_array()? {
            let k = x["k"].as_array()?;
            let (p, q, b) = (
                k[0].as_i64()? as i16,
                k[1].as_i64()? as i16,
                k[2].as_u64()? as u32,
            );
            let ct = unhex(&x["ct"])?;
            let ext = unhex(&x["ext"])?;
            let sf = SiegesFile::parse(x["sg"].as_str()?.as_bytes()).ok()?;
            c.views.insert(
                (p, q, b),
                View {
                    ring: x["ring"].as_u64()? as u16,
                    ct: fmt::ControlProvince::decode(&ct),
                    ext: Overview2Record::decode(&ext, 0).ok()?,
                    sieges: sf.sieges,
                    keep: sf.keeps.into_iter().next(),
                    holdings: get6_u16(&x["h"])?,
                    occupations: get6_u16(&x["o"])?,
                    contestable: x["c"].as_bool()?,
                },
            );
        }
        for x in v["srcs"].as_array()? {
            c.srcs.insert(
                (
                    x[0].as_i64()? as i16,
                    x[1].as_i64()? as i16,
                    x[2].as_u64()? as u32,
                ),
                src_of(&x[3])?,
            );
        }
        for x in v["lastSrc"].as_array()? {
            c.last_src.insert(
                (x[0].as_i64()? as i16, x[1].as_i64()? as i16),
                src_of(&x[2])?,
            );
        }
        c.ct_next = v["ctNext"].as_u64().map(|x| x as u32);
        for x in v["ov2Next"].as_array()? {
            c.ov2_next
                .insert(x[0].as_u64()? as u16, x[1].as_u64()? as u32);
        }
        c.prev_ct = match &v["prevCt"] {
            Value::Null => None,
            x => Some(ControlFile::decode(&unhex(x)?).ok()?),
        };
        c.prev_sieges = match &v["prevSieges"] {
            Value::Null => None,
            x => Some(SiegesFile::parse(x.as_str()?.as_bytes()).ok()?),
        };
        c.day_next = v["dayNext"].as_u64()? as u32;
        for x in v["days"].as_array()? {
            let d = ConquestDay::parse(x.as_str()?.as_bytes()).ok()?;
            c.days.insert(d.day, d.events);
        }
        for x in v["sieges"].as_array()? {
            let s = SiegeHistory::parse(x.as_str()?.as_bytes()).ok()?;
            c.site_siege
                .entry((s.p as i16, s.q as i16, s.site))
                .and_modify(|d| *d = (*d).max(s.declared))
                .or_insert(s.declared);
            c.sieges
                .insert((s.p as i16, s.q as i16, s.site, s.declared), s);
        }
        for x in v["keeps"].as_array()? {
            let k = KeepHistory::parse(x.as_str()?.as_bytes()).ok()?;
            c.keeps.insert((k.p as i16, k.q as i16), k);
        }
        for x in v["keepsDirty"].as_array()? {
            c.keeps_dirty
                .insert((x[0].as_i64()? as i16, x[1].as_i64()? as i16));
        }
        for x in v["marches"].as_array()? {
            c.marches.insert(
                (x[0].as_i64()? as i32, x[1].as_i64()? as i32),
                MarchDom {
                    controller: x[2].as_u64()? as u8,
                    folded: x[3].as_bool()?,
                },
            );
        }
        for x in v["leadChanged"].as_array()? {
            c.lead_changed
                .insert((x[0].as_i64()? as i32, x[1].as_i64()? as i32));
        }
        for x in v["foldHours"].as_array()? {
            let mut fh = FoldHour {
                dom: get6_u32(&x[1])?,
                marches: BTreeSet::new(),
            };
            for m in x[2].as_array()? {
                fh.marches
                    .insert((m[0].as_i64()? as i32, m[1].as_i64()? as i32));
            }
            c.fold_hours.insert(x[0].as_u64()? as u32, fh);
        }
        for x in v["tally"].as_array()? {
            let rows = x[1].as_array()?;
            let mut t = [[0u16; 6]; TALLY_N];
            for (i, r) in rows.iter().enumerate().take(TALLY_N) {
                t[i] = get6_u16(r)?;
            }
            c.tally.insert(x[0].as_u64()? as u32, t);
        }
        for x in v["hourSnaps"].as_array()? {
            c.hour_snaps.insert(
                x[0].as_u64()? as u32,
                HourSnap {
                    bell: x[1].as_u64()? as u32,
                    provinces: get6_u16(&x[2])?,
                    banners: get6_u16(&x[3])?,
                    holdings: get6_u16(&x[4])?,
                    occupations: get6_u16(&x[5])?,
                },
            );
        }
        c.series = match &v["series"] {
            Value::Null => None,
            x => Some(StandingsSeries::decode(&unhex(x)?).ok()?),
        };
        for x in v["bannerHist"].as_array()? {
            let h: Vec<(u32, u8)> = x[2]
                .as_array()?
                .iter()
                .filter_map(|e| Some((e[0].as_u64()? as u32, e[1].as_u64()? as u8)))
                .collect();
            c.banner_hist
                .insert((x[0].as_i64()? as i32, x[1].as_i64()? as i32), h);
        }
        c.call = match &v["call"] {
            Value::Null => None,
            x => Some(CallFile::parse(x.as_str()?.as_bytes()).ok()?),
        };
        for x in v["players"].as_array()? {
            let t: u64 = x[0].as_str()?.parse().ok()?;
            let r = x[1].as_array()?;
            let mut a = [0u32; 5];
            for (i, y) in r.iter().enumerate().take(5) {
                a[i] = y.as_u64()? as u32;
            }
            c.players.insert(t, a);
        }
        for x in v["alerts"].as_array()? {
            let w: [u8; 32] = unhex(&x[0])?.try_into().ok()?;
            c.alerts.insert(w, x[1].as_array()?.clone());
        }
        let ct: Vec<u32> = v["contest"]
            .as_array()?
            .iter()
            .filter_map(|x| x.as_u64().map(|y| y as u32))
            .collect();
        if ct.len() != 7 {
            return None;
        }
        c.contest = HoldingContest {
            sieges_declared: ct[0],
            sieges_completed: ct[1],
            sieges_failed: ct[2],
            occupations: ct[3],
            liberations: ct[4],
            captures: ct[5],
            outposts: ct[6],
        };
        c.first_transferred = v["firstTransferred"].as_u64()? as u32;
        c.final_done = v["finalDone"].as_bool()?;
        Some(c)
    }
}

/// `/h/status/conquest`.
pub fn status_json(f: &Fold) -> Value {
    let c = &f.cq;
    let a = c.alarms;
    json!({
        "v": 1, "conquest": c.on, "controlNext": c.ct_next, "dayNext": c.day_next,
        "sieges": c.sieges.values().filter(|s| s.end.is_none()).count(),
        "keepsContested": c.keeps.values().filter(|k| k.contests.last().is_some_and(|x| x.outcome == ContestOutcome::Running)).count(),
        "standingsHours": c.series.as_ref().map_or(0, |s| s.hours.len()),
        "final": c.final_done,
        "alarms": {"conquestMismatch": a.conquest_mismatch, "conquestMissing": a.conquest_missing,
            "conquestUnchecked": a.conquest_unchecked, "replayErrors": a.replay_errors,
            "badRecords": a.bad_records, "formatErrors": a.format_errors, "lateEvents": a.late_events},
    })
}

/// Tags of `f`'s citizens (tests).
pub fn tag_hex_of(tag: u64) -> String {
    tag_hex(tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cq_empty_state_round_trips() {
        let c = Cq::default();
        let j = c.to_json();
        let d = Cq::from_json(&j).expect("decodes");
        assert_eq!(d.to_json(), j);
    }
}
