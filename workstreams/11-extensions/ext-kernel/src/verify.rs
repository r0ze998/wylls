//! The third party's check (contract §6): replay every recorded call from
//! the published bytes and the state before, and compare.
//!
//! Three verdicts, as `frontier-node/crates/verify`: anything the verifier
//! cannot judge (an effect set, receipt version or op it does not know, a
//! missing manifest or state) is UNVERIFIABLE, never PASS.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::error::ExtError;
use crate::exec::{run_entry, run_withdraw, Instance, Key};
use crate::grant::{Grant, GrantAdapter};
use crate::host::{CitizenKeys, HoldingAcct};
use crate::manifest::{id_of, CoreVersion, Manifest, ManifestId, EFFECT_SET};
use crate::receipt::{Call, Receipt, RECEIPT_VERSION, WITHDRAW};
use crate::registry::{status_at, Status};

#[derive(Clone, Debug, Default)]
pub struct Evidence {
    pub core: Option<CoreVersion>,
    /// Published bytes by id (what workstream 06's registry serves).
    pub manifests: BTreeMap<ManifestId, Vec<u8>>,
    pub history: BTreeMap<ManifestId, Vec<(i64, Status)>>,
    pub citizens: BTreeMap<Key, CitizenKeys>,
    pub holdings_before: BTreeMap<Key, HoldingAcct>,
    pub grants_before: BTreeMap<(Key, ManifestId), Grant>,
    pub instances_before: BTreeMap<(ManifestId, Key), Instance>,
    pub created_before: BTreeMap<ManifestId, u32>,
    pub log: Vec<(Call, Receipt)>,
    pub instances_after: Option<BTreeMap<(ManifestId, Key), Instance>>,
    pub holdings_after: Option<BTreeMap<Key, HoldingAcct>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub record: Option<usize>,
    pub code: &'static str,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail(Vec<Finding>),
    Unverifiable(Vec<Finding>),
}

impl Verdict {
    pub fn is_pass(&self) -> bool {
        matches!(self, Verdict::Pass)
    }
    pub fn codes(&self) -> Vec<&'static str> {
        match self {
            Verdict::Pass => Vec::new(),
            Verdict::Fail(f) | Verdict::Unverifiable(f) => f.iter().map(|x| x.code).collect(),
        }
    }
    pub fn fails_with(&self, code: &str) -> bool {
        matches!(self, Verdict::Fail(f) if f.iter().any(|x| x.code == code))
    }
    pub fn unverifiable_with(&self, code: &str) -> bool {
        matches!(self, Verdict::Unverifiable(f) if f.iter().any(|x| x.code == code))
    }
}

struct Cx {
    fail: Vec<Finding>,
    unver: Vec<Finding>,
}

impl Cx {
    fn fail(&mut self, i: Option<usize>, code: &'static str, d: impl Into<String>) {
        self.fail.push(Finding {
            record: i,
            code,
            detail: d.into(),
        });
    }
    fn unver(&mut self, i: Option<usize>, code: &'static str, d: impl Into<String>) {
        self.unver.push(Finding {
            record: i,
            code,
            detail: d.into(),
        });
    }
}

fn same_call(c: &Call, r: &Receipt) -> bool {
    c.manifest_id == r.manifest_id
        && c.citizen == r.citizen
        && c.holding == r.holding
        && c.entry == r.entry
        && c.args == r.args
        && c.seq == r.seq
        && c.now_ts == r.now_ts
}

pub fn verify(ev: &Evidence) -> Verdict {
    let mut cx = Cx {
        fail: Vec::new(),
        unver: Vec::new(),
    };
    let Some(core) = ev.core else {
        cx.unver(
            None,
            "MissingCoreVersion",
            "the core version the season ran is not given",
        );
        return Verdict::Unverifiable(cx.unver);
    };
    let mut inst = ev.instances_before.clone();
    let mut holdings = ev.holdings_before.clone();
    let mut grants = ev.grants_before.clone();
    let mut created = ev.created_before.clone();
    let mut decoded: BTreeMap<ManifestId, Manifest> = BTreeMap::new();
    // Chains and Holdings the verifier could not follow: later records on
    // them are not judged again (already UNVERIFIABLE), nor are their final
    // states.
    let mut lost_chain: BTreeSet<(ManifestId, Key)> = BTreeSet::new();
    let mut lost_holding: BTreeSet<Key> = BTreeSet::new();
    let mut touched_holdings: BTreeSet<Key> = BTreeSet::new();
    let mut touched_chains: BTreeSet<(ManifestId, Key)> = BTreeSet::new();

    for (i, (call, r)) in ev.log.iter().enumerate() {
        let at = Some(i);
        let chain = (r.manifest_id, r.citizen);
        touched_holdings.insert(r.holding);
        touched_chains.insert(chain);
        if lost_chain.contains(&chain) || lost_holding.contains(&r.holding) {
            continue;
        }
        let mut lose = |cx: &mut Cx, code, d: String| {
            cx.unver(at, code, d);
            lost_chain.insert(chain);
            lost_holding.insert(r.holding);
        };
        if r.receipt_version != RECEIPT_VERSION {
            lose(
                &mut cx,
                "UnknownReceiptVersion",
                format!("receipt version {}", r.receipt_version),
            );
            continue;
        }
        if r.effect_set != EFFECT_SET {
            lose(
                &mut cx,
                "UnknownEffectSet",
                format!("effect set {}", r.effect_set),
            );
            continue;
        }
        if !same_call(call, r) {
            cx.fail(
                at,
                "CallReceiptMismatch",
                "the receipt does not describe its call",
            );
            continue;
        }
        let m = match decoded.get(&r.manifest_id) {
            Some(m) => m.clone(),
            None => {
                let Some(bytes) = ev.manifests.get(&r.manifest_id) else {
                    lose(
                        &mut cx,
                        "MissingManifest",
                        "the published bytes are not given".into(),
                    );
                    continue;
                };
                if id_of(bytes) != r.manifest_id {
                    cx.fail(
                        at,
                        "ManifestHashMismatch",
                        "the bytes given are not this id's",
                    );
                    lost_chain.insert(chain);
                    lost_holding.insert(r.holding);
                    continue;
                }
                match Manifest::decode(bytes) {
                    Ok(m) => {
                        decoded.insert(r.manifest_id, m.clone());
                        m
                    }
                    Err(
                        e @ (ExtError::UnknownEffectSet
                        | ExtError::UnknownOp
                        | ExtError::UnknownSchema),
                    ) => {
                        lose(&mut cx, "UnknownManifestVocabulary", e.name().into());
                        continue;
                    }
                    Err(e) => {
                        cx.fail(at, "ManifestInvalid", e.name());
                        lost_chain.insert(chain);
                        lost_holding.insert(r.holding);
                        continue;
                    }
                }
            }
        };
        let withdraw = r.entry == WITHDRAW;
        match ev
            .history
            .get(&r.manifest_id)
            .and_then(|h| status_at(h, r.now_ts))
        {
            None => {
                cx.fail(
                    at,
                    "NotRegisteredAtTime",
                    "no registration covers the call's time",
                );
                continue;
            }
            Some(Status::Active) if withdraw => {
                cx.fail(
                    at,
                    "WithdrawWhileActive",
                    "the exit ran while the extension was active",
                );
                continue;
            }
            Some(Status::Paused | Status::Revoked) if !withdraw => {
                cx.fail(
                    at,
                    "CalledWhileStopped",
                    "a call ran while the extension was stopped",
                );
                continue;
            }
            _ => {}
        }
        if !withdraw && m.core != core {
            cx.fail(at, "CoreVersion", "the manifest names another core version");
            continue;
        }
        let Some(keys) = ev.citizens.get(&r.citizen) else {
            lose(
                &mut cx,
                "MissingCitizen",
                "the citizen's keys are not given".into(),
            );
            continue;
        };
        let signed = call.signer == keys.wallet
            || (keys.session != [0; 32]
                && call.signer == keys.session
                && call.now_ts < keys.session_expiry);
        if !signed {
            cx.fail(
                at,
                "NotSigned",
                "the signer is neither the wallet nor a live session",
            );
            continue;
        }
        let Some(h) = holdings.get(&r.holding).cloned() else {
            lose(
                &mut cx,
                "MissingHolding",
                "the Holding's state before is not given".into(),
            );
            continue;
        };
        if h.owner_citizen != r.citizen {
            cx.fail(at, "NotOwner", "the Holding is not the caller's");
            continue;
        }
        let pre = match inst.get(&chain) {
            Some(x) => x.clone(),
            None if withdraw => {
                cx.fail(
                    at,
                    "NoInstance",
                    "an exit from an instance that never existed",
                );
                continue;
            }
            None => {
                let n = created.entry(r.manifest_id).or_insert(0);
                if *n >= m.max_instances {
                    cx.fail(at, "InstanceCap", "more instances than the manifest allows");
                    continue;
                }
                *n += 1;
                Instance::fresh(&m)
            }
        };
        if r.seq != pre.seq {
            cx.fail(
                at,
                "SeqReplay",
                format!("seq {} where the state is at {}", r.seq, pre.seq),
            );
            continue;
        }
        if r.prev_receipt != pre.last_receipt {
            cx.fail(
                at,
                "ChainBreak",
                "the receipt does not follow the chain's head",
            );
            continue;
        }
        if r.pre_state != pre.state_hash(&r.manifest_id, &r.citizen) {
            cx.fail(
                at,
                "PreStateMismatch",
                "the state before is not the one replayed",
            );
            continue;
        }
        if !withdraw {
            match grants.get(&(r.citizen, r.manifest_id)) {
                None => {
                    cx.fail(
                        at,
                        "NoGrant",
                        "no grant of this user for this exact manifest",
                    );
                    continue;
                }
                Some(g) => {
                    if let Err(e) = g.authorize(&r.citizen, &r.manifest_id, r.entry, r.now_ts) {
                        cx.fail(at, "GrantRefuses", e.name());
                        continue;
                    }
                }
            }
        }
        let run = if withdraw {
            run_withdraw(r.now_ts, &pre, &h.holding)
        } else {
            run_entry(&m, r.entry, &r.args, r.now_ts, &pre, &h.holding)
        };
        let out = match run {
            Ok(o) => o,
            Err(e) => {
                cx.fail(
                    at,
                    "RulesRefuse",
                    format!("the rules refuse the recorded call: {}", e.name()),
                );
                continue;
            }
        };
        if !withdraw {
            let g = grants
                .get_mut(&(r.citizen, r.manifest_id))
                .expect("checked above");
            if let Err(e) = g.check_spend(&out.spent) {
                cx.fail(at, "GrantRefuses", e.name());
                continue;
            }
            g.consume(&out.spent);
        }
        let mut post = out.instance.clone();
        let same = r.post_state == post.state_hash(&r.manifest_id, &r.citizen)
            && r.holding_delta == out.holding_delta
            && r.escrow_delta == out.escrow_delta
            && r.burned == out.burned
            && r.events == out.events;
        if !same {
            cx.fail(
                at,
                "ReceiptMismatch",
                "the receipt is not what the rules produce",
            );
            continue;
        }
        post.last_receipt = r.id();
        inst.insert(chain, post);
        holdings.insert(
            r.holding,
            HoldingAcct {
                owner_citizen: h.owner_citizen,
                holding: out.holding,
            },
        );
    }

    match (&ev.instances_after, &ev.holdings_after) {
        (Some(ia), Some(ha)) => {
            for k in &touched_chains {
                if lost_chain.contains(k) {
                    continue;
                }
                if ia.get(k) != inst.get(k) {
                    cx.fail(
                        None,
                        "FinalStateMismatch",
                        "an instance's final state is not the replay's",
                    );
                }
            }
            // A write with no receipt: an instance that changed though no
            // recorded call touched it.
            for (k, v) in ia {
                if !touched_chains.contains(k) && ev.instances_before.get(k) != Some(v) {
                    cx.fail(
                        None,
                        "UnexplainedWrite",
                        "an instance changed with no receipt",
                    );
                }
            }
            for k in &touched_holdings {
                if lost_holding.contains(k) {
                    continue;
                }
                match (ha.get(k), holdings.get(k)) {
                    (Some(a), Some(b)) if a.holding == b.holding => {}
                    (None, _) => cx.unver(
                        None,
                        "MissingFinalState",
                        "a touched Holding's final state is not given",
                    ),
                    _ => cx.fail(
                        None,
                        "FinalStateMismatch",
                        "a Holding's final state is not the replay's",
                    ),
                }
            }
            // A Holding that changed outside any extension call is the core
            // verifier's to judge (V7), not this one's: not a pass here.
            for (k, v) in ha {
                if !touched_holdings.contains(k)
                    && ev.holdings_before.get(k).map(|x| &x.holding) != Some(&v.holding)
                {
                    cx.unver(
                        None,
                        "OutsideExtensions",
                        "a Holding changed with no extension receipt",
                    );
                }
            }
        }
        _ => cx.unver(None, "MissingFinalState", "the final state is not given"),
    }

    if !cx.fail.is_empty() {
        Verdict::Fail(cx.fail)
    } else if !cx.unver.is_empty() {
        Verdict::Unverifiable(cx.unver)
    } else {
        Verdict::Pass
    }
}
