//! ABI v2 addresses (MC contract §5.1, §5.2.6): one new seed tag, `mc`
//! (MarchState, raw key `m i32 ‖ n i32`, an 18-byte seed). Every M1 seed
//! is unchanged ([`crate::addr`]).

use crate::addr::{AddrCtx, Seed};
use crate::v2::layout::AccountKind;

/// The MarchState seed tag.
pub const MARCH: [u8; 2] = *b"mc";
/// Raw key length of a MarchState (`m i32, n i32`).
pub const MARCH_RAW_LEN: usize = 8;

/// `mc‖hex(le32 m ‖ le32 n)`.
pub fn march_seed(m: i32, n: i32) -> Seed {
    let mut raw = [0u8; MARCH_RAW_LEN];
    raw[..4].copy_from_slice(&m.to_le_bytes());
    raw[4..].copy_from_slice(&n.to_le_bytes());
    Seed::new(MARCH, &raw)
}

/// The MarchState address of March `(m, n)`.
pub fn march_state(ctx: &AddrCtx, m: i32, n: i32) -> [u8; 32] {
    ctx.of(&march_seed(m, n))
}

/// The March a province belongs to and its canonical member order
/// (`geometry::march_members`): FoldMarch's account order.
pub fn march_of(p: i32, q: i32) -> (i32, i32) {
    use permutation_rules::frontier::geometry::{march_of, ProvinceCoord};
    let m = march_of(ProvinceCoord::new(p, q));
    (m.m, m.n)
}

/// The seven member Provinces of March `(m, n)` in FoldMarch's order.
pub fn march_members(m: i32, n: i32) -> [(i32, i32); 7] {
    use permutation_rules::frontier::geometry::{march_members, MarchCoord};
    march_members(MarchCoord { m, n }).map(|p| (p.p, p.q))
}

/// The Vault seed tag (S1, 1b).
pub const VAULT: [u8; 2] = *b"va";
/// Raw key length of a Vault (`p i32, q i32, tile u8`).
pub const VAULT_RAW_LEN: usize = 9;
/// The Caravan seed tag (S1, 1b).
pub const CARAVAN: [u8; 2] = *b"cv";
/// Raw key length of a Caravan (`owner_tag u64, seq u32`).
pub const CARAVAN_RAW_LEN: usize = 12;

/// The Tower seed tag (S1, 1d).
pub const TOWER: [u8; 2] = *b"tw";
/// Raw key length of a Tower (`p i32, q i32, tile u8`).
pub const TOWER_RAW_LEN: usize = 9;

/// `va‖hex(le32 p ‖ le32 q ‖ tile)`.
pub fn vault_seed(p: i32, q: i32, tile: u8) -> Seed {
    let mut raw = [0u8; VAULT_RAW_LEN];
    raw[..4].copy_from_slice(&p.to_le_bytes());
    raw[4..8].copy_from_slice(&q.to_le_bytes());
    raw[8] = tile;
    Seed::new(VAULT, &raw)
}

/// The Vault address on tile `tile` of Province `(p, q)`.
pub fn vault(ctx: &AddrCtx, p: i32, q: i32, tile: u8) -> [u8; 32] {
    ctx.of(&vault_seed(p, q, tile))
}

/// `tw‖hex(le32 p ‖ le32 q ‖ tile)`.
pub fn tower_seed(p: i32, q: i32, tile: u8) -> Seed {
    let mut raw = [0u8; TOWER_RAW_LEN];
    raw[..4].copy_from_slice(&p.to_le_bytes());
    raw[4..8].copy_from_slice(&q.to_le_bytes());
    raw[8] = tile;
    Seed::new(TOWER, &raw)
}

/// The Tower address on tile `tile` of Province `(p, q)`.
pub fn tower(ctx: &AddrCtx, p: i32, q: i32, tile: u8) -> [u8; 32] {
    ctx.of(&tower_seed(p, q, tile))
}

/// `cv‖hex(le64 owner_tag ‖ le32 seq)`.
pub fn caravan_seed(owner_tag: u64, seq: u32) -> Seed {
    let mut raw = [0u8; CARAVAN_RAW_LEN];
    raw[..8].copy_from_slice(&owner_tag.to_le_bytes());
    raw[8..].copy_from_slice(&seq.to_le_bytes());
    Seed::new(CARAVAN, &raw)
}

/// The Caravan address of the owner's `seq`-th send.
pub fn caravan(ctx: &AddrCtx, owner_tag: u64, seq: u32) -> [u8; 32] {
    ctx.of(&caravan_seed(owner_tag, seq))
}

/// The seed tag of each v2 kind (`None` for the Season PDA).
pub fn tag_of(kind: AccountKind) -> Option<[u8; 2]> {
    match kind {
        AccountKind::MarchState => Some(MARCH),
        AccountKind::Vault => Some(VAULT),
        AccountKind::Caravan => Some(CARAVAN),
        AccountKind::Tower => Some(TOWER),
        k => crate::addr::tag_of(k.to_v1()?),
    }
}

/// Raw key length of each v2 kind.
pub fn raw_len(kind: AccountKind) -> usize {
    match kind {
        AccountKind::MarchState => MARCH_RAW_LEN,
        AccountKind::Vault => VAULT_RAW_LEN,
        AccountKind::Caravan => CARAVAN_RAW_LEN,
        AccountKind::Tower => TOWER_RAW_LEN,
        k => k.to_v1().map(crate::addr::raw_len).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn march_seed_is_new_and_fits() {
        let s = march_seed(-3, 7);
        assert_eq!(s.len(), 18);
        assert_eq!(&s.as_bytes()[..2], b"mc");
        assert_eq!(s.as_bytes(), b"mcfdffffff07000000");
        for k in crate::layout::AccountKind::ALL {
            assert_ne!(crate::addr::tag_of(k), Some(MARCH), "{}", k.name());
        }
        assert_ne!(*b"mc", crate::addr::tag::POSTURE);
        let ctx = AddrCtx {
            season: [1; 32],
            program: [2; 32],
        };
        assert_ne!(march_state(&ctx, 0, 0), march_state(&ctx, 0, 1));
        // every member names the March back
        let (m, n) = march_of(5, -2);
        for (p, q) in march_members(m, n) {
            assert_eq!(march_of(p, q), (m, n));
        }
        assert_eq!(tag_of(AccountKind::MarchState), Some(MARCH));
        // S1: three more tags, distinct from every other.
        for t in [VAULT, CARAVAN, TOWER] {
            for k in crate::layout::AccountKind::ALL {
                assert_ne!(crate::addr::tag_of(k), Some(t), "{}", k.name());
            }
            assert_ne!(t, MARCH);
            assert_ne!(t, crate::addr::tag::POSTURE);
        }
        assert_eq!(vault_seed(-1, 2, 30).len(), 2 + 2 * VAULT_RAW_LEN);
        assert!(caravan_seed(u64::MAX, u32::MAX).len() <= 32);
        assert_ne!(vault(&ctx, 0, 0, 1), vault(&ctx, 0, 0, 2));
        assert_ne!(caravan(&ctx, 7, 1), caravan(&ctx, 7, 2));
        assert_ne!(tower(&ctx, 0, 0, 1), vault(&ctx, 0, 0, 1));
        assert_ne!(VAULT, TOWER);
        assert_ne!(CARAVAN, TOWER);
        assert_eq!(raw_len(AccountKind::Province), 8);
    }
}
