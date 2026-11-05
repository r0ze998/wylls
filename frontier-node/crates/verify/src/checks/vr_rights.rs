//! VR — the workshop-stock swap Grant (workstream 02-rights, **candidate**:
//! the check name, its codes and the record kinds 200–205 are provisional,
//! not allocated).
//!
//! What it judges, over every successful program instruction:
//!
//! - **Coverage.** An instruction in the rights block 0xD0–0xDF that is not
//!   one of the six Grant instructions, or whose data does not decode, is
//!   a FAIL (`UnknownInstruction`, `RightsMalformed`); so is a successful
//!   instruction whose tag is neither ABI v2 nor a Grant tag (until the
//!   general coverage check of workstream 18 lands; then this branch
//!   duplicates it).
//! - **Records.** Each Grant instruction logged exactly one record of its
//!   kind (Issue → GRANT_ISSUED … Close → GRANT_CLOSED), for the Grant it
//!   names; a missing one is `RightsRecordMissing`, a record without its
//!   instruction `RightsRecordOrphan`.
//! - **Replay.** Each Grant's state is rebuilt from its records alone —
//!   terms, the escrow (units at the workshop ratio, `seq` equal to the
//!   executed swaps, the quota and the expiry), executed swaps, what an
//!   undo returned and kept — and compared with the Grant account the
//!   transaction left (`RightsRule` for a record the rules refuse,
//!   `RightsStateMismatch` for an account that differs). The holdings'
//!   writes are V7's (holding continuity rebuilds them from the same
//!   records).
//! - **Accounts.** A Grant account no GRANT_ISSUED explains, or written by
//!   a transaction with no Grant instruction, is `RightsUnexplainedAccount`;
//!   a program account of no known kind at all is `UnknownAccount`.
//! - **Evidence.** A Grant instruction whose post-states are not in the
//!   archive, or a holding it names whose state before it is unknown, is
//!   UNVERIFIABLE (`MissingData`), never a PASS.

use std::collections::BTreeMap;

use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::rights::{self as rt, layout as G, record as rec};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms;

use super::{ent, Ctx};
use crate::codes::*;
use crate::world::{le, Key};

const V: &str = "VR";

/// The record kind each Grant tag logs.
fn kind_of(tag: u8) -> Option<CqKind> {
    Some(match tag {
        rt::tag::ISSUE_GRANT => rec::ISSUED,
        rt::tag::RESERVE_SWAP => rec::RESERVED,
        rt::tag::EXECUTE_SWAP => rec::EXECUTED,
        rt::tag::RELEASE_SWAP => rec::RELEASED,
        rt::tag::REVOKE_GRANT => rec::REVOKED,
        rt::tag::CLOSE_GRANT => rec::CLOSED,
        _ => return None,
    })
}

/// `(account count, position of the Grant, of the facility, of the
/// station)` of each Grant instruction (the program's account lists).
fn layout_of(tag: u8) -> Option<(usize, usize, Option<usize>, Option<usize>)> {
    Some(match tag {
        rt::tag::ISSUE_GRANT => (10, 8, Some(4), Some(7)),
        rt::tag::RESERVE_SWAP | rt::tag::EXECUTE_SWAP | rt::tag::REVOKE_GRANT => {
            (8, 4, Some(5), Some(6))
        }
        rt::tag::RELEASE_SWAP => (7, 3, Some(4), Some(5)),
        rt::tag::CLOSE_GRANT => (4, 2, None, None),
        _ => return None,
    })
}

fn decodes(tag: u8, d: &[u8]) -> bool {
    match tag {
        rt::tag::ISSUE_GRANT => rt::IssueGrant::decode(d).is_ok(),
        rt::tag::RESERVE_SWAP => rt::ReserveSwap::decode(d).is_ok(),
        rt::tag::EXECUTE_SWAP => rt::ExecuteSwap::decode(d).is_ok(),
        rt::tag::RELEASE_SWAP => rt::ReleaseSwap::decode(d).is_ok(),
        rt::tag::REVOKE_GRANT => rt::RevokeGrant::decode(d).is_ok(),
        rt::tag::CLOSE_GRANT => rt::CloseGrant::decode(d).is_ok(),
        _ => false,
    }
}

/// A Grant as its records alone define it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Model {
    issuer_tag: u64,
    nonce: u32,
    grantee_tag: u64,
    p: i32,
    q: i32,
    facility: Key,
    station: Key,
    facility_site: u8,
    facility_gen: u8,
    station_site: u8,
    station_gen: u8,
    max_swaps: u16,
    max_units: u32,
    expires_ts: i64,
    state: u8,
    swaps: u16,
    units_swapped: u32,
    open_units: u32,
    open: [i64; 3],
    closed: bool,
}

impl Model {
    /// The differences between this model and a Grant account's bytes.
    fn diff(&self, d: &[u8], sid: u64) -> Option<String> {
        if d.len() != G::SIZE || d[..8] != G::MAGIC {
            return Some("not a Grant (size or magic)".into());
        }
        let u = |o: usize, n: usize| le(&d[o..o + n]);
        let arr = |o: usize| -> Key { d[o..o + 32].try_into().unwrap_or([0; 32]) };
        let checks: [(&str, u64, u64); 18] = [
            ("season_id", u(G::SEASON_ID, 8), sid),
            ("version", u(G::VERSION, 2), G::VERSION_1 as u64),
            ("kind", u(G::KIND, 1), rt::KIND_STOCK_SWAP as u64),
            ("state", u(G::STATE, 1), self.state as u64),
            (
                "facility_gen",
                u(G::FACILITY_GEN, 1),
                self.facility_gen as u64,
            ),
            ("station_gen", u(G::STATION_GEN, 1), self.station_gen as u64),
            (
                "facility_site",
                u(G::FACILITY_SITE, 1),
                self.facility_site as u64,
            ),
            (
                "station_site",
                u(G::STATION_SITE, 1),
                self.station_site as u64,
            ),
            ("nonce", u(G::NONCE, 4), self.nonce as u64),
            ("issuer_tag", u(G::ISSUER_TAG, 8), self.issuer_tag),
            ("expires_ts", u(G::EXPIRES_TS, 8), self.expires_ts as u64),
            ("max_swaps", u(G::MAX_SWAPS, 2), self.max_swaps as u64),
            ("swaps", u(G::SWAPS, 2), self.swaps as u64),
            ("max_units", u(G::MAX_UNITS, 4), self.max_units as u64),
            (
                "units_swapped",
                u(G::UNITS_SWAPPED, 4),
                self.units_swapped as u64,
            ),
            ("open_units", u(G::OPEN_UNITS, 4), self.open_units as u64),
            ("open_ore", u(G::OPEN_ORE, 8), self.open[0] as u64),
            ("open_wood", u(G::OPEN_WOOD, 8), self.open[1] as u64),
        ];
        for (name, got, want) in checks {
            if got != want {
                return Some(format!("{name} is {got}, the records give {want}"));
            }
        }
        if u(G::OPEN_ARMS, 8) != self.open[2] as u64 {
            return Some("open_arms differs from the records".into());
        }
        let p = d[G::P..G::P + 2]
            .try_into()
            .map(i16::from_le_bytes)
            .unwrap_or(0) as i32;
        let q = d[G::Q..G::Q + 2]
            .try_into()
            .map(i16::from_le_bytes)
            .unwrap_or(0) as i32;
        if (p, q) != (self.p, self.q) {
            return Some("the Province differs from the records".into());
        }
        if arr(G::FACILITY) != self.facility || arr(G::STATION) != self.station {
            return Some("the facility or the station differs from the records".into());
        }
        if rec::tag8(&arr(G::ISSUER_CITIZEN)) != self.issuer_tag
            || rec::tag8(&arr(G::GRANTEE_CITIZEN)) != self.grantee_tag
        {
            return Some("the issuer or the grantee differs from the records".into());
        }
        None
    }
}

/// Whether a program account's magic names a kind the verifier knows.
fn known_magic(d: &[u8]) -> bool {
    let Some(m) = d.get(..8).and_then(|m| <[u8; 8]>::try_from(m).ok()) else {
        return false;
    };
    K2::from_magic(&m).is_some() || m == G::MAGIC
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let sid = cx.cfg.season_id;
    let mut models: BTreeMap<Key, Model> = BTreeMap::new();
    let mut issued: std::collections::BTreeSet<Key> = Default::default();
    // Records of the Grant kinds, per transaction, in log order.
    let mut by_tx: BTreeMap<usize, Vec<&crate::world::CqRec>> = BTreeMap::new();
    for r in &w.cq_recs {
        if rec::is_rights(r.kind) {
            by_tx.entry(r.tx).or_default().push(r);
        }
    }
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        let mut recs = by_tx.remove(&t).unwrap_or_default();
        recs.sort_by_key(|r| r.pos);
        let mut recs = recs.into_iter();
        let mut rights_ix = false;
        for ix in &tx.ixs {
            let Some(tag) = ix.tag() else {
                cx.fail(
                    V,
                    UNKNOWN_INSTRUCTION,
                    format!("tx#{t}"),
                    0,
                    Some(t),
                    "a program instruction without data",
                );
                continue;
            };
            if frontier_abi::v2::Ix::from_tag(tag).is_some() {
                continue;
            }
            let Some(kind) = kind_of(tag) else {
                cx.fail(
                    V,
                    UNKNOWN_INSTRUCTION,
                    format!("tx#{t}"),
                    0,
                    Some(t),
                    format!("tag {tag:#04x} is neither ABI v2 nor a Grant instruction"),
                );
                continue;
            };
            rights_ix = true;
            let (n, gi, fi, si) = layout_of(tag).unwrap_or((0, 0, None, None));
            if !decodes(tag, &ix.data) || ix.accounts.len() != n {
                cx.fail(
                    V,
                    RIGHTS_MALFORMED,
                    format!("tx#{t}"),
                    0,
                    Some(t),
                    format!(
                        "{:?}: data or account list does not match the instruction",
                        kind
                    ),
                );
                continue;
            }
            let grant = ix.accounts[gi].0;
            let Some(r) = recs.next() else {
                cx.fail(
                    V,
                    RIGHTS_RECORD_MISSING,
                    ent("grant", &grant),
                    0,
                    Some(t),
                    format!("the instruction logged no {kind:?}"),
                );
                continue;
            };
            if r.kind != kind {
                cx.fail(
                    V,
                    RIGHTS_RECORD_MISSING,
                    ent("grant", &grant),
                    r.bell,
                    Some(t),
                    format!("the instruction logged {:?}, not {kind:?}", r.kind),
                );
                continue;
            }
            let Some((issuer_tag, nonce)) = rec::of_key(&r.key) else {
                cx.fail(
                    V,
                    RIGHTS_MALFORMED,
                    ent("grant", &grant),
                    r.bell,
                    Some(t),
                    "record key",
                );
                continue;
            };
            if rt::grant(&f.ctx, issuer_tag, nonce) != grant {
                cx.fail(
                    V,
                    RIGHTS_RULE,
                    ent("grant", &grant),
                    r.bell,
                    Some(t),
                    "the record names another Grant than the instruction's (address)",
                );
                continue;
            }
            // Evidence: the post-states, and the holdings' states before.
            if !w.has_post {
                cx.missing(
                    V,
                    ent("grant", &grant),
                    r.bell,
                    Some(t),
                    "no post-states in the archive: a Grant cannot be replayed",
                );
                continue;
            }
            let named = |site: u8, p: i32, q: i32| f.ctx.holding(p, q, site);
            let rule = |cx: &mut Ctx, what: String| {
                cx.fail(V, RIGHTS_RULE, ent("grant", &grant), r.bell, Some(t), what)
            };
            match kind {
                CqKind::GRANT_ISSUED => {
                    let Some(x) = rec::Issued::from_bytes(&r.payload) else {
                        cx.fail(
                            V,
                            RIGHTS_MALFORMED,
                            ent("grant", &grant),
                            r.bell,
                            Some(t),
                            "payload",
                        );
                        continue;
                    };
                    if models.get(&grant).is_some_and(|m| !m.closed) {
                        rule(cx, "a second GRANT_ISSUED for an open Grant".into());
                        continue;
                    }
                    let fk = named(x.facility_site, x.p, x.q);
                    let sk = named(x.station_site, x.p, x.q);
                    if fi.map(|i| ix.accounts[i].0) != Some(fk)
                        || si.map(|i| ix.accounts[i].0) != Some(sk)
                    {
                        rule(
                            cx,
                            "the record's facility or station is not the instruction's".into(),
                        );
                        continue;
                    }
                    if !rt::terms_ok(
                        rt::KIND_STOCK_SWAP,
                        x.max_swaps,
                        x.max_units,
                        x.expires_ts,
                        tx.time,
                    ) || x.rent != frontier_abi::layout::rent(G::SIZE)
                    {
                        rule(cx, "terms or rent the program refuses".into());
                        continue;
                    }
                    issued.insert(grant);
                    models.insert(
                        grant,
                        Model {
                            issuer_tag,
                            nonce,
                            grantee_tag: x.grantee_tag,
                            p: x.p,
                            q: x.q,
                            facility: fk,
                            station: sk,
                            facility_site: x.facility_site,
                            facility_gen: x.facility_gen,
                            station_site: x.station_site,
                            station_gen: x.station_gen,
                            max_swaps: x.max_swaps,
                            max_units: x.max_units,
                            expires_ts: x.expires_ts,
                            state: rt::STATE_ACTIVE,
                            swaps: 0,
                            units_swapped: 0,
                            open_units: 0,
                            open: [0; 3],
                            closed: false,
                        },
                    );
                }
                CqKind::SWAP_RESERVED | CqKind::SWAP_EXECUTED => {
                    let Some(x) = rec::Swap::from_bytes(&r.payload) else {
                        cx.fail(
                            V,
                            RIGHTS_MALFORMED,
                            ent("grant", &grant),
                            r.bell,
                            Some(t),
                            "payload",
                        );
                        continue;
                    };
                    let Some(m) = models.get_mut(&grant).filter(|m| !m.closed) else {
                        rule(cx, format!("{kind:?} for a Grant no GRANT_ISSUED opened"));
                        continue;
                    };
                    let e = [
                        x.units as i64 * arms::ORE_PER_ARM * MILLI,
                        x.units as i64 * arms::WOOD_PER_ARM * MILLI,
                        x.units as i64 * MILLI,
                    ];
                    let mut bad = vec![];
                    if (x.p, x.q, x.facility_site, x.station_site, x.grantee_tag)
                        != (m.p, m.q, m.facility_site, m.station_site, m.grantee_tag)
                    {
                        bad.push("the record's places or grantee differ from the Grant");
                    }
                    if fi.map(|i| ix.accounts[i].0) != Some(m.facility)
                        || si.map(|i| ix.accounts[i].0) != Some(m.station)
                    {
                        bad.push("the instruction's facility or station is not the Grant's");
                    }
                    if m.state != rt::STATE_ACTIVE || tx.time >= m.expires_ts {
                        bad.push("the Grant is revoked or expired");
                    }
                    if x.seq != m.swaps {
                        bad.push("seq is not the executed swap count");
                    }
                    if [x.ore, x.wood, x.arms] != e {
                        bad.push("the amounts are not the workshop ratio of the units");
                    }
                    if kind == CqKind::SWAP_RESERVED {
                        if m.open_units != 0 {
                            bad.push("a reservation is already open");
                        }
                        if rt::quota_allows(
                            m.max_swaps,
                            m.swaps,
                            m.max_units,
                            m.units_swapped,
                            x.units,
                        )
                        .is_err()
                        {
                            bad.push("the quota is passed");
                        }
                    } else if m.open_units == 0 || m.open_units != x.units || m.open != e {
                        bad.push("the executed amounts are not the open reservation");
                    }
                    if let Some(b) = bad.first() {
                        let msg = format!("{kind:?}: {b}");
                        rule(cx, msg);
                        continue;
                    }
                    if kind == CqKind::SWAP_RESERVED {
                        m.open_units = x.units;
                        m.open = e;
                    } else {
                        m.swaps += 1;
                        m.units_swapped += x.units;
                        m.open_units = 0;
                        m.open = [0; 3];
                    }
                }
                CqKind::SWAP_RELEASED | CqKind::GRANT_REVOKED => {
                    let Some(x) = rec::Undo::from_bytes(&r.payload) else {
                        cx.fail(
                            V,
                            RIGHTS_MALFORMED,
                            ent("grant", &grant),
                            r.bell,
                            Some(t),
                            "payload",
                        );
                        continue;
                    };
                    let Some(m) = models.get_mut(&grant).filter(|m| !m.closed) else {
                        rule(cx, format!("{kind:?} for a Grant no GRANT_ISSUED opened"));
                        continue;
                    };
                    let mut bad = vec![];
                    for i in 0..3 {
                        if x.returned[i] + x.kept[i] != m.open[i]
                            || x.returned[i] < 0
                            || x.kept[i] < 0
                        {
                            bad.push("returned and kept are not the escrow");
                        }
                    }
                    // A side goes back whole or not at all (ore and wood together).
                    if (x.returned[0] > 0) != (x.returned[1] > 0) && m.open[0] > 0 && m.open[1] > 0
                    {
                        bad.push("the station side went back in part");
                    }
                    if kind == CqKind::SWAP_RELEASED {
                        if m.open_units == 0 {
                            bad.push("nothing was escrowed");
                        }
                        if x.returned == [0; 3] {
                            bad.push("a release that returned nothing (the program refuses it)");
                        }
                        if x.by == rec::by::AFTER_EXPIRY && tx.time < m.expires_ts {
                            bad.push("a release after the expiry before the expiry");
                        }
                        if x.by > rec::by::STALE_HOLDING {
                            bad.push("unknown releaser");
                        }
                    } else {
                        if m.state != rt::STATE_ACTIVE {
                            bad.push("a revoke of a revoked Grant");
                        }
                        if x.by != rec::by::ISSUER {
                            bad.push("a revoke not by the issuer");
                        }
                    }
                    if let Some(b) = bad.first() {
                        let msg = format!("{kind:?}: {b}");
                        rule(cx, msg);
                        continue;
                    }
                    m.open = x.kept;
                    if x.kept == [0; 3] {
                        m.open_units = 0;
                    }
                    if kind == CqKind::GRANT_REVOKED {
                        m.state = rt::STATE_REVOKED;
                    }
                }
                CqKind::GRANT_CLOSED => {
                    let Some(x) = rec::Closed::from_bytes(&r.payload) else {
                        cx.fail(
                            V,
                            RIGHTS_MALFORMED,
                            ent("grant", &grant),
                            r.bell,
                            Some(t),
                            "payload",
                        );
                        continue;
                    };
                    let rent_to = ix.accounts[3].0;
                    let Some(m) = models.get_mut(&grant).filter(|m| !m.closed) else {
                        rule(cx, "GRANT_CLOSED for a Grant no GRANT_ISSUED opened".into());
                        continue;
                    };
                    let spent = m.swaps >= m.max_swaps || m.units_swapped >= m.max_units;
                    let done = m.state == rt::STATE_REVOKED || tx.time >= m.expires_ts || spent;
                    if m.open_units != 0
                        || m.open != [0; 3]
                        || !done
                        || x.rent_to8 != rec::tag8(&rent_to)
                    {
                        rule(cx, "a close the program refuses (escrow left, still usable, or another recipient)".into());
                        continue;
                    }
                    m.closed = true;
                }
                _ => {}
            }
            // The Grant account the transaction left.
            let post = tx.post.get(&grant);
            match (models.get(&grant), post) {
                (Some(m), Some(Some(a))) if !m.closed => {
                    if a.owner.to_bytes() != w.program {
                        cx.fail(
                            V,
                            RIGHTS_STATE_MISMATCH,
                            ent("grant", &grant),
                            r.bell,
                            Some(t),
                            "the Grant is not the program's",
                        );
                    } else if let Some(d) = m.diff(&a.data, sid) {
                        cx.fail(
                            V,
                            RIGHTS_STATE_MISMATCH,
                            ent("grant", &grant),
                            r.bell,
                            Some(t),
                            d,
                        );
                    }
                }
                (Some(m), Some(Some(a))) if m.closed => {
                    if a.owner.to_bytes() == w.program && !a.data.is_empty() {
                        cx.fail(
                            V,
                            RIGHTS_STATE_MISMATCH,
                            ent("grant", &grant),
                            r.bell,
                            Some(t),
                            "GRANT_CLOSED but the Grant still holds data",
                        );
                    }
                }
                (Some(m), Some(None)) if m.closed => {}
                (Some(_), _) => cx.missing(
                    V,
                    ent("grant", &grant),
                    r.bell,
                    Some(t),
                    "the Grant's post-state is not in the archive",
                ),
                (None, _) => {}
            }
            // The holdings named: their state before must be known (V7
            // rebuilds the writes from it).
            if let Some(m) = models.get(&grant) {
                for k in [m.facility, m.station] {
                    if tx.post.contains_key(&k) && w.state_before(&k, t).is_none() {
                        cx.missing(
                            V,
                            ent("holding", &k),
                            r.bell,
                            Some(t),
                            "a holding a Grant record moves has no state before it in the archive",
                        );
                    }
                }
            }
        }
        for r in recs {
            cx.fail(
                V,
                RIGHTS_RECORD_ORPHAN,
                format!("tx#{t}"),
                r.bell,
                Some(t),
                format!("{:?} without its Grant instruction", r.kind),
            );
        }
        // A Grant written by a transaction with no Grant instruction.
        if !rights_ix {
            for (k, a) in &tx.post {
                if a.as_ref().is_some_and(|a| {
                    a.owner.to_bytes() == w.program && a.data.get(..8) == Some(&G::MAGIC[..])
                }) {
                    cx.fail(
                        V,
                        RIGHTS_UNEXPLAINED_ACCOUNT,
                        ent("grant", k),
                        0,
                        Some(t),
                        "a Grant written by no Grant instruction",
                    );
                }
            }
        }
        // Any program account of no known kind.
        for (k, a) in &tx.post {
            if let Some(a) = a {
                if a.owner.to_bytes() == w.program && !a.data.is_empty() && !known_magic(&a.data) {
                    cx.fail(
                        V,
                        UNKNOWN_ACCOUNT,
                        ent("account", k),
                        0,
                        Some(t),
                        "a program account of no kind this verifier knows",
                    );
                }
            }
        }
    }
    for (_, rs) in by_tx {
        for r in rs {
            cx.fail(
                V,
                RIGHTS_RECORD_ORPHAN,
                format!("tx#{}", r.tx),
                r.bell,
                Some(r.tx),
                format!("{:?} in a failed or unknown transaction", r.kind),
            );
        }
    }
    // Final state: every Grant the archive leaves is explained by it.
    for (k, a) in &w.finals {
        let Some(a) = a else { continue };
        if a.owner.to_bytes() != w.program || a.data.is_empty() {
            continue;
        }
        if a.data.get(..8) == Some(&G::MAGIC[..]) {
            match models.get(k) {
                None => cx.fail(
                    V,
                    RIGHTS_UNEXPLAINED_ACCOUNT,
                    ent("grant", k),
                    0,
                    None,
                    "a Grant no GRANT_ISSUED of the archive opened",
                ),
                Some(m) if m.closed => cx.fail(
                    V,
                    RIGHTS_STATE_MISMATCH,
                    ent("grant", k),
                    0,
                    None,
                    "a closed Grant still exists",
                ),
                Some(m) => {
                    if let Some(d) = m.diff(&a.data, sid) {
                        cx.fail(
                            V,
                            RIGHTS_STATE_MISMATCH,
                            ent("grant", k),
                            0,
                            None,
                            format!("final state: {d}"),
                        );
                    }
                }
            }
        } else if !known_magic(&a.data) {
            cx.fail(
                V,
                UNKNOWN_ACCOUNT,
                ent("account", k),
                0,
                None,
                "a program account of no kind this verifier knows",
            );
        }
    }
    let _ = issued;
}

/// The expected bytes of holding `k` after a Grant instruction of
/// transaction `t` wrote it: its state `before`, settled to the block
/// time without an owner touch, then every Grant record of `t` that names
/// it applied in log order (a reserve pays, an execute and an undo credit).
/// `None` when no Grant instruction of `t` writes `k` (not this rule's);
/// when one does but no record names `k`, the unchanged bytes (so V7's
/// byte-identity reports the unrecorded write).
pub fn holding_write(
    w: &crate::world::World,
    f: &crate::facts::Facts,
    t: usize,
    k: &Key,
    before: &[u8],
) -> Option<(&'static str, Result<Vec<u8>, String>)> {
    use permutation_rules::frontier::holding::{Resource, RESOURCES};
    let tx = &w.txs[t];
    let writes = tx.ixs.iter().any(|ix| {
        ix.tag().and_then(kind_of).is_some() && ix.accounts.iter().any(|(a, wr)| a == k && *wr)
    });
    if !writes {
        return None;
    }
    let what = "a Grant instruction's holding (settle without a touch, then the records' amounts)";
    let mut ops: Vec<(bool, [i64; RESOURCES])> = vec![];
    let mut recs: Vec<&crate::world::CqRec> = w
        .cq_recs
        .iter()
        .filter(|r| r.tx == t && rec::is_rights(r.kind))
        .collect();
    recs.sort_by_key(|r| r.pos);
    for r in recs {
        let side = |p: i32, q: i32, fs: u8, ss: u8| -> (bool, bool) {
            (f.ctx.holding(p, q, ss) == *k, f.ctx.holding(p, q, fs) == *k)
        };
        let mut c = [0i64; RESOURCES];
        let ore = Resource::Ore as usize;
        let wood = Resource::Wood as usize;
        let am = arms::ARMS as usize;
        match r.kind {
            CqKind::SWAP_RESERVED | CqKind::SWAP_EXECUTED => {
                let Some(x) = rec::Swap::from_bytes(&r.payload) else {
                    return Some((what, Err("a Grant record does not decode".into())));
                };
                let (st, fa) = side(x.p, x.q, x.facility_site, x.station_site);
                let pay = r.kind == CqKind::SWAP_RESERVED;
                if st {
                    if pay {
                        c[ore] = x.ore;
                        c[wood] = x.wood;
                    } else {
                        c[am] = x.arms;
                    }
                    ops.push((pay, c));
                } else if fa {
                    if pay {
                        c[am] = x.arms;
                    } else {
                        c[ore] = x.ore;
                        c[wood] = x.wood;
                    }
                    ops.push((pay, c));
                }
            }
            CqKind::SWAP_RELEASED | CqKind::GRANT_REVOKED => {
                let Some(x) = rec::Undo::from_bytes(&r.payload) else {
                    return Some((what, Err("a Grant record does not decode".into())));
                };
                let (st, fa) = side(x.p, x.q, x.facility_site, x.station_site);
                if st && (x.returned[0] > 0 || x.returned[1] > 0) {
                    c[ore] = x.returned[0];
                    c[wood] = x.returned[1];
                    ops.push((false, c));
                } else if fa && x.returned[2] > 0 {
                    c[am] = x.returned[2];
                    ops.push((false, c));
                }
            }
            _ => {}
        }
    }
    if ops.is_empty() {
        return Some((what, Ok(before.to_vec())));
    }
    let want = (|| -> Result<Vec<u8>, String> {
        let mut h = crate::holding::read_settled(before, tx.time)?;
        for (pay, c) in &ops {
            if *pay {
                h.pay(tx.time, c).map_err(|e| format!("pay: {e:?}"))?;
            } else {
                for (r, v) in c.iter().enumerate() {
                    if *v > 0 {
                        h.credit(tx.time, Resource::ALL[r], *v)
                            .map_err(|e| format!("credit: {e:?}"))?;
                    }
                }
            }
        }
        let mut d = before.to_vec();
        crate::holding::write(&mut d, &h, tx.time)?;
        Ok(d)
    })();
    Some((what, want))
}
