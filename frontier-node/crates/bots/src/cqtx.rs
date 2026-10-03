//! The bots' conquest instructions (MC contract v1.3 §5.5): DeclareSiege
//! (0xA0), FileOutpost (0xA3) and RetireHost (0xA6), the P-class shapes a
//! bot signs. Data is `frontier_abi::v2::ix`'s encoding and the account
//! order is `frontier_abi::v2::prologue::accounts_of`'s.
//!
//! **Interim (CQ2-F deviation D-2):** §8.1 gives these builders to
//! `fclient` (CQ2-D, the same wave). Until `fclient`'s v2 builders merge,
//! this module builds the three shapes from the canonical tables; the
//! integrator swaps each call for `fclient`'s and deletes the module
//! (`cq_tx_shapes_follow_the_v2_tables` pins the shapes meanwhile).

use fclient::addr::Addresses;
use fclient::ix::{r, rs, w, ws, HoldingRef, Player};
use fclient::{Address, Instruction};
use frontier_abi::ix::TicketSite;
use frontier_abi::v2::ix::{DeclareSiege, FileOutpost, RetireHost};

/// The signer and payer of a player instruction (the session key acts,
/// the relay's key pays): `fclient`'s [`Player`].
pub type Signer = Player;

fn prologue(a: &Addresses, p: &Signer) -> Vec<fclient::AccountMeta> {
    vec![
        rs(p.actor),
        ws(p.payer),
        r(a.season),
        w(a.citizen(&p.wallet)),
    ]
}

/// An absent account at a position the list keeps (a Free City's owner
/// Citizen, an unneeded nearby Province): the system program's address,
/// which holds no Frontier account.
pub fn absent() -> Address {
    Address::new_from_array([0; 32])
}

/// 0xA0 DeclareSiege: `[actor s] [payer s,w] [season r] [citizen w]
/// [src_holding w] [province w] [target_holding r] [owner_citizen r]
/// [nearby_province r] [system]`.
#[allow(clippy::too_many_arguments)]
pub fn declare_siege(
    a: &Addresses,
    p: &Signer,
    src: HoldingRef,
    target: (i16, i16, u8),
    entry: u8,
    owner_wallet: Option<&Address>,
    nearby: Option<(i16, i16, u8)>,
) -> Instruction {
    let mut m = prologue(a, p);
    m.push(w(src.address(a)));
    m.push(w(a.province(target.0 as i32, target.1 as i32)));
    m.push(r(a.holding(target.0 as i32, target.1 as i32, target.2)));
    m.push(r(owner_wallet.map_or_else(absent, |x| a.citizen(x))));
    m.push(r(
        nearby.map_or_else(absent, |n| a.province(n.0 as i32, n.1 as i32))
    ));
    m.push(r(fclient::addr::system_program()));
    let d = DeclareSiege {
        site: target.2,
        entry,
        nearby_site: nearby.map_or(0, |n| n.2),
    };
    Instruction {
        program_id: a.program,
        accounts: m,
        data: d.to_bytes().to_vec(),
    }
}

/// 0xA3 FileOutpost: FileTicket's list (`[actor s] [payer s,w] [season r]
/// [citizen w] [frontier r] [province w × n] [system]`) + `[anchor_holding
/// w]`.
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
    let mut m = prologue(a, p);
    m.push(r(a.frontier()));
    let mut provs: Vec<(i16, i16)> = vec![];
    for s in sites {
        if !provs.contains(&(s.0, s.1)) {
            provs.push((s.0, s.1));
        }
    }
    for (pp, qq) in &provs {
        m.push(w(a.province(*pp as i32, *qq as i32)));
    }
    m.push(r(fclient::addr::system_program()));
    m.push(w(anchor.address(a)));
    let mut ts = [TicketSite::default(); 3];
    for (i, s) in sites.iter().enumerate() {
        ts[i] = TicketSite {
            p: s.0,
            q: s.1,
            site: s.2,
        };
    }
    let key =
        frontier_abi::addr::host_id(anchor.p as i32, anchor.q as i32, anchor.site, anchor_gen, 0)?;
    let o = FileOutpost {
        n: sites.len() as u8,
        sites: ts,
        anchor_site_key: key,
    };
    let mut buf = [0u8; FileOutpost::MAX_LEN];
    let n = o.encode(&mut buf)?;
    Some(Instruction {
        program_id: a.program,
        accounts: m,
        data: buf[..n].to_vec(),
    })
}

/// 0xA6 RetireHost (the victim, during the season): `[actor s] [payer
/// s,w] [season r] [victim_citizen r] [province w] [captured_holding r]
/// [home_holding r]`.
pub fn retire_host(
    a: &Addresses,
    p: &Signer,
    province: (i16, i16),
    entry: u8,
    captured: HoldingRef,
    home: HoldingRef,
) -> Instruction {
    let m = vec![
        rs(p.actor),
        ws(p.payer),
        r(a.season),
        r(a.citizen(&p.wallet)),
        w(a.province(province.0 as i32, province.1 as i32)),
        r(captured.address(a)),
        r(home.address(a)),
    ];
    Instruction {
        program_id: a.program,
        accounts: m,
        data: RetireHost { entry }.to_bytes().to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::prologue::Group;
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

    /// The shapes follow the v2 tables: tags, data lengths, account counts
    /// and the writable/signer flags of every position.
    #[test]
    fn cq_tx_shapes_follow_the_v2_tables() {
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
        let d = declare_siege(&a, &p, h, (5, -2, 3), 7, Some(&p.wallet), Some((4, -1, 2)));
        assert_eq!(d.data[0], Ix::DeclareSiege.tag());
        assert_eq!(d.data, vec![0xA0, 3, 7, 2]);
        let (lo, hi) = count(accounts_of(Ix::DeclareSiege));
        assert!(lo <= d.accounts.len() && d.accounts.len() <= hi);
        let specs: Vec<_> = accounts_of(Ix::DeclareSiege)
            .iter()
            .flat_map(|g| g.specs.iter())
            .collect();
        for (m, s) in d.accounts.iter().zip(&specs) {
            assert_eq!(m.is_signer, s.signer, "{}", s.name);
        }
        let o = file_outpost(&a, &p, &[(5, -2, 3), (5, -2, 4)], h, 1).unwrap();
        assert_eq!(o.data[0], Ix::FileOutpost.tag());
        assert_eq!(o.data.len(), 2 + 5 * 2 + 8);
        // One province named once; the anchor last.
        assert_eq!(o.accounts.len(), 4 + 1 + 1 + 1 + 1);
        assert_eq!(o.accounts.last().unwrap().pubkey, h.address(&a));
        let (lo, hi) = count(accounts_of(Ix::FileOutpost));
        assert!(lo <= o.accounts.len() && o.accounts.len() <= hi);
        let rt = retire_host(
            &a,
            &p,
            (5, -2),
            9,
            h,
            HoldingRef {
                p: 1,
                q: 1,
                site: 0,
            },
        );
        assert_eq!(rt.data, vec![0xA6, 9]);
        let (lo, hi) = count(accounts_of(Ix::RetireHost));
        assert!(lo <= rt.accounts.len() && rt.accounts.len() <= hi);
        assert!(file_outpost(&a, &p, &[], h, 1).is_none());
    }
}
