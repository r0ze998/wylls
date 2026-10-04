//! Contract §4.3: the brain keeps a private copy of `ready_host` and
//! `can_depart` (`ai/ready.rs`). Over the agents fixtures, every host
//! `policy::decide` departs is ready by the copy, and a host the copy calls
//! not ready is never departed (mutations of the stamina, the pending
//! order, the ready bell, the roster state, transit).

#[path = "ai_common.rs"]
mod common;

use common::*;
use fclient::abi::layout::entry as le;
use frontier_agents::fixture::{FINAL, SEED};
use frontier_agents::obs::Observation;
use frontier_agents::policy::{self, Ctx, Intent, Memory};
use frontier_agents::profile::Arch;
use frontier_bots::ai::ready;
use frontier_bots::bot::{Bot, Config};

fn departs(obs: &Observation, arch: Arch, bell_shift: u32) -> Vec<u64> {
    let spec = spec(FINAL, arch);
    let mem = Memory::default();
    let mut o = obs.clone();
    o.now += bell_shift as i64 * 600;
    resolve_all(&mut o);
    let cx = Ctx {
        spec: &spec,
        seed: SEED,
        wallet: frontier_agents::keys::wallet(SEED, FINAL).pubkey_for_test(),
        mem: &mem,
        reveal_loaded_limit: Config::new(SEED).reveal_loaded_limit(),
        direct: false,
        session: true,
    };
    policy::decide(&o, &cx)
        .into_iter()
        .filter_map(|i| match i {
            Intent::Depart(d) => Some(d.host_id),
            _ => None,
        })
        .collect()
}

trait PubkeyExt {
    fn pubkey_for_test(&self) -> fclient::Address;
}
impl PubkeyExt for fclient::Keypair {
    fn pubkey_for_test(&self) -> fclient::Address {
        use fclient::Signer;
        self.pubkey()
    }
}

fn ready_by_copy(obs: &Observation, host_id: u64) -> bool {
    let h = obs
        .me
        .holdings
        .iter()
        .map(|(_, h)| h)
        .find(|h| policy::host_of(h, host_id))
        .expect("the host's holding");
    let (_, e) = policy::own_hosts(obs, h)
        .into_iter()
        .find(|(_, e)| e.id == host_id)
        .expect("the host in view");
    ready::can_depart(h, &e, obs.bell())
}

#[tokio::test]
async fn every_host_the_policy_departs_is_ready_by_the_copy() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = Bot::new(spec(FINAL, Arch::Skilled), SEED)
        .observe(&r.sh)
        .await
        .unwrap();
    let mut seen = 0;
    for arch in [
        Arch::Casual,
        Arch::Daily,
        Arch::Skilled,
        Arch::VerySkilled,
        Arch::Bot,
    ] {
        for shift in 0..160u32 {
            let mut o = obs.clone();
            o.now += shift as i64 * 600;
            for host in departs(&obs, arch, shift) {
                seen += 1;
                assert!(ready_by_copy(&o, host), "{arch:?} shift {shift}");
            }
        }
    }
    assert!(
        seen >= 50,
        "the policy departed {seen} times: the check bites"
    );
}

/// Mutates the first combat host's entry in every province view.
fn mutate(obs: &Observation, f: impl Fn(&mut fclient::decode::Entry)) -> Observation {
    let mut o = obs.clone();
    for v in o.provinces.values_mut() {
        for e in v.province.entries.iter_mut() {
            if e.state != le::STATE_FREE && e.unit != ready::SCOUT {
                f(e);
            }
        }
    }
    o
}

#[tokio::test]
async fn a_host_the_copy_calls_not_ready_is_never_departed() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = Bot::new(spec(FINAL, Arch::Skilled), SEED)
        .observe(&r.sh)
        .await
        .unwrap();
    let bell = obs.bell();
    type Mutation = Box<dyn Fn(&mut fclient::decode::Entry)>;
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "stamina below the Depart cost",
            Box::new(|e| {
                e.stamina_value = 10;
                e.stamina_bell = 40;
            }),
        ),
        (
            "stamina exactly the cost minus one",
            Box::new(move |e| {
                e.stamina_value = ready::depart_stamina() - 1;
                e.stamina_bell = bell;
            }),
        ),
        ("a pending order", Box::new(|e| e.pend_op = 1)),
        (
            "ready bell in the future",
            Box::new(move |e| e.ready_bell = bell + 3),
        ),
        (
            "from bell in the future",
            Box::new(move |e| e.from_bell = bell + 3),
        ),
        (
            "muster pending",
            Box::new(|e| e.state = le::STATE_MUSTER_PENDING),
        ),
    ];
    for (name, f) in cases {
        let o = mutate(&obs, &f);
        let mut not_ready_shifts = 0;
        for shift in 0..40u32 {
            // The observation as the policy sees it at this bell.
            let mut at = o.clone();
            at.now += shift as i64 * 600;
            let h = at.me.holdings.iter().map(|(_, h)| h).next().unwrap();
            let any_ready = policy::own_hosts(&at, h)
                .iter()
                .any(|(_, e)| e.unit != ready::SCOUT && ready::can_depart(h, e, at.bell()));
            let d = departs(&o, Arch::Bot, shift);
            if !any_ready {
                not_ready_shifts += 1;
                assert!(
                    d.is_empty(),
                    "{name} shift {shift}: departed a host the copy calls not ready"
                );
            }
            for host in d {
                assert!(ready_by_copy(&at, host), "{name} shift {shift}");
            }
        }
        assert!(
            not_ready_shifts >= 1,
            "{name}: the case never made the host unready"
        );
    }
    // Sanity: the unmutated host does depart for some shift.
    assert!((0..40).any(|s| !departs(&obs, Arch::Bot, s).is_empty()));
}

#[tokio::test]
async fn the_stamina_boundary_is_the_departure_cost() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = Bot::new(spec(FINAL, Arch::Skilled), SEED)
        .observe(&r.sh)
        .await
        .unwrap();
    let h = obs.me.holdings.iter().map(|(_, h)| h).next().unwrap();
    let (_, mut e) = policy::own_hosts(&obs, h)
        .into_iter()
        .find(|(_, e)| e.unit != ready::SCOUT && h.transit_of(e.id).is_none())
        .unwrap();
    assert_eq!(
        ready::depart_stamina(),
        74,
        "10 + 2 x 32 (travel::march_stamina(MAX_PATH_STEPS))"
    );
    let bell = obs.bell();
    e.stamina_bell = bell;
    e.stamina_value = 73;
    assert!(!ready::can_depart(h, &e, bell));
    assert!(
        ready::can_depart(h, &e, bell + 1),
        "stamina regenerates +1 per bell"
    );
    e.stamina_value = 74;
    assert!(ready::can_depart(h, &e, bell));
    // departable_from: the later of the roster, ready and stamina bells.
    e.stamina_value = 60;
    e.stamina_bell = 30;
    e.from_bell = 20;
    e.ready_bell = 25;
    assert_eq!(ready::departable_from(h, &e), Some(30 + 14));
}
