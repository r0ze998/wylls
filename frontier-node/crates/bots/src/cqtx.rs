//! The bots' conquest instructions (MC contract §5.5): DeclareSiege (0xA0),
//! FileOutpost (0xA3) and RetireHost (0xA6), the P-class shapes a bot signs.
//!
//! **W2R2-F2 (A-42 brought forward):** every builder delegates to
//! `fclient::ix::v2`, the one builder the keeper, the relay shapes and the
//! program's own tests use, so a placeholder is `Addresses::absent(n)`
//! (System-owned, no data: the program's `is_absent`), never the System
//! Program's own account (owned by the native loader: refused
//! `BadAccount`). This module only adapts the bots' argument types; CQ3-E
//! may inline the calls and delete it.

use fclient::addr::Addresses;
use fclient::ix::v2 as fx;
use fclient::ix::{HoldingRef, Player, Site};
use fclient::{Address, Instruction};

/// The signer and payer of a player instruction (the session key acts,
/// the relay's key pays): `fclient`'s [`Player`].
pub type Signer = Player;

/// 0xA0 DeclareSiege. `owner_wallet` is the target's owner (`None` for a
/// Free City: `absent(0)`), `nearby` the first holding proving Frontier
/// protection (`None`: `absent(1)`).
pub fn declare_siege(
    a: &Addresses,
    p: &Signer,
    src: HoldingRef,
    target: (i16, i16, u8),
    entry: u8,
    owner_wallet: Option<&Address>,
    nearby: Option<(i16, i16, u8)>,
) -> Instruction {
    fx::declare_siege(
        a,
        p,
        &fx::DeclareSiegeArgs {
            src,
            target: (target.0, target.1),
            site: target.2,
            entry,
            owner_citizen: owner_wallet.map_or_else(|| a.absent(0), |w| a.citizen(w)),
            nearby: nearby.map(|n| (n.0, n.1)),
            nearby_site: nearby.map_or(0, |n| n.2),
        },
    )
}

/// 0xA3 FileOutpost of 1–3 sites anchored on `anchor` (generation
/// `anchor_gen`); `None` when the site list is empty or longer than 3 or
/// the anchor key is not encodable.
pub fn file_outpost(
    a: &Addresses,
    p: &Signer,
    sites: &[(i16, i16, u8)],
    anchor: HoldingRef,
    anchor_gen: u8,
) -> Option<Instruction> {
    if sites.is_empty() || sites.len() > 3 {
        return None;
    }
    let key =
        frontier_abi::addr::host_id(anchor.p as i32, anchor.q as i32, anchor.site, anchor_gen, 0)?;
    let sites: Vec<Site> = sites
        .iter()
        .map(|s| Site {
            p: s.0,
            q: s.1,
            site: s.2,
        })
        .collect();
    Some(fx::file_outpost(a, p, &sites, anchor, key))
}

/// 0xA6 RetireHost (the victim, during the season): `home` is the captured
/// Holding's `prev_home` (the host's return).
pub fn retire_host(
    a: &Addresses,
    p: &Signer,
    province: (i16, i16),
    entry: u8,
    captured: HoldingRef,
    home: HoldingRef,
) -> Instruction {
    fx::retire_host(
        a,
        p.actor,
        p.payer,
        a.citizen(&p.wallet),
        province,
        captured,
        home,
        entry,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::prologue::{Group, Wr};
    use frontier_abi::v2::prologue::accounts_of;
    use frontier_abi::v2::tags::Ix;

    fn count(gs: &[Group]) -> (usize, usize) {
        gs.iter().fold((0, 0), |(lo, hi), g| {
            (
                lo + g.specs.len() * g.min as usize,
                hi + g.specs.len() * g.max as usize,
            )
        })
    }

    fn fixture() -> (Addresses, Signer, HoldingRef) {
        let a = Addresses::new(Address::new_from_array([7; 32]), 8);
        let p = Signer {
            actor: Address::new_from_array([1; 32]),
            payer: Address::new_from_array([2; 32]),
            wallet: Address::new_from_array([3; 32]),
        };
        let h = HoldingRef {
            p: 4,
            q: -1,
            site: 2,
        };
        (a, p, h)
    }

    /// Every position's signer and writable flag follows the v2 table.
    fn flags(ix: &Instruction, kind: Ix) {
        let specs: Vec<_> = accounts_of(kind)
            .iter()
            .flat_map(|g| g.specs.iter())
            .collect();
        for (i, (m, s)) in ix.accounts.iter().zip(&specs).enumerate() {
            assert_eq!(m.is_signer, s.signer, "{kind:?} #{i} {}", s.name);
            match s.wr {
                Wr::W => assert!(m.is_writable, "{kind:?} #{i} {} writable", s.name),
                Wr::R => assert!(!m.is_writable, "{kind:?} #{i} {} read-only", s.name),
                Wr::Either => {}
            }
        }
    }

    /// W2R2-F2: the bots' shapes ARE `fclient`'s, account by account and
    /// flag by flag; the placeholders are `Addresses::absent(n)`, not the
    /// System Program's account (which the program refuses `BadAccount`).
    #[test]
    fn cq_tx_shapes_are_fclients_and_follow_the_v2_tables() {
        let (a, p, h) = fixture();
        let d = declare_siege(&a, &p, h, (5, -2, 3), 7, Some(&p.wallet), Some((4, -1, 2)));
        assert_eq!(d.data, vec![0xA0, 3, 7, 2]);
        let (lo, hi) = count(accounts_of(Ix::DeclareSiege));
        assert!(lo <= d.accounts.len() && d.accounts.len() <= hi);
        flags(&d, Ix::DeclareSiege);
        // a Free City horn with no nearby proof: the placeholders at [7], [8]
        let fcity = declare_siege(&a, &p, h, (5, -2, 3), 7, None, None);
        assert_eq!(fcity.accounts[7].pubkey, a.absent(0));
        assert_eq!(fcity.accounts[8].pubkey, a.absent(1));
        assert_ne!(fcity.accounts[7].pubkey, Address::new_from_array([0; 32]));
        assert_ne!(fcity.accounts[8].pubkey, Address::new_from_array([0; 32]));
        assert_ne!(fcity.accounts[7].pubkey, fcity.accounts[8].pubkey);
        flags(&fcity, Ix::DeclareSiege);
        let want = fx::declare_siege(
            &a,
            &p,
            &fx::DeclareSiegeArgs::free_city(&a, h, (5, -2), 3, 7),
        );
        assert_eq!(fcity.accounts, want.accounts);
        assert_eq!(fcity.data, want.data);

        let o = file_outpost(&a, &p, &[(5, -2, 3), (5, -2, 4)], h, 1).unwrap();
        assert_eq!(o.data[0], Ix::FileOutpost.tag());
        assert_eq!(o.data.len(), 2 + 5 * 2 + 8);
        // One province named once; the anchor last.
        assert_eq!(o.accounts.len(), 4 + 1 + 1 + 1 + 1);
        assert_eq!(o.accounts.last().unwrap().pubkey, h.address(&a));
        let (lo, hi) = count(accounts_of(Ix::FileOutpost));
        assert!(lo <= o.accounts.len() && o.accounts.len() <= hi);
        flags(&o, Ix::FileOutpost);
        let home = HoldingRef {
            p: 1,
            q: 1,
            site: 0,
        };
        let rt = retire_host(&a, &p, (5, -2), 9, h, home);
        assert_eq!(rt.data, vec![0xA6, 9]);
        let (lo, hi) = count(accounts_of(Ix::RetireHost));
        assert!(lo <= rt.accounts.len() && rt.accounts.len() <= hi);
        flags(&rt, Ix::RetireHost);
        assert!(file_outpost(&a, &p, &[], h, 1).is_none());
    }
}
