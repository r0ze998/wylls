// ⑨ CAPACITY and ⑩ CUSTODY on the village screen — a TEST-ONLY PREVIEW, a COEXIST local world only (the controller sets
// `FS.custody.on` only there; every other world draws nothing of this). Owner rules 2026-11-21 (plan-6-9-10-12-16 §2–3):
//
//   預ける (⑩)    a storehouse's keeper opens a lot for another player's ORE; that player sends ore there by its own
//                 caravan and takes it back by caravan. On the road the goods are the carrier's: a caravan beaten there
//                 loses them. If the storehouse is seized, the lot goes to the captor — the depositor's troops never
//                 defend it.
//   工房を貸す (⑨) a workshop village's owner lends copies and lets another player use them; that player books a job,
//                 its own storehouse in the village's Province feeds ore and wood in, and the arms come back there (they
//                 leave only by caravan, as in ②). If the village falls, the captor takes everything the jobs hold.
//
// FOG RULE: only what the viewer is a party to — its own lots, the lots in its own storehouses, its own pools, the jobs
// it booked — and the other side by its nation only. Losses are told from the viewer's side, in few words.
// The model is pure; the program checks every rule again.
import { html, raw } from '../../util.mjs';
import { L, fmtNum, lang } from '../../lang.mjs';
import { placeName } from '../people/identity.mjs';
import { icon } from '../hud/icons.mjs';
import { factionName } from '../fi18n.mjs';
import { cardHead, chip, fold, label } from './parts.mjs';
import { settledFor } from './rights.mjs';
import { FIN, LOT_OPEN, LOT_FORFEITED, CV_MOVING, CV_LOST, CV_CUSTODY_TAKEN, MILLI, ORE_PER_ARM, WOOD_PER_ARM, MAX_JOBS, MAX_GRANTS, jobOutAt, nextGrantSeq, nextJobSeq, tagOf } from '../flocalplay-custody.mjs';

const whole = m => Math.floor(Number(m) / MILLI);
/** A workshop village by the name the map gives it (its place), never by its site number, which no screen shows. */
const siteName = f => placeName(f.p, f.q, f.site)[lang() === 'en' ? 'en' : 'ja'];
const same = (a, b) => a.p === b.p && a.q === b.q;

/** The card's model (pure): `{on, read, losses, myLots, keptLots, openChoices, arrivals, pools, lendable, grants, jobs}`. */
export function custodyModel(FS, nowTs = FS.chain?.now?.() ?? 0) {
  const c = FS.custody;
  if (!c?.on || !c.viewer) return { on: false };
  const viewer = c.viewer, myTag = c.myTag;
  const holdings = c.holdings ?? [], vaults = c.vaults ?? [];
  const nationOf = citizen => holdings.find(h => h.ownerCitizen === citizen)?.faction ?? vaults.find(v => v.ownerCitizen === citizen)?.faction ?? null;
  // (a lot of a generation before — its storehouse was seized since — names no keeper: the lot's custodian tag does)
  const nationOfTag = tag => holdings.find(h => typeof h.ownerCitizen === 'string' && tagOf(h.ownerCitizen) === String(tag))?.faction ?? null;
  const vaultNow = e => vaults.find(x => same(x, e.vault) && x.tile === e.vault.tile) ?? null;
  // (workshops the village still runs itself: the program lends at most `workshops − lent` more, holding.rs lend_workshops)
  const freeOf = h => (h ? Math.max(0, h.workshops - (h.lent ?? 0)) : 0);
  const losses = [];
  // ---- ⑩ custody
  const lots = [...(c.lots?.values() ?? [])].filter(e => !e.gone);
  const caravans = [...(c.caravans?.values() ?? [])];
  const myLots = lots.filter(e => e.owner === viewer).map(e => {
    const l = e.lot, v = vaultNow(e);
    // (a storehouse not in the view is unknown, never "seized": the herald's list can be late, and a loss is told once)
    const seized = l.state === LOT_OPEN && !!v && (Number(v.gen) !== l.vaultGen || (e.vault.ownerCitizen != null && v.ownerCitizen !== e.vault.ownerCitizen));
    const mine = caravans.filter(cv => same(cv.dst, e.vault) && cv.dst.tile === e.vault.tile);
    const taken = mine.filter(cv => cv.custody === CV_CUSTODY_TAKEN || cv.state === CV_LOST);
    const inbound = l.inbound.filter(x => x.tag === myTag).map(x => {
      const cv = mine.find(y => y.seq === x.seq) ?? null;
      const lost = !!cv && (cv.custody === CV_CUSTODY_TAKEN || cv.state === CV_LOST);
      const arrived = !!cv && cv.state === CV_MOVING && !lost && cv.arriveTs <= nowTs;
      return { seq: x.seq, qty: whole(x.qty), lost, arrived, provinces: cv?.provinces ?? [], arriveTs: cv?.arriveTs ?? null, ...(arrived ? settledFor(FS, cv.provinces, cv.arriveTs) : {}) };
    });
    for (const x of inbound) if (x.lost) losses.push({ key: `road:${x.seq}`, text: () => L`預けに向かった鉱石 ${fmtNum(x.qty)} は道中で奪われました。` });
    // (told once, at the seizure: the same key once the lot is reconciled and forfeit)
    if (l.state === LOT_FORFEITED) losses.push({ key: `lot:${l.p},${l.q},${l.tile},${l.vaultGen}`, text: () => L`預けていた貯蔵庫が奪われ、鉱石 ${fmtNum(whole(l.forfeited))} は奪った側のものになりました。` });
    else if (seized) losses.push({ key: `lot:${l.p},${l.q},${l.tile},${l.vaultGen}`, text: () => L`預けていた貯蔵庫が奪われました。預けた鉱石 ${fmtNum(whole(l.held))} は奪った側のものになります。` });
    const live = l.state === LOT_OPEN && !seized;
    const keeper = (e.vault.ownerCitizen ? e.vault.faction : null) ?? nationOfTag(l.custodianTag) ?? e.vault.faction ?? null;
    return { vault: e.vault, lot: l, keeper, held: whole(l.held), quota: whole(l.quota), forfeited: whole(l.forfeited), state: l.state, seized, inbound,
      reconcile: seized || inbound.some(x => x.lost) ? { caravans: inbound.filter(x => x.lost).map(x => `${myTag}_${x.seq}`) } : null,
      canDeposit: live && !inbound.some(x => x.lost) && l.held + l.inbound.reduce((a, x) => a + x.qty, 0) < l.quota, room: whole(l.quota - l.held - l.inbound.reduce((a, x) => a + x.qty, 0)),
      canWithdraw: live && l.held >= MILLI, canClose: l.inbound.length === 0 && (l.state === LOT_FORFEITED || (live && l.held === 0)), taken: taken.length };
  });
  // (the keeper is the lot's custodian — its tag is in the lot — so a seized storehouse's lots stay on its old keeper's card)
  const keptLots = lots.filter(e => e.owner !== viewer && (l => l.custodianTag === String(myTag))(e.lot)).map(e => {
    const l = e.lot, v = vaultNow(e);
    const seized = l.state === LOT_FORFEITED || (!!v && (Number(v.gen) !== l.vaultGen || v.ownerCitizen !== viewer));
    if (seized) losses.push({ key: `kept:${l.p},${l.q},${l.tile},${l.vaultGen}:${l.ownerTag}`, text: () => L`あなたの貯蔵庫が奪われ、預かっていた鉱石も奪われました。` });
    return { vault: e.vault, depositor: nationOf(e.owner), held: whole(l.held), quota: whole(l.quota), state: l.state, seized };
  });
  const myVaults = vaults.filter(v => v.ownerCitizen === viewer);
  const openChoices = myVaults.flatMap(v => holdings.filter(h => same(h, v) && h.ownerCitizen !== viewer)
    .filter((h, i, a) => a.findIndex(x => x.ownerCitizen === h.ownerCitizen) === i)
    .filter(h => !lots.some(e => e.owner === h.ownerCitizen && same(e.vault, v) && e.vault.tile === v.tile))
    .map(h => ({ vault: v, owner: h.ownerCitizen, faction: h.faction, at: h.tile })));
  // ---- ⑨ capacity
  const pools = [...(c.pools?.values() ?? [])];
  const jobs = [...(c.jobs?.values() ?? [])];
  const facilityNow = f => holdings.find(h => same(h, f) && h.site === f.site) ?? null;
  const jobsOf = (f, pred = () => true) => jobs.filter(e => same(e.facility, f) && e.facility.site === f.site && pred(e.job));
  const owned = pools.filter(e => e.pool.owner === viewer).map(e => {
    const pl = e.pool, f = pl.facility, now = facilityNow(f);
    const gone = pl.lostAt === null && (!now || now.gen !== f.gen || now.ownerCitizen !== pl.owner);
    if (pl.lostAt !== null) losses.push({ key: `pool:${f.p},${f.q},${f.site},${f.gen}`, text: () => L`工房の村を失いました。貸していた工房の作業も止まりました。` });
    const busy = pl.occ.filter(o => o.open && o.endEff > nowTs).reduce((a, o) => a + o.units, 0);
    const users = vaults.filter(v => same(v, f) && v.ownerCitizen !== viewer && typeof v.ownerCitizen === 'string')
      .filter((v, i, a) => a.findIndex(x => x.ownerCitizen === v.ownerCitizen) === i).map(v => ({ user: v.ownerCitizen, faction: v.faction }));
    return { facility: f, pool: pl, lost: pl.lostAt !== null, gone, lent: pl.lent, busy, free: freeOf(now), nextGrant: nextGrantSeq(pl), users,
      canGrant: pl.lostAt === null && !gone && pl.lent > 0 && pl.grants.length < MAX_GRANTS && users.length > 0,
      grants: pl.grants.map(g => ({ seq: g.seq, user: nationOf(g.user), maxUnits: g.maxUnits, until: g.until, revoked: g.revokedAt !== null })),
      jobs: jobsOf(f).map(e => ({ grant: e.job.grant, seq: e.job.seq, units: e.job.units, fin: e.job.fin, made: whole(jobOutAt(e.job, nowTs)) })),
      lossJobs: pl.occ.map(o => `${o.grant}_${o.job}`).join('.') };
  });
  const lendable = holdings.filter(h => h.ownerCitizen === viewer && freeOf(h) > 0 && !pools.some(e => same(e.pool.facility, h) && e.pool.facility.site === h.site && e.pool.facility.gen === h.gen))
    .map(h => ({ facility: { p: h.p, q: h.q, site: h.site, gen: h.gen }, free: freeOf(h) }));
  const grants = pools.filter(e => e.pool.owner !== viewer).flatMap(e => e.pool.grants.filter(g => g.user === viewer).map(g => {
    const pl = e.pool, f = pl.facility, now = facilityNow(f);
    const vault = myVaults.find(v => same(v, f)) ?? null;
    const gone = pl.lostAt === null && (!now || now.gen !== f.gen || now.ownerCitizen !== pl.owner);
    const live = pl.lostAt === null && !gone && g.revokedAt === null && nowTs < g.until && pl.occ.length < MAX_JOBS && g.maxOutput - g.spent - pl.occ.filter(o => o.grant === g.seq).reduce((a, o) => a + o.budget, 0) >= MILLI;
    // (the grant's output budget: what its retired jobs made (`spent`) and what its jobs in the pool hold (`budget`))
    const held = pl.occ.filter(o => o.grant === g.seq).reduce((a, o) => a + o.budget, 0);
    return { facility: f, owner: nationOf(pl.owner), seq: g.seq, maxUnits: g.maxUnits, maxArms: Math.max(0, whole(g.maxOutput - g.spent - held)), until: g.until, revoked: g.revokedAt !== null,
      vault, nextJob: nextJobSeq(g), canReserve: live && vault !== null, gone, lost: pl.lostAt !== null, lossJobs: pl.occ.map(o => `${o.grant}_${o.job}`).join('.') };
  }));
  const myJobs = jobs.filter(e => e.job.user === viewer).map(e => {
    const j = e.job, f = e.facility, made = jobOutAt(j, nowTs);
    const vault = myVaults.find(v => same(v, f)) ?? null;
    if (j.fin === FIN.lost) {
      const taken = whole(j.forfeitedOut) + whole(Math.max(0, j.settled - j.claimed));
      losses.push({ key: `job:${f.p},${f.q},${f.site},${f.gen}:${j.grant}:${j.seq}`, text: () => L`借りていた工房の村が奪われ、預けた鉱石 ${fmtNum(whole(j.forfeitedIn[0]))}・木材 ${fmtNum(whole(j.forfeitedIn[1]))} と兵器 ${fmtNum(taken)} は占領者のものになりました。` });
    }
    const open = j.fin === FIN.open, started = nowTs >= j.start;
    const claimable = j.fin !== FIN.lost && (made > j.claimed || (j.fin !== FIN.open && !j.refunded) || (open && nowTs >= j.end));
    return { facility: f, grant: j.grant, seq: j.seq, units: j.units, fin: j.fin, start: j.start, end: j.end, made: whole(made), target: whole(j.maxOutput), claimed: whole(j.claimed),
      vault, canSettle: open && started, canClaim: claimable && vault !== null, canCancel: open && (nowTs < j.start || nowTs < j.end), lost: j.fin === FIN.lost };
  });
  return { on: true, read: c.read ?? 'unread', losses, myLots, keptLots, openChoices, owned, lendable, grants, myJobs };
}

/** The losses the viewer has to be told of (the controller tells each once; the card keeps saying them). */
export const custodyLosses = FS => (custodyModel(FS).losses ?? []);

const data = d => raw(Object.entries(d).map(([k, v]) => `data-${k}="${String(v).replace(/"/g, '')}"`).join(' '));
const btn = (act, d, text) => html`<button type="button" class="btn small" data-act="${act}" ${data(d)}>${text}</button>`;
const vd = v => ({ p: v.p, q: v.q, tile: v.tile, gen: v.gen });
const fd = f => ({ p: f.p, q: f.q, site: f.site, gen: f.gen });
const finWord = j => (j.lost ? L`奪われた` : j.fin === FIN.cancelled ? L`取り消し` : j.fin === FIN.completed ? L`完了` : L`作業中`);

export function renderCustody(FS) {
  const m = custodyModel(FS);
  if (!m.on) return '';
  const now = FS.chain?.now?.() ?? 0;
  const lossList = m.losses.length ? html`<ul class="list custody-losses" role="status">${m.losses.map(x => html`<li class="blocked" data-loss="${x.key}">${icon('alert')}${x.text()}</li>`)}</ul>` : '';
  // ---- ⑩ your ore in others' storehouses
  const myLots = m.myLots.length ? html`${label(L`預けた鉱石`)}<ul class="list custody-lots">${m.myLots.map(e => {
    const d = { ...vd(e.vault), owner: FS.custody.myTag };
    const st = e.state === LOT_FORFEITED ? chip(L`奪われた`, 'warn') : e.seized ? chip(L`貯蔵庫が奪われた`, 'warn') : chip(L`預け中`, 'ok');
    return html`<li data-lot="${e.vault.p},${e.vault.q},${e.vault.tile}">${icon('ore')}${L`${factionName(e.keeper)} の貯蔵庫（マス ${e.vault.tile}）`} ${st}
      <span class="muted">${L`鉱石 ${fmtNum(e.held)} / 枠 ${fmtNum(e.quota)}`}</span>
      ${e.inbound.map(x => html`<span class="muted custody-inbound" data-seq="${x.seq}">${x.lost ? L`隊商 ${fmtNum(x.qty)}：道中で奪われた` : x.arrived ? (x.settled === false ? L`隊商 ${fmtNum(x.qty)}：着いた（通った州の決着待ち）` : '') : L`隊商 ${fmtNum(x.qty)}：移動中`}
        ${x.arrived && x.settled !== false ? btn('lot-deliver', { ...d, seq: x.seq, path: x.provinces.map(pq => `${pq.p}_${pq.q}`).join('.') }, L`鉱石を届ける`) : ''}</span>`)}
      <span class="actions">${e.canDeposit ? html`<form class="vform inline" data-form="lot-deposit" ${data(vd(e.vault))}><input name="qty" type="number" min="1" max="${e.room}" step="1" value="${Math.min(10, e.room)}" inputmode="numeric" aria-label="${L`預ける鉱石の量`}"><button type="submit" class="btn small">${L`鉱石を預ける`}</button></form>` : ''}
      ${e.canWithdraw ? html`<form class="vform inline" data-form="lot-withdraw" ${data(vd(e.vault))}><input name="qty" type="number" min="1" max="${e.held}" step="1" value="${e.held}" inputmode="numeric" aria-label="${L`引き取る鉱石の量`}"><button type="submit" class="btn small">${L`引き取る`}</button></form>` : ''}
      ${e.reconcile ? btn('lot-reconcile', { ...d, caravans: e.reconcile.caravans.join('.') }, L`帳簿を確かめる`) : ''}
      ${e.canClose ? btn('lot-close', { ...d, rent: e.lot.rentTo }, L`枠を閉じる`) : ''}</span></li>`;
  })}</ul>` : '';
  const kept = m.keptLots.length ? html`${label(L`あなたの貯蔵庫の預かり`)}<ul class="list custody-kept">${m.keptLots.map(e => html`<li>${icon('crate')}${L`${factionName(e.depositor)} の鉱石（マス ${e.vault.tile}）`} ${e.seized ? chip(L`奪われた`, 'warn') : ''}<span class="muted">${L`${fmtNum(e.held)} / 枠 ${fmtNum(e.quota)}`}</span></li>`)}</ul>` : '';
  const openLot = m.openChoices.length ? html`<form class="vform" data-form="lot-open">
    <label class="field">${L`貯蔵庫と預ける人`}<select name="pair">${m.openChoices.map((x, i) => html`<option value="${i}" ${data({ ...vd(x.vault), owner: x.owner })}>${L`マス ${x.vault.tile} → ${factionName(x.faction)} の村（マス ${x.at}）`}</option>`)}</select></label>
    <div class="count-row"><label class="count-label" for="lot-q">${L`鉱石の枠`}</label><input id="lot-q" name="quota" type="number" min="1" max="10000" step="1" value="50" inputmode="numeric"></div>
    <p class="muted">${L`預かるのは鉱石だけ。中身は預けた人のものですが、貯蔵庫を守るのはあなたの兵だけです。奪われたら中身は奪った側のものになります。`}</p>
    <div class="actions"><button type="submit" class="btn primary">${L`預かりの枠を開く`}</button></div></form>`
    : html`<p class="muted">${L`同じ州にあなたの貯蔵庫と、ほかの人の村があると、預かりの枠を開けます。`}</p>`;
  // ---- ⑨ lending your workshops
  const lend = (f, free, open, seq) => html`<form class="vform inline" data-form="cap-lend" ${data({ ...fd(f), open: open ? 1 : 0, seq })}><input name="units" type="number" min="1" max="${Math.max(1, free)}" step="1" value="1" inputmode="numeric" aria-label="${L`貸す工房の数`}"><button type="submit" class="btn small">${L`工房を貸し出す`}</button></form>`;
  const owned = html`${m.lendable.map(x => html`<p data-facility="${x.facility.p},${x.facility.q},${x.facility.site}">${icon('hammer')}${L`村 ${siteName(x.facility)} の工房 ${fmtNum(x.free)}`} ${lend(x.facility, x.free, true, 0)}</p>`)}
    ${m.owned.map(e => html`<div class="custody-pool" data-facility="${e.facility.p},${e.facility.q},${e.facility.site}">${icon('hammer')}${L`村 ${siteName(e.facility)}：貸し出し中 ${fmtNum(e.lent)}（使用中 ${fmtNum(e.busy)}）`} ${e.lost ? chip(L`村を失った`, 'warn') : e.gone ? chip(L`村が奪われた`, 'warn') : ''}
      <span class="actions">${!e.lost && !e.gone && e.free > 0 ? lend(e.facility, e.free, false, e.pool.ownerSeq) : ''}${!e.lost && !e.gone && e.lent - e.busy > 0 ? btn('cap-reclaim', { ...fd(e.facility), units: e.lent - e.busy, seq: e.pool.ownerSeq }, L`空いた工房を戻す`) : ''}
        ${e.gone ? btn('cap-loss', { ...fd(e.facility), jobs: e.lossJobs }, L`村を失ったことを記録する`) : ''}</span>
      ${e.grants.length ? html`<ul class="list">${e.grants.map(g => html`<li>${L`${factionName(g.user)} の人に 工房 ${fmtNum(g.maxUnits)} まで`} ${g.revoked ? chip(L`取り消し済み`, 'warn') : now >= g.until ? chip(L`期限切れ`, 'warn') : chip(L`有効`, 'ok')} ${!g.revoked && !e.lost ? btn('cap-revoke', { ...fd(e.facility), grant: g.seq }, L`取り消す`) : ''}</li>`)}</ul>` : ''}
      ${e.jobs.length ? html`<ul class="list">${e.jobs.map(j => html`<li class="muted">${L`作業 ${j.grant}-${j.seq}：工房 ${fmtNum(j.units)} · 兵器 ${fmtNum(j.made)}`} ${finWord(j)}</li>`)}</ul>` : ''}
      ${e.canGrant ? html`<form class="vform" data-form="cap-grant" ${data({ ...fd(e.facility), grant: e.nextGrant })}>
        <label class="field">${L`使わせる相手（この州に貯蔵庫がある人）`}<select name="user">${e.users.map(u => html`<option ${data({ user: u.user })}>${factionName(u.faction)}</option>`)}</select></label>
        <div class="count-row"><label class="count-label" for="cg-u">${L`工房の数`}</label><input id="cg-u" name="units" type="number" min="1" max="${e.lent}" step="1" value="${e.lent}" inputmode="numeric"></div>
        <div class="count-row"><label class="count-label" for="cg-a">${L`兵器の上限`}</label><input id="cg-a" name="arms" type="number" min="1" max="10000" step="1" value="40" inputmode="numeric"></div>
        <div class="count-row"><label class="count-label" for="cg-d">${L`有効な日数`}</label><input id="cg-d" name="days" type="number" min="1" max="7" step="1" value="1" inputmode="numeric"></div>
        <div class="actions"><button type="submit" class="btn primary">${L`工房を使わせる`}</button></div></form>` : ''}</div>`)}`;
  const ownedNone = !m.lendable.length && !m.owned.length ? html`<p class="muted">${L`工房のある村があると、工房を貸し出せます。`}</p>` : '';
  // ---- ⑨ workshops you may use
  const grants = m.grants.length ? html`${label(L`使える工房`)}<ul class="list custody-grants">${m.grants.map(g => html`<li data-facility="${g.facility.p},${g.facility.q},${g.facility.site}">${icon('hammer')}${L`${factionName(g.owner)} の村 ${siteName(g.facility)} の工房 ${fmtNum(g.maxUnits)} まで（兵器あと ${fmtNum(g.maxArms)}）`} ${g.gone || g.lost ? chip(L`村が奪われた`, 'warn') : g.revoked ? chip(L`取り消された`, 'warn') : ''}
    ${g.gone ? btn('cap-loss', { ...fd(g.facility), jobs: g.lossJobs }, L`村が奪われたことを記録する`) : ''}
    ${g.canReserve ? html`<form class="vform" data-form="cap-reserve" ${data({ ...fd(g.facility), grant: g.seq, job: g.nextJob, vtile: g.vault.tile, vgen: g.vault.gen })}>
      <div class="count-row"><label class="count-label" for="cr-u-${g.seq}">${L`使う工房の数`}</label><input id="cr-u-${g.seq}" name="units" type="number" min="1" max="${g.maxUnits}" step="1" value="${g.maxUnits}" inputmode="numeric"></div>
      <div class="count-row"><label class="count-label" for="cr-a-${g.seq}">${L`作る兵器の数`}</label><input id="cr-a-${g.seq}" name="arms" type="number" min="1" max="${Math.max(1, g.maxArms)}" step="1" value="${Math.min(10, Math.max(1, g.maxArms))}" inputmode="numeric"></div>
      <div class="actions"><button type="submit" class="btn small">${L`予約して材料を入れる`}</button></div></form><span class="muted">${L`兵器 1 につき 鉱石 ${fmtNum(ORE_PER_ARM)}・木材 ${fmtNum(WOOD_PER_ARM)}（あなたの貯蔵庫から）`}</span>`
      : !g.vault && !g.gone && !g.lost ? html`<span class="muted">${L`この州にあなたの貯蔵庫がいります。`}</span>` : ''}</li>`)}</ul>` : '';
  const myJobs = m.myJobs.length ? html`${label(L`あなたの作業`)}<ul class="list custody-jobs">${m.myJobs.map(j => {
    const d = { ...fd(j.facility), grant: j.grant, job: j.seq, ...(j.vault ? { vtile: j.vault.tile, vgen: j.vault.gen } : {}) };
    const when = now < j.start ? L`開始待ち` : finWord(j);
    return html`<li data-job="${j.grant}-${j.seq}">${icon('sword')}${L`兵器 ${fmtNum(j.made)} / ${fmtNum(j.target)}`} ${j.lost ? chip(when, 'warn') : chip(when, j.fin === FIN.open ? '' : 'ok')}${j.claimed ? html` <span class="muted">${L`受け取り済み ${fmtNum(j.claimed)}`}</span>` : ''}
      <span class="actions">${j.canSettle ? btn('cap-settle', d, L`進みを記録`) : ''}${j.canClaim ? btn('cap-claim', d, L`貯蔵庫へ受け取る`) : ''}${j.canCancel ? btn('cap-cancel', d, L`取り消す`) : ''}</span></li>`;
  })}</ul><p class="muted">${L`兵器はあなたの貯蔵庫に入り、隊商でしか運び出せません。工房の村が奪われると、作業の中身は占領者のものになります。`}</p>` : '';
  const readNote = m.read === 'failed' ? html`<p class="blocked">${L`預かりと工房の様子を読めませんでした。`}</p>` : m.read === 'loading' ? html`<p class="muted">${L`読み込んでいます…`}</p>` : '';
  return html`<section class="vcard vcard-folds custody-card" id="hp-custody" aria-labelledby="custody-title" data-custody-read="${m.read}">
    ${cardHead({ id: 'custody-title', ic: 'crate', title: L`預かりと工房貸し（試験）` })}
    ${readNote}${lossList}${myLots}${kept}${grants}${myJobs}
    <div class="actions">${btn('custody-read', {}, L`読み直す`)}</div>
    ${fold('custody-open', html`${icon('crate')}${L`鉱石を預かる`}`, openLot)}
    ${fold('custody-lend', html`${icon('hammer')}${L`工房を貸す`}`, html`${owned}${ownedNone}`)}
    <p class="muted">${L`表示するのは、あなたが当事者の預かりと工房だけです。`}</p></section>`;
}
