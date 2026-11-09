//! Gated initial-Free-City settlement and terminal cleanup.
//! Account authentication, arithmetic and receipts precede all live effects.
use super::*;
use crate::layout::{chain_of, citizen2 as C, holding2 as H, set_chain};
use frontier_abi::conquest_model::Record;
use frontier_abi::v2::layout::province::conquest as CR;
use frontier_abi::world_index::conquest::{
    self as wc, CaptureBinding, WideCaptureEscrow, WideConquest,
};
use frontier_abi::world_index::event::conquest as receipt;

#[derive(Clone)]
struct State {
    owner: [u8; 32],
    lamports: u64,
    data: Vec<u8>,
    present: bool,
    chained: bool,
}

/// One snapshot per wire role; mutations propagate to every alias. All roles
/// remain in the receipt manifest, including read-only and absent positions.
struct Stage {
    keys: Vec<[u8; 32]>,
    before: Vec<State>,
    after: Vec<State>,
}
impl Stage {
    fn source_event(
        &mut self,
        ctx: &AddrCtx,
        source: WideHostRef,
        bell: u32,
        receipt: &receipt::Receipt,
        i: usize,
    ) -> R<conquest_exec::SourceEvent> {
        let mut data = self.after[i].data.clone();
        let event = conquest_exec::prepare_source(
            ctx,
            source,
            self.keys[i],
            bell,
            &receipt.encode(),
            &mut data,
            false,
        )?;
        self.bytes(i, data);
        Ok(event)
    }
    fn new(a: &[AccountInfo]) -> R<Self> {
        let mut before = Vec::new();
        let mut keys = Vec::new();
        for ai in a {
            keys.push(key(ai));
            before.push(State {
                owner: ai.owner.to_bytes(),
                lamports: **ai.try_borrow_lamports()?,
                data: ai.try_borrow_data()?.to_vec(),
                present: !init::is_absent(ai),
                chained: false,
            });
        }
        Ok(Self {
            keys,
            after: before.clone(),
            before,
        })
    }
    fn replace(&mut self, i: usize, state: State) {
        for j in 0..self.keys.len() {
            if self.keys[j] == self.keys[i] {
                self.after[j] = state.clone();
            }
        }
    }
    fn bytes(&mut self, i: usize, data: Vec<u8>) {
        let mut state = self.after[i].clone();
        state.data = data;
        self.replace(i, state);
    }
    fn chain(&mut self, i: usize) {
        for j in 0..self.keys.len() {
            if self.keys[j] == self.keys[i] {
                self.before[j].chained = true;
                self.after[j].chained = true;
            }
        }
    }
    fn transfer(&mut self, from: usize, to: usize, n: u64) -> R<()> {
        // A stored recipient must never alias the account being drained.
        if self.keys[from] == self.keys[to] {
            return Err(BAD_ACCOUNT);
        }
        let mut f = self.after[from].clone();
        let mut t = self.after[to].clone();
        f.lamports = f
            .lamports
            .checked_sub(n)
            .ok_or(FrontierError::Insufficient)?;
        t.lamports = t.lamports.checked_add(n).ok_or(OVERFLOW)?;
        self.replace(from, f);
        self.replace(to, t);
        Ok(())
    }
    fn close(&mut self, i: usize) {
        let mut state = self.after[i].clone();
        state.owner = prologue::ids::SYSTEM_PROGRAM;
        state.present = false;
        state.data.clear();
        self.replace(i, state);
    }
    fn receipt(
        &self,
        a: &[AccountInfo],
        command: wix::WideCommand,
        now: i64,
        bell: u32,
        action: u8,
        outcomes: &[u8],
    ) -> R<receipt::Receipt> {
        let command_bytes = match command {
            wix::WideCommand::SettleSiege(x) => x.to_bytes().to_vec(),
            wix::WideCommand::SettleCapture(x) => x.to_bytes().to_vec(),
            wix::WideCommand::CloseConquest(x) => x.to_bytes().to_vec(),
            wix::WideCommand::CloseCaptureEscrow(x) => x.to_bytes().to_vec(),
            _ => return Err(BAD_ACCOUNT),
        };
        let context = receipt::Context {
            command: &command_bytes,
            now_ts: now,
            bell,
            season: &self.before[1].data,
            evidence: &[],
        };
        fn snapshots<'a>(
            a: &[AccountInfo],
            states: &'a [State],
        ) -> Vec<receipt::AccountSnapshot<'a>> {
            states
                .iter()
                .enumerate()
                .map(|(i, s)| receipt::AccountSnapshot {
                    role: (i + 1) as u16,
                    address: key(&a[i]),
                    owner: s.owner,
                    present: s.present,
                    lamports: s.lamports,
                    data: &s.data,
                    chained: s.chained,
                })
                .collect()
        }
        let input = receipt::input_digest(&context, &snapshots(a, &self.before))
            .map_err(|_| BAD_ACCOUNT)?;
        let output = receipt::output_digest(&context, &snapshots(a, &self.after), outcomes)
            .map_err(|_| BAD_ACCOUNT)?;
        receipt::Receipt::new(action, 0, input, output).map_err(|_| BAD_ACCOUNT)
    }
    fn event(
        &mut self,
        kind: WideKind,
        bell: u32,
        event_key: &[u8],
        r: &receipt::Receipt,
        targets: &[usize],
    ) -> R<Vec<u8>> {
        let mut body = [0u8; wev::MAX_BODY];
        let n =
            wev::write_body(kind, bell, event_key, &r.encode(), &mut body).ok_or(BAD_ACCOUNT)?;
        if targets.len() != kind.links().len() {
            return Err(BAD_ACCOUNT);
        }
        let mut links = Vec::new();
        for (i, entity) in targets.iter().zip(kind.links()) {
            let mut data = self.after[*i].data.clone();
            let (seq, head) = chain_of(&data)?;
            let link = wev::advance(*entity, seq, &head, &body[..n]).ok_or(OVERFLOW)?;
            set_chain(&mut data, link.seq, &link.head)?;
            self.bytes(*i, data);
            links.push(link);
        }
        let m = wev::write_tail(kind, &links, &mut body, n).ok_or(BAD_ACCOUNT)?;
        Ok(body[..m].to_vec())
    }
    /// Probe every changing account together, including lamports, before CPI
    /// or resize. Aliases use one borrow. The commit repeats these exact probes
    /// without any intervening untrusted code except the system allocation.
    fn probe(&self, a: &[AccountInfo], creation: Option<usize>) -> R<()> {
        let mut data = Vec::new();
        let mut lamports = Vec::new();
        for i in 0..a.len() {
            if self.keys[..i].contains(&self.keys[i]) {
                continue;
            }
            let changed = self.before[i].data != self.after[i].data
                || self.before[i].owner != self.after[i].owner;
            if changed || self.before[i].lamports != self.after[i].lamports {
                if !a[i].is_writable {
                    return Err(BAD_ACCOUNT);
                }
            }
            if changed {
                if Some(i) != creation
                    && !self.after[i].data.is_empty()
                    && a[i].data_len() != self.after[i].data.len()
                {
                    return Err(BAD_ACCOUNT);
                }
                data.push(a[i].try_borrow_mut_data()?);
            }
            if self.before[i].lamports != self.after[i].lamports {
                lamports.push(a[i].try_borrow_mut_lamports()?);
            }
        }
        Ok(())
    }
    fn commit(self, a: &[AccountInfo]) -> R<()> {
        self.probe(a, None)?;
        // Shrinking is checked by the probe, requires no allocation, and
        // cannot fail after the successful mutable-data borrow on this thread.
        for i in 0..a.len() {
            if self.keys[..i].contains(&self.keys[i]) {
                continue;
            }
            if self.before[i].present && !self.after[i].present {
                a[i].resize(0)?;
                a[i].assign(&Pubkey::new_from_array(self.after[i].owner));
            }
        }
        let mut data = Vec::new();
        let mut lamports = Vec::new();
        for i in 0..a.len() {
            if self.keys[..i].contains(&self.keys[i]) {
                continue;
            }
            if self.before[i].data != self.after[i].data && !self.after[i].data.is_empty() {
                let d = a[i].try_borrow_mut_data()?;
                if d.len() != self.after[i].data.len() {
                    return Err(BAD_ACCOUNT);
                }
                data.push((i, d));
            }
            if self.before[i].lamports != self.after[i].lamports {
                lamports.push((i, a[i].try_borrow_mut_lamports()?));
            }
        }
        for (i, mut d) in data {
            d.copy_from_slice(&self.after[i].data);
        }
        for (i, mut l) in lamports {
            **l = self.after[i].lamports;
        }
        Ok(())
    }
}

fn log(body: &[u8]) {
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, body]);
}
fn model<T>(x: Result<T, wc::ConquestError>) -> R<T> {
    x.map_err(|e| match e {
        wc::ConquestError::TooEarly => FrontierError::TooEarly.into(),
        _ => BAD_ACCOUNT,
    })
}
fn citizen(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<(u8, u8)> {
    prologue::present_v2(ai, p, frontier_abi::v2::layout::AccountKind::Citizen, sid)?;
    let d = ai.try_borrow_data()?;
    if d.len() != C::SIZE {
        return Err(BAD_ACCOUNT);
    }
    super::super::resident::expect_citizen_address(ctx, ai, &d)?;
    if Ro(&d).u64(C::CITIZEN_TAG)? != frontier_abi::addr::citizen_tag(&key(ai)) {
        return Err(BAD_ACCOUNT);
    }
    Ok((Ro(&d).u8(C::FACTION)?, Ro(&d).u8(C::JOIN_SHARD)?))
}
fn table(p: &Pubkey, ctx: &AddrCtx, sid: u64, k: ProvinceKey, ai: &AccountInfo) -> R<WideConquest> {
    expect_key(ai, &wc::conquest_address(ctx, k))?;
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    model(WideConquest::read(&ai.try_borrow_data()?, sid, k))
}
fn escrow(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    world: WorldId,
    c: &AccountInfo,
    ai: &AccountInfo,
) -> R<WideCaptureEscrow> {
    expect_key(ai, &wc::capture_escrow_address(ctx, &key(c)))?;
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let e = model(WideCaptureEscrow::read(
        &ai.try_borrow_data()?,
        sid,
        world,
        key(c),
    ))?;
    if ai.lamports()
        < init::rent(wc::CAPTURE_ESCROW_SIZE)?
            .checked_add(e.escrow())
            .ok_or(OVERFLOW)?
    {
        return Err(FrontierError::Insufficient.into());
    }
    Ok(e)
}
fn binding(k: ProvinceKey, site: u8, e: wc::WideConquestEntry) -> CaptureBinding {
    CaptureBinding {
        key: k,
        site,
        gen: e.original_target_gen,
        declaration_bell: e.declaration_bell,
    }
}
/// Authenticate the full original generation. A canonical absent or stale
/// source burns the stake; malformed, wrong-owner or wrong-address never does.
fn credit(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    a: &[AccountInfo],
    stage: &mut Stage,
    i: usize,
    source: WideHostRef,
    now: i64,
    gold: u32,
) -> R<(u64, u64, bool)> {
    let milli = (gold as i64).checked_mul(MILLI).ok_or(OVERFLOW)?;
    let Some(h) = conquest_exec::source_at(&a[i], p, ctx, sid, source)? else {
        return Ok((0, milli as u64, false));
    };
    let mut d = stage.after[i].data.clone();
    if h.gen != source.gen()
        || !matches!(Ro(&d).u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
    {
        return Ok((0, milli as u64, false));
    }
    let mut economic = hold::read_holding(&d)?;
    hold::settle_tiered(&mut economic, now, hold::terrain_ore(&d)?)?;
    let (added, burned) = super::super::conquest::credit_capped(&mut economic, milli);
    hold::write_holding(&mut d, &economic, now)?;
    stage.bytes(i, d);
    stage.chain(i);
    Ok((added as u64, burned as u64, true))
}

pub(super) fn settle_siege(p: &Pubkey, a: &[AccountInfo], x: &wix::SettleSiege) -> R<()> {
    require_conquest_lifecycle()?;
    settle_siege_inner(p, a, x)
}

fn settle_siege_inner(p: &Pubkey, a: &[AccountInfo], x: &wix::SettleSiege) -> R<()> {
    check_accounts(Shape(wix::WideCommand::SettleSiege(*x).accounts()), a, None)?;
    if a.len() != 7 && a.len() != 8 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let now = prologue::now()?;
    let hdr = prologue::season(
        &a[1],
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now.ts,
    )?;
    require_wide_season(&a[1])?;
    let ctx = addr::ctx(&key(&a[1]), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = province_at(&a[2], p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(&a[2], &wl::province_address(&ctx, prov.coord))?;
    let k = ProvinceKey::new(world, prov.coord);
    let t = table(p, &ctx, hdr.id, k, &a[3])?;
    citizen(p, &ctx, hdr.id, &a[4])?;
    let e = escrow(p, &ctx, hdr.id, world, &a[4], &a[5])?;
    let mut stage = Stage::new(a)?;
    super::conquest_exec::paired(&t, &stage.before[2].data)?;
    let entry = model(t.entry(x.site))?.ok_or(FrontierError::AlreadyDone)?;
    if !matches!(entry.rules.kind, CR::KIND_NONE | CR::KIND_SIEGE) {
        return Err(BAD_ACCOUNT);
    }
    let target = Ro(&stage.before[2].data);
    if x.site >= target.u8(PV::SITE_COUNT)? || x.site as usize >= PV::SITES_N {
        return Err(BAD_ACCOUNT);
    }
    if entry.rules.kind == CR::KIND_SIEGE {
        // A still-active initial-Free-City siege must agree with the same
        // uncaptured mirror required by Resolve. A contradictory captured
        // target must not be converted into a lapse and source-gold refund.
        let off = PV::site(x.site as usize);
        if entry.original_target_gen != 0
            || target.u8(off + SM::STATE)? != SM2::STATE_FREE_CITY
            || target.u8(off + SM::GEN)? != 0
            || target.u8(off + SM::ORDER)? != 0
            || target.u8(off + SM::FACTION)? != NEUTRAL
        {
            return Err(BAD_ACCOUNT);
        }
    }
    // KIND_NONE only owes this authenticated Citizen's slot and isolated
    // rent. Like legacy SettleSiege, releasing that failed obligation does
    // not depend on the current site's ownership, generation or Holding.
    if a.len() != 7 + usize::from(entry.source.is_some()) {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let prefix = Record::read(&stage.before[2].data, x.site as usize).map_err(|_| BAD_ACCOUNT)?;
    model(e.validate_paired(&t, x.site, prefix, key(&a[4]), &stage.before[4].data))?;
    expect_key(&a[6], &e.funder())?;
    let cq = season_cq(&stage.before[1].data)?;
    let bell = hdr.bell(now.ts).unwrap_or(frontier_abi::log::NO_BELL);
    let ended =
        hdr.status == S::STATUS_ENDED || hdr.bell(now.ts).map_or(false, |b| b >= hdr.end_bell);
    let plan = model(t.settle(
        x.site,
        prefix,
        entry,
        Ro(&stage.before[2].data).u32(PV::RESOLVED_NEXT)?,
        ended,
        hdr.end_bell,
        cq.immunity_bells,
    ))?;
    let (next, refund) = model(e.refund(
        entry.reserved_slot,
        binding(k, x.site, entry),
        init::rent(wh::wide_holding::SIZE)?,
    ))?;
    let mut pd = stage.after[2].data.clone();
    plan.prefix
        .write(&mut pd, x.site as usize)
        .map_err(|_| BAD_ACCOUNT)?;
    stage.bytes(2, pd);
    stage.bytes(3, plan.conquest.to_bytes().to_vec());
    let mut cd = stage.after[4].data.clone();
    model(wc::clear(&mut cd, entry.reserved_slot))?;
    stage.bytes(4, cd);
    stage.bytes(5, next.to_bytes().to_vec());
    stage.transfer(5, 6, refund)?;
    let (added, burned, paid) = if let Some(source) = plan.return_stake_to {
        credit(
            p,
            &ctx,
            hdr.id,
            a,
            &mut stage,
            7,
            source,
            now.ts,
            cq.siege_stake_gold,
        )?
    } else {
        (0, 0, false)
    };
    stage.chain(2);
    let mut outcome = Vec::new();
    for n in [refund, added, burned] {
        outcome.extend_from_slice(&n.to_le_bytes());
    }
    let action = if entry.rules.kind == CR::KIND_NONE {
        receipt::FAILED
    } else {
        receipt::LAPSE
    };
    let r = stage.receipt(
        a,
        wix::WideCommand::SettleSiege(*x),
        now.ts,
        bell,
        action,
        &outcome,
    )?;
    let body = stage.event(WideKind::ConquestSettled, bell, &k.to_bytes(), &r, &[2])?;
    let source_body = if paid {
        Some(stage.source_event(&ctx, entry.source.ok_or(BAD_ACCOUNT)?, bell, &r, 7)?)
    } else {
        None
    };
    stage.probe(a, None)?;
    stage.commit(a)?;
    log(&body);
    if let Some(body) = source_body {
        body.log();
    }
    Ok(())
}

pub(super) fn settle_capture(p: &Pubkey, a: &[AccountInfo], x: &wix::SettleCapture) -> R<()> {
    require_conquest_lifecycle()?;
    settle_capture_inner(p, a, x)
}

fn settle_capture_inner(p: &Pubkey, a: &[AccountInfo], x: &wix::SettleCapture) -> R<()> {
    check_accounts(
        Shape(wix::WideCommand::SettleCapture(*x).accounts()),
        a,
        None,
    )?;
    let [_, season, province, conquest, captor, shard, capture_escrow, destination, source, _system] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::season(
        season,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now.ts,
    )?;
    require_wide_season(season)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(province, &wl::province_address(&ctx, prov.coord))?;
    let k = ProvinceKey::new(world, prov.coord);
    let t = table(p, &ctx, hdr.id, k, conquest)?;
    let (faction, shard_id) = citizen(p, &ctx, hdr.id, captor)?;
    expect_key(shard, &ctx.join_shard(faction, shard_id))?;
    prologue::present_v2(
        shard,
        p,
        frontier_abi::v2::layout::AccountKind::JoinShard,
        hdr.id,
    )?;
    let e = escrow(p, &ctx, hdr.id, world, captor, capture_escrow)?;
    let mut stage = Stage::new(a)?;
    if Ro(&stage.before[5].data).u8(crate::layout::join_shard::FACTION)? != faction
        || Ro(&stage.before[5].data).u8(crate::layout::join_shard::SHARD)? != shard_id
    {
        return Err(BAD_ACCOUNT);
    }
    super::conquest_exec::paired(&t, &stage.before[2].data)?;
    let entry = model(t.entry(x.site))?.ok_or(FrontierError::AlreadyDone)?;
    if entry.rules.kind != CR::KIND_CAPTURE_DUE
        || CR::target_kind(entry.rules.target) != CR::TARGET_FREE_CITY
        || entry.original_target_gen != 0
    {
        return Err(BAD_ACCOUNT);
    }
    let prefix = Record::read(&stage.before[2].data, x.site as usize).map_err(|_| BAD_ACCOUNT)?;
    model(e.validate_paired(&t, x.site, prefix, key(captor), &stage.before[4].data))?;
    let rd = Ro(&stage.before[2].data);
    if x.site >= rd.u8(PV::SITE_COUNT)? || x.site as usize >= PV::SITES_N {
        return Err(BAD_ACCOUNT);
    }
    let off = PV::site(x.site as usize);
    let generation = entry.original_target_gen.checked_add(1).ok_or(OVERFLOW)?;
    if rd.u8(off + SM::STATE)? != SM::STATE_HOLDING
        || rd.u8(off + SM::GEN)? != generation
        || rd.u8(off + SM::FACTION)? != faction
        || faction != entry.rules.faction
        || rd.u8(off + SM::ORDER)? != entry.reserved_slot
    {
        return Err(BAD_ACCOUNT);
    }
    expect_key(destination, &wh::holding_address(&ctx, prov.coord, x.site))?;
    if !init::is_absent(destination) {
        return Err(BAD_ACCOUNT);
    }
    // Distinct account types must not alias even when their initial bytes are
    // absent. In particular creating the destination cannot overwrite source.
    for i in [1usize, 2, 3, 4, 5, 6, 8] {
        if a[i].key == destination.key {
            return Err(BAD_ACCOUNT);
        }
    }
    let source_ref = entry.source.ok_or(BAD_ACCOUNT)?;
    let resolver = frontier_abi::world_index::expedition::AccountResolver::for_season(&ctx)
        .map_err(|_| BAD_ACCOUNT)?;
    expect_key(
        source,
        &resolver
            .holding_address(&source_ref)
            .map_err(|_| BAD_ACCOUNT)?,
    )?;
    let cq = season_cq(&stage.before[1].data)?;
    let bell = hdr.bell(now.ts).unwrap_or(frontier_abi::log::NO_BELL);
    let plan = model(t.settle(
        x.site,
        prefix,
        entry,
        rd.u32(PV::RESOLVED_NEXT)?,
        hdr.status == S::STATUS_ENDED,
        hdr.end_bell,
        cq.immunity_bells,
    ))?;
    let rent = init::rent(wh::wide_holding::SIZE)?;
    let (next_escrow, moved) = model(e.capture(
        entry.reserved_slot,
        binding(k, x.site, entry),
        rent,
        destination.lamports(),
    ))?;
    let terrain = rd.arr::<61>(PV::TERRAIN)?;
    let resource = rd.arr::<61>(PV::RESOURCE)?;
    let holding_out = WideHolding::captured_free_city(
        wh::CapturedFreeCity {
            world,
            season_id: hdr.id,
            coord: prov.coord,
            site: x.site,
            gen: generation,
            slot: entry.reserved_slot,
            owner_citizen: key(captor),
            tile: rd.u8(PV::SITES + x.site as usize)?,
            tier: rd.u8(off + SM::TIER)?,
            captured_bell: entry.rules.bell,
            current_bell: hdr.bell(now.ts),
            now: now.ts,
            rent_payer: e.funder(),
        },
        &stage.before[4].data,
        &terrain,
        &resource,
    )
    .map_err(holding_err)?;
    let mut pd = stage.after[2].data.clone();
    plan.prefix
        .write(&mut pd, x.site as usize)
        .map_err(|_| BAD_ACCOUNT)?;
    stage.bytes(2, pd);
    stage.bytes(3, plan.conquest.to_bytes().to_vec());
    let mut cd = stage.after[4].data.clone();
    model(wc::clear(&mut cd, entry.reserved_slot))?;
    wh::bind(&mut cd, entry.reserved_slot).map_err(holding_err)?;
    stage.bytes(4, cd);
    let mut js = stage.after[5].data.clone();
    for off in [JS2::EXTRA_HOLDINGS, JS2::CAPTURED_IN] {
        let count = Ro(&js).u32(off)?.checked_add(1).ok_or(OVERFLOW)?;
        Rw(&mut js).set_u32(off, count)?;
    }
    stage.bytes(5, js);
    stage.bytes(6, next_escrow.to_bytes().to_vec());
    stage.transfer(6, 7, moved)?;
    let mut hs = stage.after[7].clone();
    hs.owner = p.to_bytes();
    hs.present = true;
    hs.data = holding_out.to_vec();
    stage.replace(7, hs);
    let (added, burned, paid) = credit(
        p,
        &ctx,
        hdr.id,
        a,
        &mut stage,
        8,
        source_ref,
        now.ts,
        cq.siege_stake_gold,
    )?;
    stage.chain(2);
    stage.chain(7);
    let mut outcome = Vec::new();
    for n in [moved, added, burned] {
        outcome.extend_from_slice(&n.to_le_bytes());
    }
    let r = stage.receipt(
        a,
        wix::WideCommand::SettleCapture(*x),
        now.ts,
        bell,
        receipt::CAPTURE,
        &outcome,
    )?;
    let target_ref = WideHostRef::new(k, x.site, generation, 0).map_err(|_| BAD_ACCOUNT)?;
    let target_body = stage.event(
        WideKind::ConquestCaptured,
        bell,
        &target_ref.to_bytes(),
        &r,
        &[2, 7],
    )?;
    let source_body = if paid {
        Some(stage.source_event(&ctx, source_ref, bell, &r, 8)?)
    } else {
        None
    };
    stage.probe(a, Some(7))?;
    // All deterministic failures, borrowing, balances, constructor validation
    // and receipt-chain overflow were checked before the allocation CPI.
    init::init_funded(
        capture_escrow,
        destination,
        season,
        &SeasonSigner::new(hdr.id, hdr.bump),
        &wh::holding_seed(prov.coord, x.site),
        wh::wide_holding::SIZE,
        p,
        0,
    )?;
    stage.commit(a)?;
    log(&target_body);
    if let Some(body) = source_body {
        body.log();
    }
    Ok(())
}

pub(super) fn close_conquest(p: &Pubkey, a: &[AccountInfo], x: &wix::CloseConquest) -> R<()> {
    require_conquest_lifecycle()?;
    close_conquest_inner(p, a, x)
}
fn close_conquest_inner(p: &Pubkey, a: &[AccountInfo], x: &wix::CloseConquest) -> R<()> {
    check_accounts(
        Shape(wix::WideCommand::CloseConquest(*x).accounts()),
        a,
        None,
    )?;
    let [_, season, conquest, rent_payer] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let (sid, bell, _) = season_end(season, p, now.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let world = world_of(&ctx)?;
    let coord = WideCoord::checked(x.p, x.q).map_err(|_| BAD_ACCOUNT)?;
    let k = ProvinceKey::new(world, coord);
    let t = table(p, &ctx, sid, k, conquest)?;
    expect_key(rent_payer, &t.rent_payer())?;
    let mut stage = Stage::new(a)?;
    let balance = stage.before[2].lamports;
    stage.transfer(2, 3, balance)?;
    stage.close(2);
    let r = stage.receipt(
        a,
        wix::WideCommand::CloseConquest(*x),
        now.ts,
        bell,
        receipt::TABLE_CLOSE,
        &balance.to_le_bytes(),
    )?;
    let body = stage.event(WideKind::ConquestTableClosed, bell, &k.to_bytes(), &r, &[])?;
    stage.probe(a, None)?;
    stage.commit(a)?;
    log(&body);
    Ok(())
}

pub(super) fn close_capture_escrow(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    require_conquest_lifecycle()?;
    close_capture_escrow_inner(p, a)
}
fn close_capture_escrow_inner(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    check_accounts(
        Shape(wix::WideCommand::CloseCaptureEscrow(wix::CloseCaptureEscrow).accounts()),
        a,
        None,
    )?;
    if a.len() != 5 && a.len() != 6 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let now = prologue::now()?;
    let (sid, bell, _) = season_end(&a[1], p, now.ts)?;
    let ctx = addr::ctx(&key(&a[1]), &p.to_bytes());
    let world = world_of(&ctx)?;
    let e = escrow(p, &ctx, sid, world, &a[2], &a[3])?;
    expect_key(&a[4], &e.rent_payer())?;
    if a.len() != 5 + usize::from(e.escrow() != 0) {
        return Err(FrontierError::TooManyAccounts.into());
    }
    if e.escrow() != 0 {
        expect_key(&a[5], &e.funder())?;
    }
    let mut stage = Stage::new(a)?;
    if init::is_absent(&a[2]) {
        if e.active_mask() != 0 {
            return Err(BAD_ACCOUNT);
        }
    } else {
        citizen(p, &ctx, sid, &a[2])?;
        let next = model(e.terminal_citizen_plan(sid, world, key(&a[2]), &stage.before[2].data))?;
        stage.bytes(2, next.to_vec());
    }
    let plan = model(e.close_refund_plan(stage.before[3].lamports))?;
    // Stage propagates the first credit to every alias before the second:
    // funder == rent payer receives one checked aggregate balance.
    if plan.refund != 0 {
        stage.transfer(3, 5, plan.refund)?;
    }
    stage.transfer(3, 4, plan.remainder)?;
    stage.close(3);
    let mut outcome = Vec::new();
    outcome.push(plan.active_slots);
    outcome.extend_from_slice(&plan.refund.to_le_bytes());
    outcome.extend_from_slice(&plan.remainder.to_le_bytes());
    let r = stage.receipt(
        a,
        wix::WideCommand::CloseCaptureEscrow(wix::CloseCaptureEscrow),
        now.ts,
        bell,
        receipt::ESCROW_CLOSE,
        &outcome,
    )?;
    let body = receipt::SidecarClose {
        season: key(&a[1]),
        citizen: key(&a[2]),
        bell,
        receipt: r,
    }
    .encode()
    .map_err(|_| BAD_ACCOUNT)?;
    stage.probe(a, None)?;
    stage.commit(a)?;
    solana_program::log::sol_log_data(&[receipt::SIDECAR_LOG_PREFIX, &body]);
    Ok(())
}

#[cfg(test)]
#[path = "wide_conquest_settle_tests.rs"]
mod tests;

// Isolated native integration only; no production dispatch or authorization override.
#[cfg(all(
    test,
    feature = "runtime-contract-tests",
    feature = "public-proof-tests",
    feature = "system-cpi-tests",
    not(target_os = "solana")
))]
pub(super) fn runtime_capture(p: &Pubkey, a: &[AccountInfo], x: &wix::SettleCapture) -> R<()> {
    settle_capture_inner(p, a, x)
}
