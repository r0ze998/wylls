//! Nations (redesign stage 1e, decisions K1 and K2;
//! `docs/frontier/stage1e/S1-1E-CONTRACT.md` §3): each faction is a
//! nation whose villages vote on two things, its **stance** toward another
//! faction (`structure::STANCE_*`, read by the stop rule) and the
//! **expulsion** (or readmission) of one of its own villages.
//!
//! One village, one vote: a Citizen votes once on a proposal, however many
//! holdings it has. A Citizen may propose and vote once it is
//! [`eligible`]: a member (not expelled) that joined at least
//! [`ELIGIBLE_BELLS`] ago. A proposal is open for [`WINDOW_BELLS`] and
//! passes when [`passes`]. An expelled village may be readmitted once it
//! has been out for [`READMIT_BELLS`].
//!
//! The program, the verifier and the herald share this module; the
//! Nation account holds [`PROPOSALS`] proposals ([`Proposal`], 64 bytes
//! each).

use crate::frontier::structure::{NATIONS, STANCE_ALLY};

/// Version of this module's rules (bound into `RULESET_HASH_V3`).
pub const NATION_VERSION: u16 = 1;

/// Bells a Citizen must have been in the season before it may propose or
/// vote (2 days of 10-minute bells) [phase 6].
pub const ELIGIBLE_BELLS: u32 = 288;
/// Bells a proposal stays open (1 day) [phase 6].
pub const WINDOW_BELLS: u32 = 144;
/// Bells an expelled village waits before it may be readmitted (3 days)
/// [phase 6].
pub const READMIT_BELLS: u32 = 432;
/// Yes votes a proposal needs at least (and more yes than no) [phase 6].
pub const QUORUM: u16 = 3;
/// Proposal slots in a Nation account.
pub const PROPOSALS: usize = 4;

/// Proposal kinds.
pub const KIND_STANCE: u8 = 1;
pub const KIND_EXPEL: u8 = 2;
pub const KIND_READMIT: u8 = 3;
pub const KINDS: [u8; 3] = [KIND_STANCE, KIND_EXPEL, KIND_READMIT];

/// Proposal states.
pub const STATE_NONE: u8 = 0;
pub const STATE_OPEN: u8 = 1;
pub const STATE_PASSED: u8 = 2;
pub const STATE_FAILED: u8 = 3;

/// Bytes of one proposal in a Nation account.
pub const PROPOSAL_SIZE: usize = 64;

/// Whether a Citizen that joined at `join_bell`, expelled when
/// `expelled`, may propose and vote at `now_bell`.
pub const fn eligible(join_bell: u32, expelled: bool, now_bell: u32) -> bool {
    !expelled && join_bell.saturating_add(ELIGIBLE_BELLS) <= now_bell
}

/// Whether a closed proposal with `yes` and `no` votes passed.
pub const fn passes(yes: u16, no: u16) -> bool {
    yes > no && yes >= QUORUM
}

/// Whether a stance proposal's target and value are valid for `nation`.
pub const fn stance_ok(nation: u8, target_faction: u8, value: u8) -> bool {
    (nation as usize) < NATIONS
        && (target_faction as usize) < NATIONS
        && target_faction != nation
        && value <= STANCE_ALLY
}

/// Whether an expelled village (expelled at `since_bell`) may be readmitted
/// at `now_bell`.
pub const fn readmittable(since_bell: u32, now_bell: u32) -> bool {
    since_bell.saturating_add(READMIT_BELLS) <= now_bell
}

/// One proposal of a Nation account (64 bytes, little-endian):
/// `id u32 ‖ state u8 ‖ kind u8 ‖ target_faction u8 ‖ value u8 ‖
/// open_bell u32 ‖ close_bell u32 ‖ yes u16 ‖ no u16 ‖ proposer_tag u64 ‖
/// target [u8; 32] ‖ reserve [u8; 4]` (`target` is the target Citizen of
/// an expulsion or readmission; zero for a stance).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Proposal {
    pub id: u32,
    pub state: u8,
    pub kind: u8,
    pub target_faction: u8,
    pub value: u8,
    pub open_bell: u32,
    pub close_bell: u32,
    pub yes: u16,
    pub no: u16,
    pub proposer_tag: u64,
    pub target: [u8; 32],
}

impl Proposal {
    /// Whether a slot holding this proposal may take a new one (empty or
    /// decided).
    pub const fn free(&self) -> bool {
        self.state != STATE_OPEN
    }

    /// Whether votes are taken at `now_bell`.
    pub const fn open_at(&self, now_bell: u32) -> bool {
        self.state == STATE_OPEN && now_bell < self.close_bell
    }

    /// Whether it may be settled at `now_bell`.
    pub const fn settles_at(&self, now_bell: u32) -> bool {
        self.state == STATE_OPEN && now_bell >= self.close_bell
    }

    pub fn decode(b: &[u8]) -> Option<Proposal> {
        let b = b.get(..PROPOSAL_SIZE)?;
        let u16_at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
        let u32_at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        let mut tag = [0u8; 8];
        tag.copy_from_slice(&b[20..28]);
        let mut target = [0u8; 32];
        target.copy_from_slice(&b[28..60]);
        Some(Proposal {
            id: u32_at(0),
            state: b[4],
            kind: b[5],
            target_faction: b[6],
            value: b[7],
            open_bell: u32_at(8),
            close_bell: u32_at(12),
            yes: u16_at(16),
            no: u16_at(18),
            proposer_tag: u64::from_le_bytes(tag),
            target,
        })
    }

    /// Writes the proposal (its reserve zeroed).
    pub fn encode(&self, b: &mut [u8]) -> Option<()> {
        let b = b.get_mut(..PROPOSAL_SIZE)?;
        b[0..4].copy_from_slice(&self.id.to_le_bytes());
        b[4] = self.state;
        b[5] = self.kind;
        b[6] = self.target_faction;
        b[7] = self.value;
        b[8..12].copy_from_slice(&self.open_bell.to_le_bytes());
        b[12..16].copy_from_slice(&self.close_bell.to_le_bytes());
        b[16..18].copy_from_slice(&self.yes.to_le_bytes());
        b[18..20].copy_from_slice(&self.no.to_le_bytes());
        b[20..28].copy_from_slice(&self.proposer_tag.to_le_bytes());
        b[28..60].copy_from_slice(&self.target);
        b[60..64].fill(0);
        Some(())
    }
}

/// Appends this module's tables to the S1 ruleset hash input.
pub fn write_tables(out: &mut alloc::vec::Vec<u8>) {
    out.extend_from_slice(&NATION_VERSION.to_le_bytes());
    out.extend_from_slice(&ELIGIBLE_BELLS.to_le_bytes());
    out.extend_from_slice(&WINDOW_BELLS.to_le_bytes());
    out.extend_from_slice(&READMIT_BELLS.to_le_bytes());
    out.extend_from_slice(&QUORUM.to_le_bytes());
    out.push(PROPOSALS as u8);
    out.extend_from_slice(&KINDS);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proposal_round_trips_in_64_bytes() {
        let p = Proposal {
            id: 7,
            state: STATE_OPEN,
            kind: KIND_EXPEL,
            target_faction: 2,
            value: 0,
            open_bell: 300,
            close_bell: 444,
            yes: 3,
            no: 1,
            proposer_tag: 0xDEAD_BEEF,
            target: [9; 32],
        };
        let mut b = [0xFFu8; PROPOSAL_SIZE];
        p.encode(&mut b).unwrap();
        assert_eq!(&b[60..], &[0; 4]);
        assert_eq!(Proposal::decode(&b), Some(p));
        assert!(Proposal::decode(&b[..63]).is_none());
    }

    #[test]
    fn the_rules() {
        assert!(!eligible(10, false, 10 + ELIGIBLE_BELLS - 1));
        assert!(eligible(10, false, 10 + ELIGIBLE_BELLS));
        assert!(!eligible(10, true, 10_000));
        assert!(!passes(2, 0), "short of the quorum");
        assert!(passes(3, 2));
        assert!(!passes(3, 3), "a tie fails");
        assert!(stance_ok(0, 1, STANCE_ALLY));
        assert!(!stance_ok(0, 0, 1), "not toward itself");
        assert!(!stance_ok(0, 6, 1), "not toward the neutrals");
        assert!(!stance_ok(0, 1, 3), "no such stance");
        assert!(!readmittable(100, 100 + READMIT_BELLS - 1));
        assert!(readmittable(100, 100 + READMIT_BELLS));
        let mut p = Proposal {
            state: STATE_OPEN,
            close_bell: 50,
            ..Default::default()
        };
        assert!(p.open_at(49) && !p.settles_at(49));
        assert!(!p.open_at(50) && p.settles_at(50));
        assert!(!p.free());
        p.state = STATE_PASSED;
        assert!(p.free() && !p.settles_at(60));
    }
}
