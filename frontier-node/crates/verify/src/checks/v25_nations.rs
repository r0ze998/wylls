//! V25 (S1 stage 1e, `docs/frontier/stage1e/S1-1E-CONTRACT.md` §3 and §7),
//! listed as `V25:nations`: every landed nation instruction re-judged from
//! the states before its transaction and the states it left, through the
//! nation kernel (`permutation_rules::frontier::nation`):
//!
//! - **Propose:** the proposer eligible (`nation::eligible`), no open
//!   proposal of its own, the kind's target (a stance `stance_ok` toward
//!   another faction; an expulsion of a member; a readmission of a village
//!   expelled `READMIT_BELLS` ago), the first free slot written with the
//!   Nation's next id, open for `WINDOW_BELLS`, the id moved on, the
//!   proposer's `PROPOSED`.
//! - **Vote:** the voter eligible, the proposal open, not voted on before
//!   (`VOTED[slot]`), one tally moved by one, `VOTED[slot]` written.
//! - **SettleProposal:** the proposal closed and settled once, passed
//!   exactly when `nation::passes` and the target still qualifies; a passed
//!   stance is the only Season stance that changed; a passed expulsion
//!   stamps `EXPELLED_SINCE` at the settlement and flags every listed
//!   holding, a readmission clears both; nothing else changes the Season's
//!   stances or a target.
//!
//! The Nation's other slots never change. Code: `NationMismatch`. Tamper
//! classes T55–T56 (`crate::tamper`).

use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::s1::nation as NA;
use frontier_abi::v2::layout::world::season as S2;
use frontier_abi::v2::tags::Ix as V2Ix;
use permutation_rules::frontier::nation::{
    self as kn, Proposal, KIND_EXPEL, KIND_READMIT, KIND_STANCE, STATE_FAILED, STATE_OPEN,
    STATE_PASSED,
};
use permutation_rules::frontier::structure::NATIONS;

use super::v23_caravans::{States, TxStates, Wrong};
use super::Ctx;
use crate::codes::NATION_MISMATCH;
use crate::world::Key;

const V: &str = "V25";

fn wrong(s: impl Into<String>) -> Wrong {
    (NATION_MISMATCH, s.into())
}

fn u32_of(d: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(d.get(o..o + 4)?.try_into().ok()?))
}
fn i64_of(d: &[u8], o: usize) -> Option<i64> {
    Some(i64::from_le_bytes(d.get(o..o + 8)?.try_into().ok()?))
}

/// The proposals of a Nation's bytes (all empty for an absent Nation).
fn slots(nd: Option<&[u8]>) -> Result<[Proposal; NA::N], Wrong> {
    let mut out = [Proposal::default(); NA::N];
    if let Some(d) = nd {
        for (i, q) in out.iter_mut().enumerate() {
            *q = Proposal::decode(d.get(NA::at(i)..).unwrap_or(&[]))
                .ok_or_else(|| wrong("a short Nation"))?;
        }
    }
    Ok(out)
}

/// The bell of a timestamp (0 before genesis).
fn bell_of(genesis_ts: i64, ts: i64) -> u32 {
    frontier_abi::prologue::bell_at(genesis_ts, ts).unwrap_or(0)
}

/// Whether the Citizen's bytes are eligible at `bell` (its faction).
fn eligible(cd: &[u8], bell: u32) -> Result<u8, Wrong> {
    let join = u32_of(cd, C2::JOIN_BELL).ok_or_else(|| wrong("a short Citizen"))?;
    let since = i64_of(cd, C2::EXPELLED_SINCE).ok_or_else(|| wrong("a short Citizen"))?;
    let f = cd[C2::FACTION];
    if !kn::eligible(join, since != 0, bell) || f as usize >= NATIONS {
        return Err(wrong("a Citizen the rules do not let propose or vote"));
    }
    Ok(f)
}

struct Seen<'a> {
    s: &'a dyn States,
}

impl Seen<'_> {
    fn before(&self, k: &Key, what: &str) -> Result<Vec<u8>, Wrong> {
        self.s
            .before(k)
            .ok_or_else(|| wrong(format!("no {what} before")))
    }
    fn after(&self, k: &Key, what: &str) -> Result<Vec<u8>, Wrong> {
        self.s
            .after(k)
            .ok_or_else(|| wrong(format!("no {what} after")))
    }
}

/// Only slot `slot` may differ between the two Nations.
fn others_unchanged(b: &[Proposal], a: &[Proposal], slot: usize) -> Result<(), Wrong> {
    for i in 0..NA::N {
        if i != slot && b[i] != a[i] {
            return Err(wrong(format!("the Nation's slot {i} changed")));
        }
    }
    Ok(())
}

// ------------------------------------------------------------ Propose

/// Propose (accounts: 3 citizen, 4 nation, 5 target).
pub fn judge_propose(
    ix: &crate::world::Ix,
    s: &dyn States,
    bell: u32,
    genesis_ts: i64,
) -> Result<(), Wrong> {
    let x = ix2::Propose::decode(&ix.data).map_err(|_| wrong("does not decode"))?;
    let (Some(citizen), Some(nation), Some(target)) = (ix.key(3), ix.key(4), ix.key(5)) else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let cb = v.before(&citizen, "Citizen")?;
    let ca = v.after(&citizen, "Citizen")?;
    let faction = eligible(&cb, bell)?;
    let nb = s.before(&nation).filter(|d| d.len() == NA::SIZE);
    let na = v.after(&nation, "Nation")?;
    if na.len() != NA::SIZE || na[..8] != NA::MAGIC || na[NA::FACTION] != faction {
        return Err(wrong("the Nation is not the proposer's faction's"));
    }
    let (b, a) = (slots(nb.as_deref())?, slots(Some(&na))?);
    let next = match &nb {
        Some(d) => u32_of(d, NA::NEXT_ID).ok_or_else(|| wrong("a short Nation"))?,
        None => 1,
    };
    let proposed = u32_of(&cb, C2::PROPOSED).ok_or_else(|| wrong("a short Citizen"))?;
    if proposed != 0 && b.iter().any(|q| q.state == STATE_OPEN && q.id == proposed) {
        return Err(wrong("a second open proposal of the proposer"));
    }
    let (tf, value, tkey) = match x.kind {
        KIND_STANCE => {
            if !kn::stance_ok(faction, x.target_faction, x.value) || target != nation {
                return Err(wrong("a stance proposal the rules refuse"));
            }
            (x.target_faction, x.value, [0u8; 32])
        }
        KIND_EXPEL | KIND_READMIT => {
            let td = v.before(&target, "target Citizen")?;
            let since = i64_of(&td, C2::EXPELLED_SINCE).ok_or_else(|| wrong("short target"))?;
            let ok = target != citizen
                && x.target_faction == faction
                && x.value == 0
                && td[C2::FACTION] == faction
                && if x.kind == KIND_EXPEL {
                    since == 0
                } else {
                    since != 0 && kn::readmittable(bell_of(genesis_ts, since), bell)
                };
            if !ok {
                return Err(wrong("a membership proposal the rules refuse"));
            }
            (faction, 0, target)
        }
        _ => return Err(wrong("a kind the rules refuse")),
    };
    let slot = b
        .iter()
        .position(|q| q.free())
        .ok_or_else(|| wrong("a proposal into a full Nation"))?;
    let want = Proposal {
        id: next,
        state: STATE_OPEN,
        kind: x.kind,
        target_faction: tf,
        value,
        open_bell: bell,
        close_bell: bell + kn::WINDOW_BELLS,
        yes: 0,
        no: 0,
        proposer_tag: u64::from_le_bytes(
            cb[C2::CITIZEN_TAG..C2::CITIZEN_TAG + 8].try_into().unwrap(),
        ),
        target: tkey,
    };
    if a[slot] != want {
        return Err(wrong(format!("slot {slot} is not the rules' proposal")));
    }
    others_unchanged(&b, &a, slot)?;
    if u32_of(&na, NA::NEXT_ID) != Some(next + 1) {
        return Err(wrong("the Nation's next id did not move by one"));
    }
    if u32_of(&ca, C2::PROPOSED) != Some(next) {
        return Err(wrong("the proposer's PROPOSED is not the new id"));
    }
    Ok(())
}

// ------------------------------------------------------------ Vote

/// Vote (accounts: 3 citizen, 4 nation).
pub fn judge_vote(ix: &crate::world::Ix, s: &dyn States, bell: u32) -> Result<(), Wrong> {
    let x = ix2::Vote::decode(&ix.data).map_err(|_| wrong("does not decode"))?;
    let (Some(citizen), Some(nation)) = (ix.key(3), ix.key(4)) else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let cb = v.before(&citizen, "Citizen")?;
    let ca = v.after(&citizen, "Citizen")?;
    let faction = eligible(&cb, bell)?;
    let nb = v.before(&nation, "Nation")?;
    let na = v.after(&nation, "Nation")?;
    if nb.get(NA::FACTION) != Some(&faction) {
        return Err(wrong("a vote in another faction's Nation"));
    }
    let slot = x.slot as usize;
    if slot >= NA::N || x.yes > 1 {
        return Err(wrong("a vote the rules refuse"));
    }
    let (b, a) = (slots(Some(&nb))?, slots(Some(&na))?);
    if b[slot].id != x.id || !b[slot].open_at(bell) {
        return Err(wrong("a vote on a proposal that is not open"));
    }
    let voted = C2::VOTED + 4 * slot;
    if u32_of(&cb, voted) == Some(x.id) {
        return Err(wrong("a second vote of the Citizen"));
    }
    let mut want = b[slot];
    if x.yes == 1 {
        want.yes += 1;
    } else {
        want.no += 1;
    }
    if a[slot] != want {
        return Err(wrong("the tallies are not the vote's"));
    }
    others_unchanged(&b, &a, slot)?;
    if u32_of(&ca, voted) != Some(x.id) {
        return Err(wrong("the Citizen's VOTED is not the id"));
    }
    Ok(())
}

// ------------------------------------------------------------ SettleProposal

/// SettleProposal (accounts: 1 season, 2 nation, 3 target, 4.. holdings).
pub fn judge_settle_proposal(
    ix: &crate::world::Ix,
    s: &dyn States,
    bell: u32,
    now: i64,
) -> Result<(), Wrong> {
    let x = ix2::SettleProposal::decode(&ix.data).map_err(|_| wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 4 {
        return Err(wrong("the accounts are missing"));
    }
    let (season, nation, target, holdings) = (keys[1], keys[2], keys[3], &keys[4..]);
    let v = Seen { s };
    let nb = v.before(&nation, "Nation")?;
    let na = v.after(&nation, "Nation")?;
    let sb = v.before(&season, "Season")?;
    let sa = v.after(&season, "Season")?;
    let faction = nb[NA::FACTION];
    let slot = x.slot as usize;
    if slot >= NA::N {
        return Err(wrong("a slot outside the Nation"));
    }
    let (b, a) = (slots(Some(&nb))?, slots(Some(&na))?);
    let q = b[slot];
    if q.id != x.id || !q.settles_at(bell) {
        return Err(wrong(
            "a settlement of a proposal that is not closed and open",
        ));
    }
    let mut passed = kn::passes(q.yes, q.no);
    let membership = q.kind == KIND_EXPEL || q.kind == KIND_READMIT;
    let (tb, ta) = if membership {
        let tb = v.before(&target, "target")?;
        let ta = v.after(&target, "target")?;
        if target != q.target {
            return Err(wrong("the settlement's target is not the proposal's"));
        }
        let since = i64_of(&tb, C2::EXPELLED_SINCE).ok_or_else(|| wrong("short target"))?;
        passed &= tb[C2::FACTION] == faction && (since == 0) == (q.kind == KIND_EXPEL);
        (Some(tb), Some(ta))
    } else {
        (None, None)
    };
    let mut want = q;
    want.state = if passed { STATE_PASSED } else { STATE_FAILED };
    if a[slot] != want {
        return Err(wrong(format!(
            "the proposal settled as {} where the rules say {}",
            a[slot].state, want.state
        )));
    }
    others_unchanged(&b, &a, slot)?;
    // The Season's stances: only a passed stance's cell changes.
    let cell = (q.kind == KIND_STANCE && passed)
        .then(|| S2::STANCES + faction as usize * NATIONS + q.target_faction as usize);
    for o in S2::STANCES..S2::STANCES + NATIONS * NATIONS {
        let want = if Some(o) == cell { q.value } else { sb[o] };
        if sa[o] != want {
            return Err(wrong(format!(
                "the Season's stance {} → {} is not the settlement's",
                (o - S2::STANCES) / NATIONS,
                (o - S2::STANCES) % NATIONS
            )));
        }
    }
    // The target and its holdings.
    if let (Some(tb), Some(ta)) = (tb, ta) {
        let want_since = match (passed, q.kind) {
            (true, KIND_EXPEL) => now,
            (true, _) => 0,
            (false, _) => i64_of(&tb, C2::EXPELLED_SINCE).unwrap_or(-1),
        };
        if i64_of(&ta, C2::EXPELLED_SINCE) != Some(want_since) {
            return Err(wrong("the target's EXPELLED_SINCE is not the settlement's"));
        }
        if !passed && !holdings.is_empty() {
            return Err(wrong("holdings listed for a settlement that changes none"));
        }
        for h in holdings {
            let hb = v.before(h, "holding")?;
            let ha = v.after(h, "holding")?;
            if hb.get(H2::OWNER_CITIZEN..H2::OWNER_CITIZEN + 32) != Some(&target[..]) {
                return Err(wrong("a listed holding the target does not own"));
            }
            let flag = ha[H2::FLAGS] & H2::FLAG_EXPELLED != 0;
            if flag != (q.kind == KIND_EXPEL)
                || ha[H2::FLAGS] & !H2::FLAG_EXPELLED != hb[H2::FLAGS] & !H2::FLAG_EXPELLED
            {
                return Err(wrong("a holding's expelled flag is not the settlement's"));
            }
        }
    } else if !holdings.is_empty() {
        return Err(wrong("holdings listed for a stance"));
    }
    Ok(())
}

// ------------------------------------------------------------ the check

pub fn run(cx: &mut Ctx) {
    if !cx.s1 {
        return;
    }
    let w = cx.w;
    let tags = [V2Ix::Propose, V2Ix::Vote, V2Ix::SettleProposal];
    if !w.has_post {
        let any = w.txs.iter().any(|tx| {
            tx.ok
                && tx
                    .ixs
                    .iter()
                    .any(|i| i.tag().is_some_and(|x| tags.iter().any(|t| t.tag() == x)))
        });
        if any {
            cx.missing(
                V,
                "nations",
                0,
                None,
                "no post-states: the nation instructions cannot be re-judged",
            );
        }
        return;
    }
    let genesis_ts = cx.f.genesis_ts;
    let mut found: Vec<(usize, u32, &'static str, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate().filter(|(_, tx)| tx.ok) {
        let bell = bell_of(genesis_ts, tx.time);
        let st = TxStates { w, tx, t };
        for ix in &tx.ixs {
            let Some(tag) = ix.tag() else { continue };
            let r = match V2Ix::from_tag(tag) {
                Some(V2Ix::Propose) => judge_propose(ix, &st, bell, genesis_ts),
                Some(V2Ix::Vote) => judge_vote(ix, &st, bell),
                Some(V2Ix::SettleProposal) => judge_settle_proposal(ix, &st, bell, tx.time),
                _ => continue,
            };
            if let Err((code, detail)) = r {
                found.push((t, bell, code, detail));
            }
        }
    }
    for (t, bell, code, detail) in found {
        cx.fail(V, code, "nations", bell, Some(t), detail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Mock {
        before: HashMap<Key, Vec<u8>>,
        after: HashMap<Key, Vec<u8>>,
    }

    impl States for Mock {
        fn before(&self, k: &Key) -> Option<Vec<u8>> {
            self.before.get(k).cloned()
        }
        fn after(&self, k: &Key) -> Option<Vec<u8>> {
            self.after.get(k).or_else(|| self.before.get(k)).cloned()
        }
    }

    fn ix(data: Vec<u8>, keys: &[Key]) -> crate::world::Ix {
        crate::world::Ix {
            index: 0,
            data,
            accounts: keys.iter().map(|k| (*k, true)).collect(),
        }
    }

    fn nation_with(q: Proposal) -> Vec<u8> {
        let mut d = vec![0u8; NA::SIZE];
        d[..8].copy_from_slice(&NA::MAGIC);
        d[NA::NEXT_ID..NA::NEXT_ID + 4].copy_from_slice(&(q.id + 1).to_le_bytes());
        q.encode(&mut d[NA::at(0)..]).unwrap();
        d
    }

    /// A settlement that writes a stance its proposal did not pass (T56's
    /// shape) fails; the rules' settlement passes.
    #[test]
    fn a_stance_is_written_only_when_passed() {
        let (season, nation) = ([1u8; 32], [2u8; 32]);
        let q = Proposal {
            id: 4,
            state: STATE_OPEN,
            kind: KIND_STANCE,
            target_faction: 2,
            value: 1,
            open_bell: 10,
            close_bell: 20,
            yes: 2,
            no: 0,
            ..Default::default()
        };
        let sb = vec![0u8; S2::SIZE];
        let nb = nation_with(q);
        let mut na = nb.clone();
        let mut failed = q;
        failed.state = STATE_FAILED;
        failed.encode(&mut na[NA::at(0)..]).unwrap();
        let data = ix2::SettleProposal { slot: 0, id: 4 }.to_bytes().to_vec();
        let i = ix(data, &[[9; 32], season, nation, nation]);
        let mut m = Mock {
            before: HashMap::from([(season, sb.clone()), (nation, nb)]),
            after: HashMap::from([(nation, na)]),
        };
        assert_eq!(judge_settle_proposal(&i, &m, 25, 0), Ok(()));
        let mut sa = sb;
        sa[S2::STANCES + 2] = 1;
        m.after.insert(season, sa);
        assert!(judge_settle_proposal(&i, &m, 25, 0).is_err());
        // Not before it closes.
        m.after.remove(&season);
        assert!(judge_settle_proposal(&i, &m, 19, 0).is_err());
    }

    fn citizen(faction: u8, join: u32, since: i64) -> Vec<u8> {
        let mut d = vec![0u8; C2::SIZE];
        d[C2::FACTION] = faction;
        d[C2::JOIN_BELL..C2::JOIN_BELL + 4].copy_from_slice(&join.to_le_bytes());
        d[C2::EXPELLED_SINCE..C2::EXPELLED_SINCE + 8].copy_from_slice(&since.to_le_bytes());
        d
    }

    /// One vote moves one tally and writes `VOTED`; counting it twice (T55's
    /// shape), voting twice or voting expelled fails.
    #[test]
    fn a_vote_counts_once() {
        let (cit, nation) = ([3u8; 32], [4u8; 32]);
        let q = Proposal {
            id: 2,
            state: STATE_OPEN,
            kind: KIND_STANCE,
            target_faction: 1,
            value: 1,
            open_bell: 300,
            close_bell: 444,
            ..Default::default()
        };
        let nb = nation_with(q);
        let mut na = nb.clone();
        let mut voted = q;
        voted.yes = 1;
        voted.encode(&mut na[NA::at(0)..]).unwrap();
        let cb = citizen(0, 0, 0);
        let mut ca = cb.clone();
        ca[C2::VOTED..C2::VOTED + 4].copy_from_slice(&2u32.to_le_bytes());
        let data = ix2::Vote {
            slot: 0,
            id: 2,
            yes: 1,
        }
        .to_bytes()
        .to_vec();
        let i = ix(data, &[[0; 32], [1; 32], [2; 32], cit, nation]);
        let mut m = Mock {
            before: HashMap::from([(cit, cb.clone()), (nation, nb.clone())]),
            after: HashMap::from([(cit, ca.clone()), (nation, na.clone())]),
        };
        assert_eq!(judge_vote(&i, &m, 310), Ok(()));
        // Counted twice.
        let mut twice = q;
        twice.yes = 2;
        let mut na2 = nb.clone();
        twice.encode(&mut na2[NA::at(0)..]).unwrap();
        m.after.insert(nation, na2);
        assert!(judge_vote(&i, &m, 310).is_err());
        m.after.insert(nation, na);
        // Already voted, or expelled, or after the close, or not yet eligible.
        m.before.insert(cit, ca.clone());
        assert!(judge_vote(&i, &m, 310).is_err());
        m.before.insert(cit, citizen(0, 0, 77));
        assert!(judge_vote(&i, &m, 310).is_err());
        m.before.insert(cit, cb);
        assert!(judge_vote(&i, &m, 444).is_err());
        m.before.insert(cit, citizen(0, 100, 0));
        assert!(judge_vote(&i, &m, 310).is_err());
    }

    /// A passed expulsion stamps the target and flags its listed holdings;
    /// a missing flag fails.
    #[test]
    fn an_expulsion_flags_the_target() {
        let (season, nation, target, holding) = ([1u8; 32], [2u8; 32], [5u8; 32], [6u8; 32]);
        let q = Proposal {
            id: 1,
            state: STATE_OPEN,
            kind: KIND_EXPEL,
            target_faction: 0,
            open_bell: 300,
            close_bell: 444,
            yes: 3,
            no: 1,
            target,
            ..Default::default()
        };
        let sb = vec![0u8; S2::SIZE];
        let nb = nation_with(q);
        let mut na = nb.clone();
        let mut passed = q;
        passed.state = STATE_PASSED;
        passed.encode(&mut na[NA::at(0)..]).unwrap();
        let tb = citizen(0, 0, 0);
        let mut ta = tb.clone();
        ta[C2::EXPELLED_SINCE..C2::EXPELLED_SINCE + 8].copy_from_slice(&9_999i64.to_le_bytes());
        let mut hb = vec![0u8; H2::SIZE];
        hb[H2::OWNER_CITIZEN..H2::OWNER_CITIZEN + 32].copy_from_slice(&target);
        let mut ha = hb.clone();
        ha[H2::FLAGS] |= H2::FLAG_EXPELLED;
        let data = ix2::SettleProposal { slot: 0, id: 1 }.to_bytes().to_vec();
        let i = ix(data, &[[9; 32], season, nation, target, holding]);
        let mut m = Mock {
            before: HashMap::from([
                (season, sb),
                (nation, nb),
                (target, tb),
                (holding, hb.clone()),
            ]),
            after: HashMap::from([(nation, na), (target, ta), (holding, ha)]),
        };
        assert_eq!(judge_settle_proposal(&i, &m, 450, 9_999), Ok(()));
        m.after.insert(holding, hb);
        assert!(judge_settle_proposal(&i, &m, 450, 9_999).is_err());
    }
}
