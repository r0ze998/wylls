//! V26 guard (workstream 10, custody), listed as `V26:custody-guard`. The
//! custody check proper (the kernel's replay of every lot, order and
//! custody caravan) does not exist yet, so a history that carries any
//! custody trace is never a PASS:
//!
//! - in a season whose program has no custody (every ruleset up to
//!   `RULESET_HASH_V3`; the S1 program refuses the tags) a trace is a FAIL,
//!   `CustodyInProgramWithoutIt`;
//! - in a custody season (`RULESET_HASH_V4`, or a Season of
//!   `program_version >= PROGRAM_VERSION_CUSTODY`) it is UNVERIFIABLE,
//!   `CustodyUnverified`, until V26 replays it.
//!
//! In a custody season, `V26:custody-state` also re-judges what the
//! accounts alone settle (see [`audit`]): a state the kernel cannot produce
//! is a FAIL whatever the history. That never upgrades the season: with the
//! history not replayed, the best a custody season gets is UNVERIFIABLE.
//!
//! A trace is: a custody instruction (0xC1–0xCB) of a landed transaction
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
    CUSTODY_IN_PROGRAM_WITHOUT_IT, CUSTODY_LOT_BROKEN, CUSTODY_OVER_CAPACITY,
    CUSTODY_RULE_UNDECIDED, CUSTODY_UNVERIFIED, CUSTODY_VAULT_COUNTS,
};

const V: &str = "V26";
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
    }
    let n = traces.len();
    for (i, (entity, bell, tx, what)) in traces.into_iter().enumerate() {
        if i == LISTED {
            let rest = format!("{} more custody traces", n - LISTED);
            if custody {
                cx.unverifiable(V, CUSTODY_UNVERIFIED, "season", u32::MAX, None, rest);
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
            cx.unverifiable(
                V,
                CUSTODY_UNVERIFIED,
                entity,
                bell,
                tx,
                format!("{what}: custody is not verified (no V26 replay yet)"),
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
            cx.fail_or_unverifiable(
                V,
                code,
                fail,
                "season",
                None,
                format!("{} more custody state findings", n - LISTED),
            );
            break;
        }
        cx.fail_or_unverifiable(V, code, fail, entity, tx, what);
    }
}
