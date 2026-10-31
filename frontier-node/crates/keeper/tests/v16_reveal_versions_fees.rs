//! ⑯ independent verification (⑱ "the retries sent 27"; ⑰ fee
//! reconciliation): how many versions the keeper's engine sends for one
//! Reveal (class W: a new version every slot until one lands), whether the
//! write ends once (no second effect from the engine's side), and whether
//! the fees of the losing versions that land too are counted.
//!
//! On a real chain every version that lands pays its fee, the winner and
//! each later one that fails `AlreadyDone` (code 52) alike. The engine's
//! `KindStats.fees_charged` is documented as "Fees of landed-or-failed
//! versions (charged)". The chain here is a script (a stand-in): it holds
//! every version unanswered for `HOLD` slots, then lands the newest one and
//! answers every older one `AlreadyDone`, as the program would for a second
//! Reveal of the same march (that refusal is the program's; it is modelled
//! here, not executed). The engine, its bids, its fee arithmetic and its
//! bookkeeping are the real code.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use fclient::abi::{self, Class};
use fclient::budgets::Budgets;
use fclient::ports::{Account, ChainPort, ClockSysvar, Cursor, PortResult, Signature, SimResult, Status, TxRecord};
use fclient::{tx, Address, Hash, Instruction};
use keeper_core::config::KeeperConfig;
use keeper_core::engine::{BuildCtx, Engine, EngineParams, Outcome, WriteSpec};
use keeper_core::journal::Journal;
use keeper_core::pools::Payers;

#[derive(Default)]
struct Chain {
    sent: Mutex<Vec<(Signature, u64)>>,
    statuses: Mutex<HashMap<Signature, Status>>,
}

impl ChainPort for Chain {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        Ok(ClockSysvar::default())
    }
    async fn accounts(&self, keys: &[Address], _: u64) -> PortResult<Vec<Option<Account>>> {
        Ok(keys
            .iter()
            .map(|_| Some(Account { lamports: 10_000_000_000, data: vec![], owner: fclient::addr::system_program(), executable: false }))
            .collect())
    }
    async fn simulate(&self, _: &[u8]) -> PortResult<SimResult> {
        Ok(SimResult::default())
    }
    async fn send(&self, w: &[u8]) -> PortResult<Signature> {
        let t = tx::from_wire(w).unwrap();
        let sig = tx::signature(&t);
        self.sent.lock().unwrap().push((sig, tx::fee_lamports(&t.message)));
        Ok(sig)
    }
    async fn statuses(&self, sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        let m = self.statuses.lock().unwrap();
        Ok(sigs.iter().map(|s| m.get(s).cloned()).collect())
    }
    async fn feed(&self, _: Cursor) -> PortResult<Vec<TxRecord>> {
        Ok(vec![])
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((Hash::new_from_array([3; 32]), 150))
    }
}

fn reveal_spec() -> WriteSpec {
    WriteSpec {
        key: "reveal:march".into(),
        kind: "reveal",
        tag: abi::tag::REVEAL,
        class: Class::W,
        bell: Some(3),
        region: Some(4),
        build: Arc::new(|c: &BuildCtx| {
            vec![Instruction {
                program_id: Address::new_from_array([7; 32]),
                accounts: vec![solana_instruction::AccountMeta::new(c.payer, true)],
                data: vec![abi::tag::REVEAL, c.version as u8],
            }]
        }),
        deadline_slot: None,
        not_before_slot: 0,
        fixed_payer: None,
    }
}

#[tokio::test]
async fn v16_t18_3_one_reveal_held_27_slots_sends_versions_and_counts_every_landed_fee() {
    const HOLD: u64 = 27;
    let chain = Chain::default();
    let mut cfg = KeeperConfig::new(Address::new_from_array([1; 32]), 1, Address::new_from_array([2; 32]));
    cfg.delay_floor = 1;
    cfg.reveal_floor = Some(1);
    let mut payers = Payers::new(&[9u8; 32], &cfg).unwrap();
    payers.refresh(&chain, 0).await.unwrap();
    let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
    let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
    assert!(e.ensure(reveal_spec(), 0));
    let mut outcomes = vec![];
    for s in 0..HOLD {
        let r = e.step(&chain, &mut payers, Some(&j), s).await;
        outcomes.extend(r.outcomes);
    }
    let sent: Vec<(Signature, u64)> = chain.sent.lock().unwrap().clone();
    // The chain answers: the newest version lands, every older one fails AlreadyDone (the program's refusal, modelled).
    {
        let mut m = chain.statuses.lock().unwrap();
        for (i, (sig, _)) in sent.iter().enumerate() {
            let last = i + 1 == sent.len();
            m.insert(*sig, Status { slot: HOLD + 1, err: (!last).then(|| "AlreadyDone".to_string()), code: (!last).then_some(abi::err::ALREADY_DONE) });
        }
    }
    for s in HOLD..HOLD + 40 {
        let r = e.step(&chain, &mut payers, Some(&j), s).await;
        outcomes.extend(r.outcomes);
    }
    let landed: Vec<&Outcome> = outcomes.iter().map(|(_, o)| o).filter(|o| matches!(o, Outcome::Landed { .. })).collect();
    let paid_on_chain: u64 = sent.iter().map(|(_, f)| f).sum();
    let winner_fee = sent.last().map(|(_, f)| *f).unwrap_or(0);
    let counted = e.stats.get("reveal").map_or(0, |s| s.fees_charged);
    println!(
        "versions sent {} over {HOLD} slots; write outcomes Landed ×{}; fees: on chain {paid_on_chain} lamports (winner {winner_fee}, extra {}); counted by the keeper {counted}; per_write_cap {}",
        sent.len(),
        landed.len(),
        paid_on_chain - winner_fee,
        EngineParams::default().per_write_cap
    );
    // 1. no second effect from the engine's side: the write ends once
    assert_eq!(landed.len(), 1, "the write must end once");
    // 2. the extra fees are bounded by the per-write cap (§8.2)
    assert!(paid_on_chain <= EngineParams::default().per_write_cap, "the versions' fees stay under per_write_cap");
    // 3. the fee bookkeeping: every version that landed paid; the keeper's count must say so
    assert_eq!(
        counted, paid_on_chain,
        "the keeper counts {counted} lamports for this Reveal but the chain charged {paid_on_chain} ({} versions landed)",
        sent.len()
    );
}
