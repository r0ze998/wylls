//! The keeper's home on a NATURAL world, taken from ONE landed PlaceHome (no fixture, no state written by the runner).
//!
//! A launcher world that starts from the player's real Join and PlaceHome hands its keeper two things: the player's
//! Holding (for the origin/destination/resident drivers) and the home province (for FastForward and the anchors,
//! `keeper_loop::run_at`). Both come from the SAME successful PlaceHome — the site `(p, q, site)` its landed wire
//! bytes were identified at — and are accepted only if every record the program itself wrote agrees on that one site:
//!   - the Citizen: this wallet's, HOME_GRANTED, its holding slot 1 at exactly `(p, q, site)` with the Holding's gen;
//!   - the Holding at the address derived from `(p, q, site)`: a legacy Holding at exactly that site, FINAL, owned by
//!     this wallet's Citizen;
//!   - the home Province at the address derived from `(p, q)`: at exactly `(p, q)`, its site mirror `site` HOLDING with
//!     the Holding's gen.
//! Anything else is an error and the keeper is not started (no guess, no second source, nothing sent).
//! Pure: the caller reads the three accounts from the chain after the PlaceHome landed.

use fclient::addr::Addresses;
use fclient::Address;
use frontier_abi::layout::player::holding_ref as HR;
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::province::{province as P, site as SM};

/// What the keeper is started with: the Holding and the home province, from one PlaceHome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NaturalHome {
    pub holding: Address,
    pub home: (i16, i16),
    pub site: u8,
    pub gen: u8,
}

fn i16_at(d: &[u8], o: usize) -> Option<i16> {
    d.get(o..o + 2).map(|b| i16::from_le_bytes([b[0], b[1]]))
}

/// `at`: the site the landed PlaceHome was identified at; `citizen`, `holding`, `province`: the bytes of the accounts at
/// `a.citizen(wallet)`, `a.holding(at)` and `a.province(at.0, at.1)` after it landed.
pub fn natural_home(a: &Addresses, wallet: &Address, at: (i16, i16, u8), citizen: &[u8], holding: &[u8], province: &[u8]) -> Result<NaturalHome, String> {
    let citizen_key = a.citizen(wallet);
    // the Citizen: this wallet's, home granted, slot 1 at the PlaceHome's site
    if citizen.len() < C::FLAGS + 1 || citizen.get(C::WALLET..C::WALLET + 32) != Some(wallet.to_bytes().as_slice()) {
        return Err("the Citizen is not this wallet's".into());
    }
    if citizen[C::FLAGS] & C::FLAG_HOME_GRANTED == 0 {
        return Err("the Citizen's home is not granted".into());
    }
    let slot = C::holding_of_slot(1);
    let (sp, sq) = (i16_at(citizen, slot + HR::P).ok_or("the Citizen is too short")?, i16_at(citizen, slot + HR::Q).ok_or("the Citizen is too short")?);
    let (ssite, sgen) = (*citizen.get(slot + HR::SITE).ok_or("the Citizen is too short")?, *citizen.get(slot + HR::GEN).ok_or("the Citizen is too short")?);
    if (sp, sq, ssite) != at {
        return Err(format!("the Citizen's home slot is at {:?}, not the PlaceHome's {at:?}", (sp, sq, ssite)));
    }
    // the Holding: legacy, at the PlaceHome's site, FINAL, owned by this Citizen, the same gen as the Citizen's slot
    if holding.len() < H::OWNER_CITIZEN + 32 || holding.get(..8) != Some(b"PSF1HOLD".as_slice()) {
        return Err("the Holding is not a legacy Holding".into());
    }
    let (hp, hq) = (i16_at(holding, H::P).ok_or("the Holding is too short")?, i16_at(holding, H::Q).ok_or("the Holding is too short")?);
    if (hp, hq, holding[H::SITE]) != at {
        return Err(format!("the Holding is at {:?}, not the PlaceHome's {at:?}", (hp, hq, holding[H::SITE])));
    }
    if holding[H::STATE] != H::STATE_FINAL {
        return Err("the Holding is not final".into());
    }
    if holding[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] != citizen_key.to_bytes() {
        return Err("the Holding's owner is not this wallet's Citizen".into());
    }
    let gen = holding[H::GEN];
    if sgen != gen {
        return Err(format!("the Citizen's home slot has gen {sgen}, the Holding {gen}"));
    }
    // the home Province: at (p, q), its site mirror `site` HOLDING with the Holding's gen
    let (pp, pq) = (i16_at(province, P::P).ok_or("the Province is too short")?, i16_at(province, P::Q).ok_or("the Province is too short")?);
    if (pp, pq) != (at.0, at.1) {
        return Err(format!("the home Province is at {:?}, not the PlaceHome's {:?}", (pp, pq), (at.0, at.1)));
    }
    if at.2 as usize >= *province.get(P::SITE_COUNT).ok_or("the Province is too short")? as usize {
        return Err("the PlaceHome's site is not one of the Province's sites".into());
    }
    let m = P::site(at.2 as usize);
    let (mstate, mgen) = (*province.get(m + SM::STATE).ok_or("the Province is too short")?, *province.get(m + SM::GEN).ok_or("the Province is too short")?);
    if mstate != SM::STATE_HOLDING || mgen != gen {
        return Err(format!("the Province's site {} is not this Holding (state {mstate}, gen {mgen})", at.2));
    }
    Ok(NaturalHome { holding: a.holding(at.0 as i32, at.1 as i32, at.2), home: (at.0, at.1), site: at.2, gen })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expedition_play::{PROGRAM, SEASON_ID};

    const AT: (i16, i16, u8) = (1, 1, 0);

    fn addrs() -> Addresses {
        Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID)
    }
    /// The three records a landed PlaceHome at `AT` leaves (only the fields this check reads).
    fn records(wallet: &Address) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let a = addrs();
        let mut c = vec![0u8; C::SIZE];
        c[C::WALLET..C::WALLET + 32].copy_from_slice(&wallet.to_bytes());
        c[C::FLAGS] = C::FLAG_JOINED | C::FLAG_HOME_GRANTED;
        let s = C::holding_of_slot(1);
        c[s + HR::P..s + HR::P + 2].copy_from_slice(&AT.0.to_le_bytes());
        c[s + HR::Q..s + HR::Q + 2].copy_from_slice(&AT.1.to_le_bytes());
        c[s + HR::SITE] = AT.2;
        c[s + HR::GEN] = 2;
        let mut h = vec![0u8; H::SIZE];
        h[..8].copy_from_slice(b"PSF1HOLD");
        h[H::P..H::P + 2].copy_from_slice(&AT.0.to_le_bytes());
        h[H::Q..H::Q + 2].copy_from_slice(&AT.1.to_le_bytes());
        h[H::SITE] = AT.2;
        h[H::GEN] = 2;
        h[H::STATE] = H::STATE_FINAL;
        h[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].copy_from_slice(&a.citizen(wallet).to_bytes());
        let mut p = vec![0u8; P::SIZE];
        p[P::P..P::P + 2].copy_from_slice(&AT.0.to_le_bytes());
        p[P::Q..P::Q + 2].copy_from_slice(&AT.1.to_le_bytes());
        p[P::SITE_COUNT] = 12;
        p[P::site(AT.2 as usize) + SM::STATE] = SM::STATE_HOLDING;
        p[P::site(AT.2 as usize) + SM::GEN] = 2;
        (c, h, p)
    }

    #[test]
    fn holding_and_home_come_from_the_one_placehome_when_every_record_agrees() {
        let (a, w) = (addrs(), Address::new_from_array([7; 32]));
        let (c, h, p) = records(&w);
        let n = natural_home(&a, &w, AT, &c, &h, &p).unwrap();
        assert_eq!(n, NaturalHome { holding: a.holding(1, 1, 0), home: (1, 1), site: 0, gen: 2 });
    }

    #[test]
    fn any_disagreement_is_refused() {
        let (a, w) = (addrs(), Address::new_from_array([7; 32]));
        let other = Address::new_from_array([8; 32]);
        let base = records(&w);
        let refuse = |f: &dyn Fn(&mut Vec<u8>, &mut Vec<u8>, &mut Vec<u8>), why: &str| {
            let (mut c, mut h, mut p) = base.clone();
            f(&mut c, &mut h, &mut p);
            assert!(natural_home(&a, &w, AT, &c, &h, &p).is_err(), "{why}");
        };
        let s = C::holding_of_slot(1);
        refuse(&|c, _, _| c[C::WALLET] ^= 1, "another wallet's Citizen");
        refuse(&|c, _, _| c[C::FLAGS] &= !C::FLAG_HOME_GRANTED, "home not granted");
        refuse(&|c, _, _| c[s + HR::SITE] = 1, "the Citizen's slot at another site");
        refuse(&|c, _, _| c[s + HR::P] = 2, "the Citizen's slot in another province");
        refuse(&|c, _, _| c[s + HR::GEN] = 3, "the Citizen's slot with another gen");
        refuse(&|_, h, _| h[..8].copy_from_slice(b"PSF2HOLD"), "not a legacy Holding");
        refuse(&|_, h, _| h[H::SITE] = 4, "the Holding at another site");
        refuse(&|_, h, _| h[H::Q] = 9, "the Holding in another province");
        refuse(&|_, h, _| h[H::STATE] = 0, "the Holding not final");
        refuse(&|_, h, _| h[H::OWNER_CITIZEN] ^= 1, "the Holding owned by another Citizen");
        refuse(&|_, _, p| p[P::P] = 5, "the Province at another coordinate");
        refuse(&|_, _, p| p[P::SITE_COUNT] = 0, "the site is not one of the Province's");
        refuse(&|_, _, p| p[P::site(0) + SM::STATE] = SM::STATE_FREE, "the site mirror is not a holding");
        refuse(&|_, _, p| p[P::site(0) + SM::GEN] = 9, "the site mirror's gen differs");
        refuse(&|c, h, p| { c.truncate(10); h.truncate(10); p.truncate(10); }, "short records");
        // another PlaceHome site than the records' is refused (the pair must come from the one PlaceHome)
        let (c, h, p) = base.clone();
        assert!(natural_home(&a, &w, (1, 1, 1), &c, &h, &p).is_err());
        assert!(natural_home(&a, &other, AT, &c, &h, &p).is_err(), "another wallet asked");
    }
}
