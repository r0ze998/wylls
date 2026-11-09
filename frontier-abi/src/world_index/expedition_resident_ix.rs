//! Closed construction contract for original-origin resident Dissolve/Return.
//!
//! These **proposed**, unallocated envelope sub-operations are deliberately NOT
//! recognized by `wide_ix::WideCommand`, v2 or ResidentAct. No dispatcher routes
//! them. Sharing the private writer's exact account table does not activate it.
//! The payload is a full original host reference. The standing Province remains
//! a canonical account role, not an extra payload or an alternate home issuer.
use super::expedition::AccountResolver;
use super::key::{WideHostRef, HOST_REF_LEN};
use super::wide_ix::{ENVELOPE_ESCAPE, ENVELOPE_VERSION, TAG_DEPART, TAG_SETTLE_TICKET};
use crate::addr::AddrCtx;
use crate::error::FrontierError;
use crate::prologue::{Acc, Group, Spec, Wr};

pub use super::expedition_resident_event::Action;
pub const DISSOLVE_OP: u8 = 7;
pub const RETURN_OP: u8 = 12;
pub const DRAFT_LEN: usize = 4 + HOST_REF_LEN;
pub const PUBLIC_DISPATCH_AVAILABLE: bool = false;

const fn spec(name: &'static str, signer: bool, wr: Wr) -> Spec {
    Spec {
        name,
        acc: Acc::Any,
        signer,
        wr,
    }
}
/// Exactly the existing private writer's table. `Acc::Any` preserves its flag
/// semantics: R is the canonical minimum, not a ban on elevated runtime flags.
pub const DISSOLVE: &[Group] = &[Group {
    specs: &[
        spec("actor", true, Wr::R),
        spec("payer", true, Wr::W),
        spec("season", false, Wr::R),
        spec("citizen", false, Wr::W),
        spec("holding", false, Wr::W),
        spec("standing", false, Wr::W),
        spec("roster", false, Wr::R),
        spec("home", false, Wr::R),
    ],
    min: 1,
    max: 1,
}];
pub const RETURN: &[Group] = &[Group {
    specs: &[
        spec("payer", true, Wr::W),
        spec("season", false, Wr::R),
        spec("standing", false, Wr::W),
        spec("roster", false, Wr::W),
        spec("holding", false, Wr::W),
        spec("home", false, Wr::R),
    ],
    min: 1,
    max: 1,
}];

/// A byte proposal, never an accepted public command or an authorization.
/// Scope validation is mathematical only; the supplied Season and program
/// addresses have not been authenticated against an account or deployment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DraftCommand {
    action: Action,
    host: WideHostRef,
}
impl DraftCommand {
    pub fn new(ctx: &AddrCtx, action: Action, host: WideHostRef) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        if ctx.program == [0; 32] || ctx.season == [0; 32] {
            return Err(bad);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| bad)?;
        let id = resolver.legacy_host_id(&host).map_err(|_| bad)?;
        if resolver.legacy_host_ref(id).map_err(|_| bad)? != host {
            return Err(bad);
        }
        Ok(Self { action, host })
    }
    pub const fn action(&self) -> Action {
        self.action
    }
    pub const fn host(&self) -> WideHostRef {
        self.host
    }
    pub const fn public_dispatch_available(&self) -> bool {
        PUBLIC_DISPATCH_AVAILABLE
    }
    pub const fn class(&self) -> crate::tags::Class {
        match self.action {
            Action::Dissolve => crate::tags::Class::P,
            Action::Return => crate::tags::Class::D,
        }
    }
    pub const fn groups(&self) -> &'static [Group] {
        match self.action {
            Action::Dissolve => DISSOLVE,
            Action::Return => RETURN,
        }
    }
    pub fn to_bytes(&self) -> [u8; DRAFT_LEN] {
        let mut out = [0; DRAFT_LEN];
        let (tag, op) = match self.action {
            Action::Dissolve => (TAG_DEPART, DISSOLVE_OP),
            Action::Return => (TAG_SETTLE_TICKET, RETURN_OP),
        };
        out[..4].copy_from_slice(&[tag, ENVELOPE_ESCAPE, ENVELOPE_VERSION, op]);
        out[4..].copy_from_slice(&self.host.to_bytes());
        out
    }
    pub fn decode(ctx: &AddrCtx, bytes: &[u8]) -> Result<Self, FrontierError> {
        let bad = FrontierError::BadData;
        if bytes.len() != DRAFT_LEN || bytes[1] != ENVELOPE_ESCAPE || bytes[2] != ENVELOPE_VERSION {
            return Err(bad);
        }
        let action = match (bytes[0], bytes[3]) {
            (TAG_DEPART, DISSOLVE_OP) => Action::Dissolve,
            (TAG_SETTLE_TICKET, RETURN_OP) => Action::Return,
            _ => return Err(bad),
        };
        Self::new(
            ctx,
            action,
            WideHostRef::from_bytes(&bytes[4..]).map_err(|_| bad)?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::{wide_ix as w, ProvinceKey, WideCoord};
    use alloc::{vec, vec::Vec};
    fn context() -> AddrCtx {
        AddrCtx {
            program: [4; 32],
            season: [5; 32],
        }
    }
    fn host(ctx: &AddrCtx) -> WideHostRef {
        AccountResolver::for_season(ctx)
            .unwrap()
            .legacy_host_ref(crate::addr::host_id(128, 0, 1, 2, 0).unwrap())
            .unwrap()
    }
    #[test]
    fn closed_resident_drafts_round_trip_without_public_or_wrapper_admission() {
        let ctx = context();
        for action in [Action::Dissolve, Action::Return] {
            let c = DraftCommand::new(&ctx, action, host(&ctx)).unwrap();
            let b = c.to_bytes();
            assert_eq!(b.len(), 60);
            assert_eq!(DraftCommand::decode(&ctx, &b).unwrap(), c);
            assert!(!c.public_dispatch_available());
            assert!(w::WideCommand::decode(&b).is_err());
            assert!(crate::v2::ix::tag_of(&b).is_err());
            let mut wrapper = [0; 65];
            let n = w::ResidentAct {
                generation: 1,
                inner: &b,
            }
            .encode_into(&mut wrapper)
            .unwrap();
            assert!(w::ResidentAct::decode(&wrapper[..n]).is_err());
        }
    }
    #[test]
    fn closed_resident_drafts_are_exact_and_context_bound() {
        let ctx = context();
        for action in [Action::Dissolve, Action::Return] {
            let b = DraftCommand::new(&ctx, action, host(&ctx))
                .unwrap()
                .to_bytes();
            for n in 0..b.len() {
                assert!(DraftCommand::decode(&ctx, &b[..n]).is_err());
            }
            let mut longer = b.to_vec();
            longer.push(0);
            assert!(DraftCommand::decode(&ctx, &longer).is_err());
            for i in [0, 1, 2, 3, 4, 5, 54] {
                let mut bad = b;
                bad[i] = if i == 54 { 255 } else { bad[i] ^ 1 };
                assert!(DraftCommand::decode(&ctx, &bad).is_err(), "offset {i}");
            }
            let other = AddrCtx {
                season: [6; 32],
                ..ctx
            };
            assert!(DraftCommand::decode(&other, &b).is_err());
        }
    }
    #[test]
    fn closed_resident_drafts_require_exact_original_family() {
        let ctx = context();
        let r = AccountResolver::for_season(&ctx).unwrap();
        let wide = WideHostRef::new(
            ProvinceKey::new(r.adapter().world(), WideCoord::checked(129, 0).unwrap()),
            1,
            2,
            0,
        )
        .unwrap();
        assert!(DraftCommand::new(&ctx, Action::Return, wide).is_err());
        assert!(DraftCommand::new(
            &AddrCtx {
                program: [0; 32],
                ..ctx
            },
            Action::Return,
            host(&ctx)
        )
        .is_err());
        assert!(DraftCommand::new(
            &AddrCtx {
                season: [0; 32],
                ..ctx
            },
            Action::Return,
            host(&ctx)
        )
        .is_err());
    }
    #[test]
    fn closed_resident_role_tables_preserve_private_contract() {
        for (action, n, signers, writes, names) in [
            (
                Action::Dissolve,
                8,
                vec![0, 1],
                vec![1, 3, 4, 5],
                vec![
                    "actor", "payer", "season", "citizen", "holding", "standing", "roster", "home",
                ],
            ),
            (
                Action::Return,
                6,
                vec![0],
                vec![0, 2, 3, 4],
                vec!["payer", "season", "standing", "roster", "holding", "home"],
            ),
        ] {
            let c = DraftCommand::new(&context(), action, host(&context())).unwrap();
            let g = c.groups();
            assert_eq!(g.len(), 1);
            assert_eq!((g[0].min, g[0].max), (1, 1));
            let specs = g[0].specs;
            assert_eq!(specs.len(), n);
            assert_eq!(specs.iter().map(|s| s.name).collect::<Vec<_>>(), names);
            for (i, s) in specs.iter().enumerate() {
                assert_eq!(s.acc, Acc::Any);
                assert_eq!(s.signer, signers.contains(&i));
                assert_eq!(s.wr == Wr::W, writes.contains(&i));
            }
        }
    }
}
