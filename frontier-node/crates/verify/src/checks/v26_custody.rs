//! V26 guard (workstream 10, custody), listed as `V26:custody-guard`. The
//! custody check is not complete (V26 replays the instructions that touch
//! one lot, not the custody caravans nor the records), so a history that
//! carries any custody trace is never a PASS:
//!
//! - in a season whose program has no custody (every ruleset up to
//!   `RULESET_HASH_V3`; the S1 program refuses the tags) a trace is a FAIL,
//!   `CustodyInProgramWithoutIt`;
//! - in a custody season (`RULESET_HASH_V4`, or a Season of
//!   `program_version >= PROGRAM_VERSION_CUSTODY`) it is UNVERIFIABLE,
//!   `CustodyUnverified`.
//!
//! In a custody season, `V26:custody-state` also re-judges what the
//! accounts alone settle (see [`audit`]), `V26:custody-history` what every
//! custody step keeps between a lot's recorded states (see [`history`]),
//! and `V26:custody-replay` runs each landed OpenLot, SetLotQuota,
//! SetLotOrder, RevokeLotOrder, ConsumeLot and CloseLot through the kernel
//! on the states recorded before it (see [`replay`]). What they find wrong
//! is a FAIL whatever the rest; none of them upgrades the season: the best
//! a custody season gets is UNVERIFIABLE.
//!
//! A trace is: a custody instruction (0xC2–0xCC) of a landed transaction
//! (top level: a CPI is caught by what it leaves), a custody record
//! (`LOT_*`, a Lot's CLOSE), or, in any post-state or final account of the
//! program, a Lot, a Vault with custody counts, a Caravan with custody
//! fields. A failed transaction carrying a custody tag is not a trace (the
//! program refused it).

use frontier_abi::v2::layout::s1::{caravan as CV, lot as LT, vault as VA};
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::presets::{PROGRAM_VERSION_CUSTODY, RULESET_HASH_V4};
use frontier_abi::v2::Ix;

use super::{ent, Ctx};
use crate::codes::{
    CUSTODY_HISTORY_BROKEN, CUSTODY_HISTORY_UNEXPLAINED, CUSTODY_IN_PROGRAM_WITHOUT_IT,
    CUSTODY_LOT_BROKEN, CUSTODY_OVER_CAPACITY, CUSTODY_REPLAY_INCOMPLETE, CUSTODY_REPLAY_MISMATCH,
    CUSTODY_RULE_UNDECIDED, CUSTODY_UNVERIFIED, CUSTODY_VAULT_COUNTS,
};
use crate::Severity;

const V: &str = "V26";

// V26's own UNVERIFIABLE helpers, kept here rather than on `Ctx`:
// workstream 18's V0 adds `Ctx::unverifiable` with the same signature, and
// two definitions would not compile when both are integrated.

/// What V26 found cannot be verified by this build (UNVERIFIABLE unless a
/// FAIL exists), under its own code.
fn unverifiable(
    cx: &mut Ctx,
    check: &'static str,
    code: &str,
    entity: impl Into<String>,
    bell: u32,
    tx: Option<usize>,
    detail: impl Into<String>,
) {
    cx.push(
        Severity::Unverifiable,
        check,
        code,
        entity.into(),
        bell,
        tx,
        detail.into(),
    );
}

/// A FAIL when `fail`, else UNVERIFIABLE (the state audit).
fn fail_or_unverifiable(
    cx: &mut Ctx,
    check: &'static str,
    code: &str,
    fail: bool,
    entity: impl Into<String>,
    tx: Option<usize>,
    detail: impl Into<String>,
) {
    if fail {
        cx.fail(check, code, entity, u32::MAX, tx, detail);
    } else {
        unverifiable(cx, check, code, entity, u32::MAX, tx, detail);
    }
}
/// Findings listed one by one before the rest is counted in one line.
const LISTED: usize = 16;

/// Whether the season is a custody one.
pub fn custody_season(cx: &Ctx) -> bool {
    cx.cfg.ruleset_hash == RULESET_HASH_V4
        || cx.input.finals.values().flatten().any(|a| {
            fclient::decode::Season::decode(&a.data)
                .is_ok_and(|s| s.program_version >= PROGRAM_VERSION_CUSTODY)
        })
}

const LOT_KINDS: [CqKind; 9] = [
    CqKind::LOT_OPENED,
    CqKind::LOT_QUOTA,
    CqKind::LOT_INBOUND,
    CqKind::LOT_SHIPPED,
    CqKind::LOT_SETTLED,
    CqKind::LOT_ORDER,
    CqKind::LOT_REVOKED,
    CqKind::LOT_CONSUMED,
    CqKind::LOT_LOSS,
];

/// What custody leaves in an account of the program, if anything.
fn account_trace(d: &[u8]) -> Option<&'static str> {
    let magic = d.get(..8)?;
    let nonzero = |o: usize, n: usize| d.get(o..o + n).is_some_and(|b| b.iter().any(|x| *x != 0));
    if magic == LT::MAGIC {
        return Some("a Lot account");
    }
    if magic == VA::MAGIC && (nonzero(VA::CUSTODY_QUOTA, 64) || nonzero(VA::CUSTODY_LOTS, 2)) {
        return Some("a Vault with custody counts");
    }
    if magic == CV::MAGIC
        && (nonzero(CV::CUSTODY, 2)
            || nonzero(CV::CUSTODY_OWNER_TAG, 8)
            || nonzero(CV::TAKEN_BY_TAG, 8))
    {
        return Some("a Caravan with custody fields");
    }
    None
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let program = w.program;
    let mut traces: Vec<(String, u32, Option<usize>, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        for ix in &tx.ixs {
            if let Some(x) = ix.tag().and_then(Ix::from_tag).filter(|x| x.is_custody()) {
                traces.push((
                    "transaction".into(),
                    u32::MAX,
                    Some(t),
                    format!("a landed {} instruction", x.name()),
                ));
            }
        }
        for (k, a) in &tx.post {
            if let Some(a) = a.as_ref().filter(|a| a.owner.to_bytes() == program) {
                if let Some(what) = account_trace(&a.data) {
                    traces.push((
                        ent("account", k),
                        u32::MAX,
                        Some(t),
                        format!("{what} after it"),
                    ));
                }
            }
        }
    }
    for r in &w.cq_recs {
        if LOT_KINDS.contains(&r.kind) {
            traces.push((
                "transaction".into(),
                r.bell,
                Some(r.tx),
                format!("record {} is custody's {}", r.pos, r.kind.name()),
            ));
        }
    }
    let lot_kind = frontier_abi::v2::layout::AccountKind::Lot as u8;
    for r in &w.recs {
        if r.kind == frontier_abi::log::Kind::CLOSE && r.key.first() == Some(&lot_kind) {
            traces.push((
                "transaction".into(),
                r.bell,
                Some(r.tx),
                format!("record {} closes a Lot", r.pos),
            ));
        }
    }
    for (k, a) in &w.finals {
        if let Some(a) = a.as_ref().filter(|a| a.owner.to_bytes() == program) {
            if let Some(what) = account_trace(&a.data) {
                traces.push((
                    ent("account", k),
                    u32::MAX,
                    None,
                    format!("{what} at the pinned slot"),
                ));
            }
        }
    }
    if traces.is_empty() {
        return;
    }
    let custody = custody_season(cx);
    if custody {
        audit(cx);
        history(cx);
        replay(cx);
    }
    let n = traces.len();
    for (i, (entity, bell, tx, what)) in traces.into_iter().enumerate() {
        if i == LISTED {
            let rest = format!("{} more custody traces", n - LISTED);
            if custody {
                unverifiable(cx, V, CUSTODY_UNVERIFIED, "season", u32::MAX, None, rest);
            } else {
                cx.fail(
                    V,
                    CUSTODY_IN_PROGRAM_WITHOUT_IT,
                    "season",
                    u32::MAX,
                    None,
                    rest,
                );
            }
            break;
        }
        if custody {
            unverifiable(
                cx,
                V,
                CUSTODY_UNVERIFIED,
                entity,
                bell,
                tx,
                format!(
                    "{what}: custody is not verified (V26 does not replay caravans or records yet)"
                ),
            );
        } else {
            cx.fail(
                V,
                CUSTODY_IN_PROGRAM_WITHOUT_IT,
                entity,
                bell,
                tx,
                format!("{what} in a season whose program has no custody"),
            );
        }
    }
}

// ------------------------------------------------------------ state audit

/// One finding of the state audit: (code, FAIL or not, detail).
type Found = (&'static str, bool, String);

/// What one Lot account alone settles. Each law is the kernel's
/// (`permutation_rules::frontier::custody`): every instruction checks it
/// before writing, so an account that breaks it was not written by the
/// custody program, whatever the transactions say.
///
/// Not judged here (left to the replay, hence UNVERIFIABLE): reserved ≤
/// held (it holds only for orders live at the current bell, which the
/// accounts do not carry), the lot's address, who signed, and anything
/// about a forfeited lot beyond its totals (forfeiture is ⑩'s proposal,
/// not a decided rule).
pub fn lot_findings(d: &[u8]) -> Vec<Found> {
    use permutation_rules::fixed::MILLI;
    use permutation_rules::frontier::custody as K;
    let mut out: Vec<Found> = vec![];
    let Some(l) = K::Lot::decode(d) else {
        out.push((
            CUSTODY_LOT_BROKEN,
            true,
            format!("a Lot of {} bytes does not decode", d.len()),
        ));
        return out;
    };
    let mut broken = |what: String| out.push((CUSTODY_LOT_BROKEN, true, what));
    let totals = [
        ("QUOTA", l.quota),
        ("HELD", l.held),
        ("IN_TOTAL", l.in_total),
        ("OUT_TOTAL", l.out_total),
        ("CONSUMED", l.consumed),
        ("FORFEITED", l.forfeited),
    ];
    for (name, v) in totals {
        if v < 0 {
            broken(format!("{name} is {v}"));
        }
    }
    let rhs = l
        .held
        .checked_add(l.out_total)
        .and_then(|x| x.checked_add(l.consumed))
        .and_then(|x| x.checked_add(l.forfeited));
    if rhs != Some(l.in_total) {
        broken(format!(
            "IN_TOTAL {} != HELD {} + OUT_TOTAL {} + CONSUMED {} + FORFEITED {}",
            l.in_total, l.held, l.out_total, l.consumed, l.forfeited
        ));
    }
    // Only a use order's grantee consumes (`consume` spends an order), and
    // every order is set at the lot's NONCE, which `set_order` then moves
    // on: goods used from a lot that never had an order were not used by
    // the program (workstream 9's workshop deposit is such a use).
    if l.consumed > 0 && l.nonce == 0 {
        broken(format!(
            "CONSUMED {} with no order ever set (NONCE 0)",
            l.consumed
        ));
    }
    // Only `forfeit` books FORFEITED, and it leaves the lot forfeited (or
    // closed after): an open lot cannot carry it.
    if l.forfeited > 0 && l.state == K::LOT_OPEN {
        broken(format!("an open lot with FORFEITED {}", l.forfeited));
    }
    if (l.resource as usize) >= permutation_rules::frontier::holding::RESOURCES
        || K::ENABLED_RESOURCES & (1 << l.resource) == 0
    {
        broken(format!(
            "resource {} is not enabled for custody",
            l.resource
        ));
    }
    if l.quota % MILLI != 0 {
        broken(format!("QUOTA {} is not whole units", l.quota));
    }
    let mut ids = vec![];
    for (i, o) in l.orders.iter().enumerate() {
        match o.kind {
            K::ORDER_FREE => {
                if *o != K::Order::default() {
                    broken(format!("free order slot {i} is not empty"));
                }
                continue;
            }
            K::ORDER_SHIP => {
                if o.dst.kind != K::PLACE_VAULT
                    || (o.dst.p, o.dst.q, o.dst.tile) == (l.p, l.q, l.tile)
                    || o.purpose != 0
                {
                    broken(format!("ship order {i} does not name another vault"));
                }
            }
            K::ORDER_USE => {
                if o.dst != K::PlaceRef::default() {
                    broken(format!("use order {i} names a destination"));
                }
            }
            k => broken(format!("order slot {i} has kind {k}")),
        }
        if o.qty_left <= 0 {
            broken(format!("order {i} is set with QTY_LEFT {}", o.qty_left));
        }
        if o.id >= l.nonce {
            broken(format!(
                "order {i} has id {} at or above NONCE {}",
                o.id, l.nonce
            ));
        }
        if o.grantee == l.owner {
            broken(format!("order {i} is granted to the owner"));
        }
        if ids.contains(&o.id) {
            broken(format!("order id {} is set twice", o.id));
        }
        ids.push(o.id);
    }
    let mut seen = vec![];
    for (i, b) in l.inbound.iter().enumerate() {
        if !b.live {
            if *b != K::Inbound::default() {
                broken(format!("free inbound slot {i} is not empty"));
            }
            continue;
        }
        if b.qty <= 0 {
            broken(format!("inbound {i} expects {}", b.qty));
        }
        if seen.contains(&(b.caravan_tag, b.seq)) {
            broken(format!(
                "inbound caravan {:#x}/{} is expected twice",
                b.caravan_tag, b.seq
            ));
        }
        seen.push((b.caravan_tag, b.seq));
    }
    let incoming = l
        .inbound
        .iter()
        .filter(|b| b.live)
        .try_fold(0i64, |a, b| a.checked_add(b.qty));
    match l.state {
        K::LOT_OPEN => match incoming.and_then(|x| x.checked_add(l.held)) {
            Some(n) if n <= l.quota => {}
            _ => out.push((
                CUSTODY_OVER_CAPACITY,
                true,
                format!(
                    "HELD {} + expected {:?} > QUOTA {}",
                    l.held, incoming, l.quota
                ),
            )),
        },
        K::LOT_FORFEITED => out.push((
            CUSTODY_RULE_UNDECIDED,
            false,
            format!(
                "a forfeited lot ({} forfeited): forfeiture is not a decided rule",
                l.forfeited
            ),
        )),
        K::LOT_NONE => {
            if l.held != 0 || ids.len() + seen.len() != 0 {
                broken("a closed lot still holds or expects goods".into());
            }
        }
        k => broken(format!("STATE {k}")),
    }
    out
}

/// What one Vault account alone settles: `STORES + CUSTODY_QUOTA ≤ CAP`
/// for a live vault (the kernel's open and quota steps and the amended
/// SettleCaravan keep it), and no negative commitment.
pub fn vault_findings(d: &[u8]) -> Vec<Found> {
    use crate::world::le;
    let mut out: Vec<Found> = vec![];
    if d.len() < VA::SIZE {
        return out;
    }
    let cap = le(&d[VA::CAP..VA::CAP + 8]) as i64;
    for r in 0..8 {
        let st = le(&d[VA::store(r)..VA::store(r) + 8]) as i64;
        let q = le(&d[VA::custody_quota(r)..VA::custody_quota(r) + 8]) as i64;
        if q < 0 {
            out.push((
                CUSTODY_LOT_BROKEN,
                true,
                format!("CUSTODY_QUOTA[{r}] is {q}"),
            ));
        } else if d[VA::STATE] == VA::STATE_LIVE && st.checked_add(q).is_none_or(|n| n > cap) {
            out.push((
                CUSTODY_OVER_CAPACITY,
                true,
                format!("STORES[{r}] {st} + CUSTODY_QUOTA[{r}] {q} > CAP {cap}"),
            ));
        }
    }
    out
}

/// The custody state audit (`V26:custody-state`), custody seasons only:
/// every Lot and Vault of the program in a post-state and at the pinned
/// slot, and, at the pinned slot (one consistent snapshot), each vault's
/// counts against the open lots in it that are visible. A vault's counts
/// can only be too low against what is visible (an account the input lacks
/// lowers the visible sum, never raises it), so only that is a FAIL.
pub fn audit(cx: &mut Ctx) {
    use permutation_rules::frontier::custody as K;
    let w = cx.w;
    let program = w.program;
    let mut found: Vec<(String, Option<usize>, Found)> = vec![];
    let judge = |k: &[u8; 32], t: Option<usize>, d: &[u8], found: &mut Vec<_>| {
        let at = match d.get(..8) {
            Some(m) if m == LT::MAGIC => lot_findings(d),
            Some(m) if m == VA::MAGIC => vault_findings(d),
            _ => return,
        };
        for f in at {
            found.push((ent("account", k), t, f));
        }
    };
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        for (k, a) in &tx.post {
            if let Some(a) = a.as_ref().filter(|a| a.owner.to_bytes() == program) {
                judge(k, Some(t), &a.data, &mut found);
            }
        }
    }
    // The pinned slot: each account alone, then each vault's counts.
    let mut lots: Vec<K::Lot> = vec![];
    let mut vaults: Vec<(&[u8; 32], &[u8])> = vec![];
    for (k, a) in &w.finals {
        let Some(a) = a.as_ref().filter(|a| a.owner.to_bytes() == program) else {
            continue;
        };
        judge(k, None, &a.data, &mut found);
        match a.data.get(..8) {
            Some(m) if m == LT::MAGIC => lots.extend(K::Lot::decode(&a.data)),
            Some(m) if m == VA::MAGIC && a.data.len() >= VA::SIZE => vaults.push((k, &a.data)),
            _ => {}
        }
    }
    for (k, d) in vaults {
        use crate::world::le;
        let p = le(&d[VA::P..VA::P + 2]) as u16 as i16;
        let q = le(&d[VA::Q..VA::Q + 2]) as u16 as i16;
        let (tile, gen) = (d[VA::TILE], d[VA::GEN]);
        let here: Vec<&K::Lot> = lots
            .iter()
            .filter(|l| (l.p, l.q, l.tile) == (p, q, tile) && l.state == K::LOT_OPEN)
            .collect();
        let count = le(&d[VA::CUSTODY_LOTS..VA::CUSTODY_LOTS + 2]) as usize;
        if here.len() > count {
            found.push((
                ent("account", k),
                None,
                (
                    CUSTODY_VAULT_COUNTS,
                    true,
                    format!("{} open lots in it, CUSTODY_LOTS {count}", here.len()),
                ),
            ));
        }
        for r in 0..8u8 {
            let committed =
                le(&d[VA::custody_quota(r as usize)..VA::custody_quota(r as usize) + 8]) as i64;
            let visible = here
                .iter()
                .filter(|l| l.resource == r)
                .try_fold(0i64, |a, l| a.checked_add(l.quota));
            if visible.is_none_or(|v| v > committed) {
                found.push((
                    ent("account", k),
                    None,
                    (
                        CUSTODY_VAULT_COUNTS,
                        true,
                        format!("open lots' quotas {visible:?} of resource {r} > CUSTODY_QUOTA {committed}"),
                    ),
                ));
            }
        }
        for l in &here {
            if l.vault_gen > gen {
                found.push((
                    ent("account", k),
                    None,
                    (
                        CUSTODY_VAULT_COUNTS,
                        true,
                        format!(
                            "an open lot of generation {} in a vault of generation {gen}",
                            l.vault_gen
                        ),
                    ),
                ));
            } else if l.vault_gen < gen {
                found.push((
                    ent("account", k),
                    None,
                    (
                        CUSTODY_RULE_UNDECIDED,
                        false,
                        format!("an open lot of generation {} in a seized vault (generation {gen}): what seizure does to it is not decided", l.vault_gen),
                    ),
                ));
            }
        }
    }
    let n = found.len();
    for (i, (entity, tx, (code, fail, what))) in found.into_iter().enumerate() {
        if i == LISTED {
            fail_or_unverifiable(
                cx,
                V,
                code,
                fail,
                "season",
                None,
                format!("{} more custody state findings", n - LISTED),
            );
            break;
        }
        fail_or_unverifiable(cx, V, code, fail, entity, tx, what);
    }
}

// ------------------------------------------------------- history (partial)

/// What one Lot account's change between two recorded states settles,
/// whatever the instructions were (their arguments are not decoded: the
/// ABI numbers are provisional). Every custody step keeps these, so a
/// change that breaks one was not the custody program's:
///
/// - the lot's identity (`P, Q, tile, VAULT_GEN, RESOURCE, OWNER`, its
///   tags, `OPENED_BELL`) never changes;
/// - `IN_TOTAL`, `OUT_TOTAL`, `FORFEITED` and `NONCE` never go down
///   (`CONSUMED` may: `return_unused` gives unused goods back);
/// - the state only goes forward: open → forfeited → closed, open → closed;
/// - an order keeps its terms (kind, purpose, expiry, destination,
///   grantee) while it keeps its id, and its `QTY_LEFT` never grows;
/// - an inbound caravan expected under the same tag and sequence keeps
///   its quantity.
///
/// A closed lot's account may be opened again at the same address (a new
/// lot): no comparison across a close. Not judged (the replay proper,
/// still to come): which instruction did it, who signed, the amounts each
/// step should have moved.
pub fn lot_transition_findings(prev: &[u8], cur: &[u8]) -> Vec<String> {
    use permutation_rules::frontier::custody as K;
    let (Some(a), Some(b)) = (K::Lot::decode(prev), K::Lot::decode(cur)) else {
        return vec![]; // a lot that does not decode is the audit's
    };
    if a.state == K::LOT_NONE {
        return vec![];
    }
    let mut out = vec![];
    let id = |l: &K::Lot| {
        (
            (l.p, l.q, l.tile, l.vault_gen, l.resource),
            (l.owner, l.owner_tag, l.custodian_tag, l.opened_bell),
        )
    };
    if id(&a) != id(&b) {
        out.push("the lot's identity changed".to_string());
    }
    for (name, x, y) in [
        ("IN_TOTAL", a.in_total, b.in_total),
        ("OUT_TOTAL", a.out_total, b.out_total),
        ("FORFEITED", a.forfeited, b.forfeited),
        ("NONCE", a.nonce as i64, b.nonce as i64),
    ] {
        if y < x {
            out.push(format!("{name} went down from {x} to {y}"));
        }
    }
    let forward = matches!(
        (a.state, b.state),
        (K::LOT_OPEN, K::LOT_OPEN | K::LOT_FORFEITED | K::LOT_NONE)
            | (K::LOT_FORFEITED, K::LOT_FORFEITED | K::LOT_NONE)
    );
    if !forward {
        out.push(format!("STATE went from {} to {}", a.state, b.state));
    }
    for (i, (x, y)) in a.orders.iter().zip(b.orders.iter()).enumerate() {
        if x.kind == K::ORDER_FREE || y.kind == K::ORDER_FREE || x.id != y.id {
            continue;
        }
        let terms = |o: &K::Order| (o.kind, o.purpose, o.expires_bell, o.dst, o.grantee);
        if terms(x) != terms(y) {
            out.push(format!("order {i} (id {}) changed its terms", x.id));
        }
        if y.qty_left > x.qty_left {
            out.push(format!(
                "order {i} (id {}) grew from {} to {}",
                x.id, x.qty_left, y.qty_left
            ));
        }
    }
    // Order bookkeeping. `set_order` gives a new order the id NONCE and
    // then moves NONCE on; so a new order's id lies in [old NONCE, new
    // NONCE), and there are no more new orders than NONCE moved.
    let new_orders: Vec<&K::Order> = b
        .orders
        .iter()
        .zip(a.orders.iter())
        .filter(|(y, x)| y.kind != K::ORDER_FREE && !(x.kind != K::ORDER_FREE && x.id == y.id))
        .map(|(y, _)| y)
        .collect();
    for y in &new_orders {
        if y.id < a.nonce || y.id >= b.nonce {
            out.push(format!(
                "a new order has id {} outside [{}, {})",
                y.id, a.nonce, b.nonce
            ));
        }
    }
    if (new_orders.len() as u64) > (b.nonce as u64).saturating_sub(a.nonce as u64) {
        out.push(format!(
            "{} new orders but NONCE moved by {}",
            new_orders.len(),
            b.nonce.saturating_sub(a.nonce)
        ));
    }
    // Only a use order's grantee consumes, from that order's remainder.
    // With no order set in between (NONCE unchanged), what was consumed is
    // at most what the use orders already there gave up (returns only
    // lower CONSUMED, so the bound holds for the net change too).
    if a.nonce == b.nonce {
        let gave: i64 = a
            .orders
            .iter()
            .zip(b.orders.iter())
            .filter(|(x, _)| x.kind == K::ORDER_USE)
            .map(|(x, y)| {
                if y.kind == x.kind && y.id == x.id {
                    (x.qty_left - y.qty_left).max(0)
                } else {
                    x.qty_left
                }
            })
            .sum();
        if b.consumed - a.consumed > gave {
            out.push(format!(
                "CONSUMED grew by {} with no new order; the use orders gave {gave}",
                b.consumed - a.consumed
            ));
        }
    }
    for x in a.inbound.iter().filter(|i| i.live) {
        if let Some(y) = b.inbound.iter().find(|y| y.is(x.caravan_tag, x.seq)) {
            if y.qty != x.qty {
                out.push(format!(
                    "inbound {:#x}/{} changed from {} to {}",
                    x.caravan_tag, x.seq, x.qty, y.qty
                ));
            }
        }
    }
    out
}

/// What the recorded change does not show the cause of, though no rule
/// is broken: `IN_TOTAL` grew by more than the caravans expected before
/// and gone after could deliver (a caravan delivers at most what it was
/// expected with). The program may have begun and settled one between two
/// records; without the instructions replayed this is UNVERIFIABLE, not a
/// FAIL.
pub fn lot_transition_unexplained(prev: &[u8], cur: &[u8]) -> Vec<String> {
    use permutation_rules::frontier::custody as K;
    let (Some(a), Some(b)) = (K::Lot::decode(prev), K::Lot::decode(cur)) else {
        return vec![];
    };
    if a.state == K::LOT_NONE {
        return vec![];
    }
    let settled: i64 = a
        .inbound
        .iter()
        .filter(|x| x.live && !b.inbound.iter().any(|y| y.is(x.caravan_tag, x.seq)))
        .map(|x| x.qty)
        .sum();
    let grew = b.in_total - a.in_total;
    if grew > settled {
        vec![format!(
            "IN_TOTAL grew by {grew}; the caravans settled since could deliver {settled}"
        )]
    } else {
        vec![]
    }
}

/// `V26:custody-history`: every Lot account's recorded states, in
/// transaction order (post-states), then the pinned slot, compared pairwise
/// by [`lot_transition_findings`]. A FAIL names the transaction that
/// recorded the later state.
pub fn history(cx: &mut Ctx) {
    let w = cx.w;
    let program = w.program;
    let mut last: std::collections::BTreeMap<[u8; 32], Vec<u8>> = Default::default();
    let mut found: Vec<(String, Option<usize>, String)> = vec![];
    let mut unexplained: Vec<(String, Option<usize>, String)> = vec![];
    let is_lot = |d: &[u8]| d.get(..8) == Some(&LT::MAGIC[..]);
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        for (k, a) in &tx.post {
            let Some(a) = a
                .as_ref()
                .filter(|a| a.owner.to_bytes() == program && is_lot(&a.data))
            else {
                continue;
            };
            if let Some(prev) = last.get(k) {
                for what in lot_transition_findings(prev, &a.data) {
                    found.push((ent("account", k), Some(t), what));
                }
                for what in lot_transition_unexplained(prev, &a.data) {
                    unexplained.push((ent("account", k), Some(t), what));
                }
            }
            last.insert(*k, a.data.clone());
        }
    }
    for (k, a) in &w.finals {
        if let (Some(a), Some(prev)) = (
            a.as_ref().filter(|a| a.owner.to_bytes() == program),
            last.get(k),
        ) {
            if is_lot(&a.data) {
                for what in lot_transition_findings(prev, &a.data) {
                    found.push((
                        ent("account", k),
                        None,
                        format!("{what} (at the pinned slot)"),
                    ));
                }
            }
        }
    }
    for (entity, tx, what) in unexplained.into_iter().take(LISTED) {
        unverifiable(
            cx,
            V,
            CUSTODY_HISTORY_UNEXPLAINED,
            entity,
            u32::MAX,
            tx,
            what,
        );
    }
    let n = found.len();
    for (i, (entity, tx, what)) in found.into_iter().enumerate() {
        if i == LISTED {
            cx.fail(
                V,
                CUSTODY_HISTORY_BROKEN,
                "season",
                u32::MAX,
                None,
                format!("{} more custody history findings", n - LISTED),
            );
            break;
        }
        cx.fail(V, CUSTODY_HISTORY_BROKEN, entity, u32::MAX, tx, what);
    }
}

// ------------------------------------------------------------ replay

/// What the replay concluded for one landed custody instruction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Replayed {
    /// The kernel, run on the accounts as they were before the transaction
    /// with the instruction's own arguments and signer, writes exactly what
    /// the transaction left in the lot (and the vault's custody counts).
    Matches,
    /// It does not, or the kernel refuses the instruction: a FAIL.
    Mismatch(String),
    /// The input lacks what the replay needs (a state before or after), or
    /// the instruction is not replayed by this build: UNVERIFIABLE.
    Unreplayed(String),
}

/// An account's data before a transaction (`None`: not in the input).
pub type StateBefore<'a> = &'a dyn Fn(&[u8; 32]) -> Option<Vec<u8>>;
/// An account after a transaction: `None` not in its post-state,
/// `Some(None)` closed, `Some(Some(data))` its data.
pub type StateAfter<'a> = &'a dyn Fn(&[u8; 32]) -> Option<Option<Vec<u8>>>;

/// One custody instruction and the evidence around it, for [`replay_ix`].
pub struct ReplayCase<'a> {
    /// The instruction's data, with its tag.
    pub data: &'a [u8],
    /// Its account keys, in order (`[actor, payer, season, citizen, …]`).
    pub accounts: &'a [[u8; 32]],
    /// The transaction's block time (the program's clock).
    pub time: i64,
    /// The bell at `time` (`bell_at(genesis_ts, time)`), if known.
    pub bell: Option<u32>,
    /// An account's data before the transaction (`None`: not in the input).
    pub before: StateBefore<'a>,
    /// An account after it: `None` not in the transaction's post-state,
    /// `Some(None)` closed, `Some(Some(data))` its data.
    pub after: StateAfter<'a>,
}

/// The kernel's view of a Vault account (the program's `vault_view`; the
/// address checks are V9's).
pub fn vault_view_of(d: &[u8]) -> Option<permutation_rules::frontier::custody::VaultView> {
    use crate::world::le;
    use permutation_rules::frontier::holding::RESOURCES;
    if d.len() < VA::SIZE || d.get(..8) != Some(&VA::MAGIC[..]) {
        return None;
    }
    let mut stores = [0i64; RESOURCES];
    let mut quota = [0i64; RESOURCES];
    for i in 0..RESOURCES {
        stores[i] = le(&d[VA::store(i)..VA::store(i) + 8]) as i64;
        quota[i] = le(&d[VA::custody_quota(i)..VA::custody_quota(i) + 8]) as i64;
    }
    Some(permutation_rules::frontier::custody::VaultView {
        p: le(&d[VA::P..VA::P + 2]) as u16 as i16,
        q: le(&d[VA::Q..VA::Q + 2]) as u16 as i16,
        tile: d[VA::TILE],
        gen: d[VA::GEN],
        live: d[VA::STATE] == VA::STATE_LIVE,
        owner: d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32]
            .try_into()
            .ok()?,
        owner_tag: le(&d[VA::OWNER_TAG..VA::OWNER_TAG + 8]),
        stores,
        cap: le(&d[VA::CAP..VA::CAP + 8]) as i64,
        quota,
        lots: le(&d[VA::CUSTODY_LOTS..VA::CUSTODY_LOTS + 2]) as u16,
    })
}

/// A Citizen account's tag.
fn citizen_tag(d: &[u8]) -> Option<u64> {
    use frontier_abi::v2::layout::player::citizen as C;
    d.get(C::CITIZEN_TAG..C::CITIZEN_TAG + 8)
        .map(crate::world::le)
}

/// The kernel's actor for the player prologue `[actor, payer, season,
/// citizen]` (wallet prologue, `Auth::Wallet`): the Citizen, its tag, and
/// whether the signer is its unexpired Frontier session rather than its
/// wallet. `Err`: the prologue refuses the signer.
fn actor_of(
    signer: &[u8; 32],
    citizen_key: &[u8; 32],
    citizen: &[u8],
    time: i64,
) -> Result<permutation_rules::frontier::custody::Actor, String> {
    use crate::world::le;
    use frontier_abi::v2::layout::player::citizen as C;
    let short = || "the Citizen account is short".to_string();
    let wallet = citizen.get(C::WALLET..C::WALLET + 32).ok_or_else(short)?;
    let session = citizen.get(C::SESSION..C::SESSION + 32).ok_or_else(short)?;
    let expiry = le(citizen
        .get(C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8)
        .ok_or_else(short)?) as i64;
    let tag = citizen_tag(citizen).ok_or_else(short)?;
    let by_session = if signer[..] == *wallet {
        false
    } else if signer[..] == *session && session.iter().any(|b| *b != 0) && time < expiry {
        true
    } else {
        return Err("the signer is neither the Citizen's wallet nor its unexpired session".into());
    };
    Ok(permutation_rules::frontier::custody::Actor {
        citizen: *citizen_key,
        tag,
        by_session,
    })
}

fn lot_summary(l: &permutation_rules::frontier::custody::Lot) -> String {
    format!(
        "state {}, quota {}, held {}, in {}, out {}, consumed {}, nonce {}",
        l.state, l.quota, l.held, l.in_total, l.out_total, l.consumed, l.nonce
    )
}

/// The instructions [`replay_ix`] replays: those that touch one lot and at
/// most its vault. The ones that move a caravan (DepositLot, ShipLot,
/// SettleCustody, ReconcileLot, WithdrawLot) are not replayed yet.
pub const REPLAYED: [Ix; 6] = [
    Ix::OpenLot,
    Ix::SetLotQuota,
    Ix::SetLotOrder,
    Ix::RevokeLotOrder,
    Ix::ConsumeLot,
    Ix::CloseLot,
];

/// The lot's position in a custody instruction's accounts.
fn lot_index(kind: Ix) -> usize {
    match kind {
        Ix::OpenLot => 6,
        Ix::RevokeLotOrder => 4,
        _ => 5,
    }
}

/// Replays one landed custody instruction against the kernel
/// (`permutation_rules::frontier::custody`), in the account order and with
/// the argument reading of `permutation-frontier/src/proc/custody.rs`.
/// Not replayed here (other checks' or not modelled): the accounts'
/// addresses and owners (V9), the season and the action bucket (the
/// prologue's), the records the instruction writes.
pub fn replay_ix(c: &ReplayCase) -> Replayed {
    use frontier_abi::v2::ix as x;
    use permutation_rules::fixed::MILLI;
    use permutation_rules::frontier::custody as K;
    let un = |s: &str| Replayed::Unreplayed(s.to_string());
    let Some(kind) = c.data.first().copied().and_then(Ix::from_tag) else {
        return un("not a custody instruction");
    };
    if !REPLAYED.contains(&kind) {
        return Replayed::Unreplayed(format!("{kind:?} is not replayed yet (it moves a caravan)"));
    }
    let key = |i: usize| c.accounts.get(i).copied();
    let Some(bell) = c.bell else {
        return un("the transaction's bell is not known");
    };
    let (Some(signer), Some(citizen_key)) = (key(0), key(3)) else {
        return un("the instruction lacks its player accounts");
    };
    let Some(citizen) = (c.before)(&citizen_key) else {
        return un("the Citizen's state before the transaction is not in the input");
    };
    let bad = |what: String| Replayed::Mismatch(format!("{kind:?} landed, but {what}"));
    let actor = match actor_of(&signer, &citizen_key, &citizen, c.time) {
        Ok(a) => a,
        Err(e) => return bad(e),
    };
    let milli = |u: u32| u as i64 * MILLI;
    let Some(lot_key) = key(lot_index(kind)) else {
        return un("the instruction lacks its lot account");
    };
    let vault_key = if kind == Ix::RevokeLotOrder {
        None
    } else {
        match key(4) {
            Some(k) => Some(k),
            None => return un("the instruction lacks its vault account"),
        }
    };
    let mut v: Option<K::VaultView> = match vault_key.and_then(|k| (c.before)(&k)) {
        Some(d) => match vault_view_of(&d) {
            Some(v) => Some(v),
            None => return bad("its vault account is not a Vault".to_string()),
        },
        None => None,
    };
    let mut lot = if kind == Ix::OpenLot {
        None
    } else {
        match (c.before)(&lot_key) {
            Some(d) => match K::Lot::decode(&d) {
                Some(l) => Some(l),
                None => return bad("its lot account is not a Lot".to_string()),
            },
            None => return un("the lot's state before the transaction is not in the input"),
        }
    };
    // Every replayed step reads the vault but RevokeLotOrder and the close
    // of a forfeited lot.
    let needs_vault = match kind {
        Ix::RevokeLotOrder => false,
        Ix::CloseLot => lot.is_some_and(|l| l.state == K::LOT_OPEN),
        _ => true,
    };
    if needs_vault && v.is_none() {
        return un("the vault's state before the transaction is not in the input");
    }
    if !needs_vault {
        v = None; // the program does not write it then
    }
    let bad_data = || bad("its data does not decode".to_string());
    let result: Result<(), K::CustodyError> = match (kind, lot.as_mut(), v.as_mut()) {
        (Ix::OpenLot, None, Some(v)) => {
            let Ok(a) = x::OpenLot::decode(c.data) else {
                return bad_data();
            };
            let (Some(owner_key), Some(payer)) = (key(5), key(1)) else {
                return un("the instruction lacks its accounts");
            };
            let Some(owner) = (c.before)(&owner_key) else {
                return un("the owner Citizen's state before the transaction is not in the input");
            };
            let Some(owner_tag) = citizen_tag(&owner) else {
                return bad("the owner Citizen account is short".to_string());
            };
            K::open(
                v,
                &actor,
                (owner_key, owner_tag),
                a.resource,
                milli(a.quota),
                bell,
                payer,
            )
            .map(|l| lot = Some(l))
        }
        (Ix::SetLotQuota, Some(l), Some(v)) => {
            let Ok(a) = x::SetLotQuota::decode(c.data) else {
                return bad_data();
            };
            K::set_quota(v, l, &actor, milli(a.quota))
        }
        (Ix::SetLotOrder, Some(l), Some(v)) => {
            let Ok(a) = x::SetLotOrder::decode(c.data) else {
                return bad_data();
            };
            let Some(grantee) = key(6) else {
                return un("the instruction lacks its grantee account");
            };
            let dst = K::PlaceRef::vault(a.dst_p, a.dst_q, a.dst_tile, a.dst_gen);
            if a.kind == K::ORDER_SHIP {
                // The program: the destination vault stands now, of that
                // generation.
                let Some(dk) = key(7) else {
                    return un("the instruction lacks its destination vault");
                };
                match (c.before)(&dk).map(|d| vault_view_of(&d)) {
                    None => return un(
                        "the destination vault's state before the transaction is not in the input",
                    ),
                    Some(Some(dv)) if dv.live && dv.place() == dst => {}
                    Some(_) => {
                        return bad("its destination is not a standing vault of that generation"
                            .to_string())
                    }
                }
            }
            let spec = K::OrderSpec {
                kind: a.kind,
                grantee,
                qty: milli(a.qty),
                expires_bell: a.expires_bell,
                dst,
                purpose: a.purpose,
            };
            K::set_order(v, l, &actor, a.slot, a.nonce, &spec, bell).map(|_| ())
        }
        (Ix::RevokeLotOrder, Some(l), None) => {
            let Ok(a) = x::RevokeLotOrder::decode(c.data) else {
                return bad_data();
            };
            K::revoke_order(l, &actor, a.slot, a.id, bell).map(|_| ())
        }
        (Ix::ConsumeLot, Some(l), Some(v)) => {
            let Ok(a) = x::ConsumeLot::decode(c.data) else {
                return bad_data();
            };
            K::consume(v, l, &actor, a.slot, a.id, milli(a.qty), a.purpose, bell)
        }
        (Ix::CloseLot, Some(l), v) => {
            if x::CloseLot::decode(c.data).is_err() {
                return bad_data();
            }
            if key(6) != Some(l.rent_to) {
                return bad("its rent account is not the lot's".to_string());
            }
            K::close(v, l, Some(&actor), bell)
        }
        _ => unreachable!("the states above are set for each replayed kind"),
    };
    if let Err(e) = result {
        return bad(format!("the kernel refuses it on the state before ({e:?})"));
    }
    // The lot the transaction left.
    let gone = |d: &Option<Vec<u8>>| d.as_ref().is_none_or(|d| d.iter().all(|b| *b == 0));
    match (c.after)(&lot_key) {
        None => return un("the lot's state after the transaction is not in the input"),
        Some(d) if kind == Ix::CloseLot => {
            if !gone(&d) {
                return bad("the lot account is still there".to_string());
            }
        }
        Some(d) if gone(&d) => return bad("the lot account is gone".to_string()),
        Some(d) => {
            let want = lot.expect("kept");
            match K::Lot::decode(d.as_deref().unwrap_or_default()) {
                Some(got) if got == want => {}
                Some(got) => {
                    return bad(format!(
                        "it left the lot ({}) where the kernel writes ({})",
                        lot_summary(&got),
                        lot_summary(&want)
                    ))
                }
                None => return bad("it left a lot that does not decode".to_string()),
            }
        }
    }
    // The vault, where the program writes it (open, quota, the close of an
    // open lot): stores, quota and lot count as the kernel leaves them.
    let writes_vault = match kind {
        Ix::OpenLot | Ix::SetLotQuota => true,
        Ix::CloseLot => v.is_some(),
        _ => false,
    };
    if let (true, Some(want), Some(vk)) = (writes_vault, v, vault_key) {
        match (c.after)(&vk) {
            None => return un("the vault's state after the transaction is not in the input"),
            Some(d) => match d.as_deref().and_then(vault_view_of) {
                Some(got)
                    if (got.stores, got.quota, got.lots) == (want.stores, want.quota, want.lots) => {}
                Some(got) => {
                    return bad(format!(
                        "it left the vault's custody counts (quota {:?}, lots {}) where the kernel writes (quota {:?}, lots {})",
                        got.quota, got.lots, want.quota, want.lots
                    ))
                }
                None => return bad("it left no Vault at the vault account".to_string()),
            },
        }
    }
    Replayed::Matches
}

/// `V26:custody-replay` (custody seasons): each landed transaction with
/// one custody instruction is replayed by [`replay_ix`] on the states the
/// input recorded before it. A mismatch or a refusal is a FAIL
/// (`CustodyReplayMismatch`) at that transaction; an instruction that is
/// not replayed yet, several custody instructions in one transaction, or
/// missing evidence is UNVERIFIABLE (`CustodyReplayIncomplete`). A match
/// adds nothing; the guard's traces stay UNVERIFIABLE (caravans and the
/// records are not replayed), so a custody season is still never a PASS.
pub fn replay(cx: &mut Ctx) {
    let w = cx.w;
    let genesis = cx.f.genesis_ts;
    let mut found: Vec<(String, usize, bool, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        let custody: Vec<&crate::world::Ix> = tx
            .ixs
            .iter()
            .filter(|ix| {
                ix.tag()
                    .and_then(Ix::from_tag)
                    .is_some_and(|x| x.is_custody())
            })
            .collect();
        let [ix] = custody.as_slice() else {
            if custody.len() > 1 {
                found.push((
                    "transaction".into(),
                    t,
                    false,
                    format!(
                        "{} custody instructions in one transaction are not replayed yet",
                        custody.len()
                    ),
                ));
            }
            continue;
        };
        let accounts: Vec<[u8; 32]> = ix.accounts.iter().map(|a| a.0).collect();
        let before = |k: &[u8; 32]| w.state_before(k, t).map(|d| d.to_vec());
        let after = |k: &[u8; 32]| tx.post.get(k).map(|a| a.as_ref().map(|a| a.data.clone()));
        let case = ReplayCase {
            data: &ix.data,
            accounts: &accounts,
            time: tx.time,
            bell: frontier_abi::prologue::bell_at(genesis, tx.time),
            before: &before,
            after: &after,
        };
        let entity = ix
            .tag()
            .and_then(Ix::from_tag)
            .and_then(|k| accounts.get(lot_index(k)))
            .map(|k| ent("account", k))
            .unwrap_or_else(|| "transaction".into());
        match replay_ix(&case) {
            Replayed::Matches => {}
            Replayed::Mismatch(m) => found.push((entity, t, true, m)),
            Replayed::Unreplayed(m) => found.push((entity, t, false, m)),
        }
    }
    // FAILs first, so that the listing's cut never hides one.
    found.sort_by_key(|f| !f.2);
    let n = found.len();
    let more_fail = found.iter().skip(LISTED).any(|f| f.2);
    for (i, (entity, t, fail, what)) in found.into_iter().enumerate() {
        if i == LISTED {
            fail_or_unverifiable(
                cx,
                V,
                if more_fail {
                    CUSTODY_REPLAY_MISMATCH
                } else {
                    CUSTODY_REPLAY_INCOMPLETE
                },
                more_fail,
                "season",
                None,
                format!("{} more custody replay findings", n - LISTED),
            );
            break;
        }
        if fail {
            cx.fail(V, CUSTODY_REPLAY_MISMATCH, entity, u32::MAX, Some(t), what);
        } else {
            unverifiable(
                cx,
                V,
                CUSTODY_REPLAY_INCOMPLETE,
                entity,
                u32::MAX,
                Some(t),
                what,
            );
        }
    }
}
