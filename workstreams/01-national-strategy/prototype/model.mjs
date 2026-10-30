// 国の卓の試作：ルール本体。画面を持たない純粋なモジュール（ブラウザでも node でも動く）。
//
// 守っていること（workstreams/01-national-strategy/docs/05-rules-draft.ja.md）：
//   1. この試作の範囲では、国による徴収と国の共有資産を作らない。物はいつも一人の持ち主の村・倉・荷車にある。
//      （ゲーム全体の原則ではない。既存の「国の取り分」の決定は、国の卓とは別の未統合事項として残っている）
//   2. 申し出は約束の表明で、命令ではない。発送できるのは持ち主だけ。
//   3. 発送した荷は、着くまで送り主の物。着いたら受け取り側の物（今の S1 の隊商と同じ）。
//   4. 進み具合は「到着済み」だけを数える。送信済み・輸送中は見込みとして別に見せる。
//   5. 目標の成立は、期限のターンに、条件が実際に使える状態でそろっているかで決める。
//      届いた累計ではなく、その時点で倉・村にある量（他の目標と二重に数えない）と、稼働中の建物で見る。
//   6. 軍は自動で出発しない。ターンを進めても、進軍は持ち主が出したものだけが動く。
//   7. 徴収・通貨・報酬はない。
//
// 公開する関数：createWorld, act, advance, inject, needProgress, readiness,
// custody, decisionsFor, perform, pledgeTotals, openGoals, label, EVENTS, inventory。

import {
  RESOURCES, BUILD_COST, BUILD_LIMIT, BUILD_TURNS, FOOD_PER_SPEARMAN, QUORUM, VOTE_WINDOW_TURNS,
  REAL_VOTE_WINDOW_TURNS, ADOPT_COSIGNERS, PROPOSAL_EXPIRES_TURNS, ABSENT_TURNS, SCOUT_FRESH_TURNS,
  PLACES, travelTurns, OUTPOST_GOAL, RIVAL_GOAL, BENEFITS, ARMS_PER_100_PIKEMEN, initialWorld,
  VAULT_CAP, ESCORT_TURNS,
} from './scenario.mjs';

// ------------------------------------------------------------------ 表示の補助

export const label = {
  res: r => RESOURCES[r] ?? r,
  place: p => PLACES[p] ?? p,
  who: (w, id) => (id === 'enemy' ? '北の国の村' : w.members[id]?.name ?? id),
};

function log(w, kind, text, extra = {}) {
  w.log.push({ turn: w.turn, kind, text, ...extra });
}
const nextId = (w, p) => `${p}${w.seq++}`;
const fail = error => ({ ok: false, error });
const ok = (extra = {}) => ({ ok: true, ...extra });

// ------------------------------------------------------------------ 世界

/** 新しい世界。preset: 'start'（提案の直後）／'preparing'（採択済み・申し出がそろった所）。 */
export function createWorld(preset = 'start') {
  const w = initialWorld();
  proposeGoal(w, OUTPOST_GOAL);
  w.goals.outpost.adoptedAt = null;
  if (preset === 'preparing') {
    act(w, 'mira', 'cosign', { goal: 'outpost' });
    act(w, 'sota', 'cosign', { goal: 'outpost' });
    act(w, 'mira', 'pledge', { goal: 'outpost', need: 'stone', qty: 500, cap: 500 });
    act(w, 'mira', 'pledge', { goal: 'outpost', need: 'arms', qty: 50, cap: 50 });
    act(w, 'sota', 'pledge', { goal: 'outpost', need: 'vault' });
    act(w, 'sota', 'pledge', { goal: 'outpost', need: 'food', qty: 400, cap: 400 });
    act(w, 'kei', 'pledge', { goal: 'outpost', need: 'fort' });
    act(w, 'kei', 'pledge', { goal: 'outpost', need: 'garrison', qty: 300, cap: 300 });
    act(w, 'mira', 'dispatch', { pledge: findPledge(w, 'mira', 'outpost', 'stone').id, qty: 500 });
    act(w, 'mira', 'dispatch', { pledge: findPledge(w, 'mira', 'outpost', 'arms').id, qty: 40 });
    act(w, 'sota', 'build', { kind: '倉', at: 'site', pledge: findPledge(w, 'sota', 'outpost', 'vault').id });
    advance(w, 1);
  }
  return w;
}

/** 目標を出す（作例と台本とテストから使う。画面からの自由な提案は試作にない）。 */
export function addGoal(w, tpl, by = tpl.proposer) {
  return proposeGoal(w, tpl, by);
}

function proposeGoal(w, tpl, by = tpl.proposer) {
  const g = {
    id: tpl.id, title: tpl.title, purpose: tpl.purpose, site: tpl.site,
    proposer: by, coordinator: by, cosigners: [by],
    proposedAt: w.turn, deadline: w.turn + tpl.deadlineIn, version: 1,
    status: '提案中', requiresStance: { ...tpl.requiresStance },
    needs: tpl.needs.map(n => ({ ...n, to: n.to ? { ...n.to } : undefined })),
    shrink: tpl.shrink ? { ...tpl.shrink } : null,
    conflict: null, readyAt: null, outcome: null, history: [],
  };
  w.goals[g.id] = g;
  touch(w, by);
  log(w, 'goal', `${label.who(w, by)}が「${g.title}」を提案した（期限：ターン${g.deadline}）`, { goal: g.id });
  return g;
}

function touch(w, id) {
  const m = w.members[id];
  if (m) m.lastActive = w.turn;
}

export const openGoals = w => Object.values(w.goals).filter(g => g.status === '提案中' || g.status === '準備中');

function findPledge(w, provider, goal, need) {
  return Object.values(w.pledges).find(p => p.provider === provider && p.goal === goal && p.need === need && isLive(p));
}
const LIVE = new Set(['申し出', '準備中', '一部発送', '再確認待ち', '供給元を失った']);
const isLive = p => LIVE.has(p.status);
/** 数えてよい申し出（再確認待ちは、本人が続けると決めるまで数えない）。 */
const isCounted = p => isLive(p) && p.status !== '再確認待ち';
/** 整数に直す。数でなければ NaN（呼ぶ側で断る）。 */
const toInt = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? NaN : Math.floor(Number(v)));
const goalIsLive = g => g && (g.status === '提案中' || g.status === '準備中');

const needOf = (w, goalId, needId) => w.goals[goalId]?.needs.find(n => n.id === needId);

/** 拠点などにある、仲間の倉（稼働中）。 */
function vaultsAt(w, at, building = false) {
  return Object.values(w.facilities).filter(f => f.kind === '倉' && f.at === at && (f.status === '稼働' || (building && f.status === '建設中')) && w.members[f.owner]?.inNation);
}
function facilitiesOf(w, owner, kind) {
  return Object.values(w.facilities).filter(f => f.owner === owner && f.kind === kind && f.status !== '奪われた' && f.status !== '壊れた');
}

// ------------------------------------------------------------------ 持ち主・使う人

/**
 * 申し出または荷車について、提供する人・今の持ち主・着いた後の持ち主・使う人を返す。
 * 曖昧さを残さないため、文字列ではなく人の id で返す（表示は画面側）。
 */
export function custody(w, ref) {
  const s = w.shipments[ref];
  const p = s ? (s.pledge ? w.pledges[s.pledge] : null) : w.pledges[ref];
  const need = p ? needOf(w, p.goal, p.need) : null;
  const dest = s ? s.to : p ? destinationOf(w, p) : null;
  const recipient = dest ? recipientOf(w, dest) : null;
  const provider = p ? p.provider : s?.owner;
  let ownerNow = provider;
  if (s && s.state === '到着済み') {
    ownerNow = s.arrivedOwner;
    // 着いた後に倉ごと奪われたら、中身は奪った人の物（S1：goods stay in the vault）
    const f = s.to.kind === 'facility' ? w.facilities[s.to.id] : null;
    if (f && s.toGen != null && f.gen !== s.toGen) ownerNow = f.owner;
  }
  if (s && s.state === '奪われた') ownerNow = 'enemy';
  if (s && (s.state === '失われた' || s.state === '送信失敗')) ownerNow = s.state === '送信失敗' ? provider : null;
  let user = null;
  if (need?.usedBy === 'vault-owner') user = recipient;
  else if (need?.usedBy) user = need.usedBy;
  else if (need && (need.kind === 'build' || need.kind === 'garrison' || need.kind === 'watch' || need.kind === 'escort')) user = provider;
  return {
    provider,
    ownerNow,
    ownerAfter: recipient ?? provider,
    user,
    method: need?.kind === 'deliver' || s ? (recipient == null ? '受け取る倉がまだない' : recipient === provider ? (need?.to?.kind === 'vault-at' ? '自分の倉に置く' : '自分の場所へ動かす') : (need?.to?.kind === 'vault-at' ? '倉の持ち主に贈る' : '贈る')) : p?.method ?? null,
    transfersOwnership: recipient != null && recipient !== provider,
  };
}

/** 申し出の行き先。building=true なら、建設中の倉も見込みとして返す（発送はできない）。 */
function destinationOf(w, p, building = false) {
  const n = needOf(w, p.goal, p.need);
  if (!n || n.kind !== 'deliver') return null;
  if (n.to.kind === 'village') return { kind: 'village', member: n.to.member };
  const vs = vaultsAt(w, n.to.at, building);
  const any = vs.find(f => f.owner === p.provider) ?? vs.find(f => f.status === '稼働') ?? vs[0];
  return any ? { kind: 'facility', id: any.id } : null;
}
/** 今送ったときの到着見込み。倉が建設中なら、完成を待ってから送る前提で数える。 */
function etaIfSent(w, p) {
  const dest = destinationOf(w, p, true);
  if (!dest) return Infinity;
  const travel = travelTurns(w.members[p.provider].home, placeOf(w, dest));
  const f = dest.kind === 'facility' ? w.facilities[dest.id] : null;
  const start = f && f.status === '建設中' ? Math.max(w.turn, f.readyAt) : w.turn;
  return start + 1 + travel;
}
function recipientOf(w, dest) {
  if (dest.kind === 'village') return dest.member;
  return w.facilities[dest.id]?.owner ?? null;
}
const placeOf = (w, dest) => (dest.kind === 'village' ? w.members[dest.member].home : w.facilities[dest.id].at);

// ------------------------------------------------------------------ 使える量の割り当て

/**
 * 成立の条件に使う「今そこにある物と兵」を、目標に割り当てる。同じ物を二つの目標で数えないため、
 * 生きている目標を提案の古い順に並べ、先の目標から順に取る。材料（input）は割り当てない。
 * 返り値は `${goal}|${need}` → 割り当てた量。
 */
export function allocations(w) {
  const out = {};
  const pools = new Map();
  const take = (key, have, want) => {
    const used = pools.get(key) ?? 0;
    const got = Math.max(0, Math.min(want, have - used));
    pools.set(key, used + got);
    return got;
  };
  const goals = Object.values(w.goals).filter(g => goalIsLive(g) || g.status === '成立')
    .sort((a, b) => a.proposedAt - b.proposedAt || (a.id < b.id ? -1 : 1));
  for (const g of goals) {
    for (const n of g.needs) {
      if (n.kind === 'deliver' && !n.input) {
        let got = 0;
        if (n.to.kind === 'village') {
          got = take(`v|${n.to.member}|${n.resource}`, w.stock[n.to.member][n.resource] ?? 0, n.qty);
        } else {
          for (const f of vaultsAt(w, n.to.at)) got += take(`f|${f.id}|${n.resource}`, f.contents[n.resource] ?? 0, n.qty - got);
        }
        out[`${g.id}|${n.id}`] = got;
      } else if (n.kind === 'garrison') {
        const fort = fortAt(w, g.site);
        out[`${g.id}|${n.id}`] = fort ? take(`t|${fort.id}`, fort.troops, n.qty) : 0;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ 進み具合

/**
 * 必要なもの1つの進み具合。arrived だけが「満たした量」。inTransit と pledged は見込み。
 * onTime は、期限までに着く見込みの量（到着済み＋期限前に着く荷＋今送れば間に合う申し出）。
 */
export function needProgress(w, goalId, needId) {
  const g = w.goals[goalId];
  const n = needOf(w, goalId, needId);
  const pledges = Object.values(w.pledges).filter(p => p.goal === goalId && p.need === needId);
  const ships = Object.values(w.shipments).filter(s => s.pledge && w.pledges[s.pledge]?.goal === goalId && w.pledges[s.pledge]?.need === needId);
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  if (n.kind === 'deliver') {
    const arrived = sum(ships.filter(s => s.state === '到着済み' && s.arrivedOwner !== 'enemy'), s => s.qty - (s.overflow ?? 0));
    const moving = ships.filter(s => s.state === '送信済み' || s.state === '輸送中');
    const inTransit = sum(moving, s => s.qty);
    const lateTransit = sum(moving.filter(s => s.eta > g.deadline), s => s.qty);
    const live = pledges.filter(p => p.status !== '再確認待ち' && isLive(p));
    const pledged = sum(live, p => Math.max(0, p.qty - p.sent));
    const unconfirmed = sum(pledges.filter(p => p.status === '再確認待ち'), p => Math.max(0, p.qty - p.sent));
    const lost = sum(ships.filter(s => s.state === '失われた' || s.state === '奪われた' || s.arrivedOwner === 'enemy'), s => s.qty);
    const pledgedOnTime = sum(live.filter(p => w.members[p.provider].present && p.status !== '供給元を失った'), p => (etaIfSent(w, p) <= g.deadline ? Math.max(0, p.qty - p.sent) : 0));
    const pledgedAbsent = sum(live.filter(p => !w.members[p.provider].present), p => Math.max(0, p.qty - p.sent));
    // 材料は届いた累計で進み具合だけを見る。条件は「今そこにあって、この目標に割り当てられる量」で見る
    const available = n.input ? null : (allocations(w)[`${goalId}|${needId}`] ?? 0);
    const have = n.input ? arrived : available;
    return {
      kind: n.kind, input: !!n.input, required: n.qty, arrived, available, inTransit, lateTransit, pledged, pledgedAbsent, unconfirmed, lost,
      onTime: have + inTransit - lateTransit + pledgedOnTime,
      satisfied: have >= n.qty,
    };
  }
  if (n.kind === 'build') {
    const fs = Object.values(w.facilities).filter(f => f.kind === n.building && f.at === n.at && w.members[f.owner]?.inNation);
    const live = fs.find(f => f.status === '稼働');
    const building = fs.find(f => f.status === '建設中');
    const pledgedBy = pledges.filter(isCounted).map(p => p.provider);
    return { kind: n.kind, required: 1, arrived: live ? 1 : 0, inTransit: building ? 1 : 0, pledged: pledgedBy.length ? 1 : 0,
      facility: (live ?? building)?.id ?? null, owner: (live ?? building)?.owner ?? null, eta: building?.readyAt ?? null,
      pledgedBy, satisfied: !!live };
  }
  if (n.kind === 'garrison') {
    const fort = fortAt(w, g.site);
    const troops = allocations(w)[`${goalId}|${needId}`] ?? 0;
    const marching = sum(Object.values(w.marches).filter(m => m.kind === 'garrison' && m.state === '移動中' && fort && m.to === fort.id), m => m.size);
    const pledged = sum(pledges.filter(isCounted), p => Math.max(0, p.qty - p.sent));
    return { kind: n.kind, required: n.qty, arrived: troops, inFort: fort?.troops ?? 0, inTransit: marching, pledged, owner: fort?.owner ?? null, satisfied: troops >= n.qty };
  }
  if (n.kind === 'watch') {
    const tower = Object.values(w.facilities).find(f => f.kind === '見張り塔' && f.at === n.at && f.status === '稼働' && w.members[f.owner]?.inNation);
    const fresh = w.scouts.find(s => s.at === n.at && s.state === '帰還' && w.turn - s.returnedAt <= SCOUT_FRESH_TURNS);
    const scouting = w.scouts.find(s => s.at === n.at && s.state === '偵察中');
    const towerBuilding = Object.values(w.facilities).find(f => f.kind === '見張り塔' && f.at === n.at && f.status === '建設中');
    return { kind: n.kind, required: 1, arrived: tower || fresh ? 1 : 0, inTransit: scouting || towerBuilding ? 1 : 0,
      pledged: pledges.filter(isCounted).length ? 1 : 0, by: tower ? `塔（${label.who(w, tower.owner)}）` : fresh ? `偵察（${label.who(w, fresh.owner)}、ターン${fresh.returnedAt}）` : null,
      satisfied: !!(tower || fresh) };
  }
  if (n.kind === 'escort') {
    return { kind: n.kind, required: 0, arrived: 0, inTransit: 0, pledged: pledges.filter(isCounted).length, sealed: true, satisfied: true };
  }
  return { kind: n.kind, required: 0, arrived: 0, inTransit: 0, pledged: 0, satisfied: true };
}

function fortAt(w, at) {
  return Object.values(w.facilities).find(f => f.kind === '砦' && f.at === at && f.status === '稼働' && w.members[f.owner]?.inNation);
}

/** 目標の条件が今そろっているか（材料と任意のものは条件にしない）。missing は足りないものの id。 */
export function readiness(w, goalId) {
  const g = w.goals[goalId];
  const missing = g.needs.filter(n => !n.optional && !n.input && !needProgress(w, goalId, n.id).satisfied).map(n => n.id);
  return { ready: missing.length === 0, missing };
}

/** 人ごとの申し出の合計（資源ごと、すべての目標をまたいで）。手元の量と比べるため。 */
export function pledgeTotals(w, member) {
  const out = {};
  for (const p of Object.values(w.pledges)) {
    if (p.provider !== member || !isLive(p) || !p.resource) continue;
    out[p.resource] = (out[p.resource] ?? 0) + Math.max(0, p.qty - p.sent);
  }
  return out;
}

// ------------------------------------------------------------------ 行動（人が選ぶこと）

const ACTIONS = {
  cosign, uncosign, volunteer, pledge, withdraw, dispatch, build, train, garrison, scout, march, leaveGoal,
  amend, reconfirm, request, answer, vote, takeOver, closeGoal, returnGift, decline, gift: (w, a, x) => returnGift(w, a, x),
};

/**
 * 人 actor が行動する。持ち主でない物には触れない。成功なら {ok:true}、失敗なら {ok:false, error}。
 * 失敗した行動は世界を変えない。
 */
export function act(w, actor, kind, args = {}) {
  const m = w.members[actor];
  if (!m) return fail('知らない人');
  if (!m.present) return fail(`${m.name}は不在。本人が戻るまで、本人の物は誰も動かせない`);
  const f = ACTIONS[kind];
  if (!f) return fail(`知らない行動：${kind}`);
  const r = f(w, actor, args);
  if (r.ok) touch(w, actor);
  return r;
}

function liveGoal(w, id) {
  const g = w.goals[id];
  if (!g) return [null, fail('その目標はない')];
  if (g.status !== '提案中' && g.status !== '準備中') return [null, fail(`目標は「${g.status}」。もう申し出は受け付けない`)];
  return [g, null];
}

function cosign(w, actor, { goal }) {
  const [g, e] = liveGoal(w, goal);
  if (e) return e;
  if (w.members[actor].expelled) return fail('追放中は賛同できない');
  if (g.cosigners.includes(actor)) return fail('もう賛同している（同じ村の賛同は1つだけ）');
  g.cosigners.push(actor);
  const c = cosignCount(w, g);
  log(w, 'goal', `${label.who(w, actor)}が「${g.title}」に賛同した（${c.villages}村・判断する人${c.controllers}／採択に${ADOPT_COSIGNERS}）。賛同は資源を出す約束でも、発送の権限でもない`, { goal });
  if (g.status === '提案中' && c.controllers >= ADOPT_COSIGNERS) {
    g.status = '準備中';
    g.adoptedAt = w.turn;
    log(w, 'goal', `「${g.title}」が試遊の仮説（賛同${ADOPT_COSIGNERS}）で採択された。国の正式な決定ではない。参加は各自の任意`, { goal });
  }
  return ok();
}

/**
 * 賛同の数。村の数と、判断する人（controller）の数を分けて返す。採択は controller の数で見る。
 * 同じ人が動かす複数の村や、同じ運営者が動かす台本・AI は、一つの意思として数える。
 */
export function cosignCount(w, g) {
  const ms = g.cosigners.map(id => w.members[id]).filter(Boolean);
  return {
    villages: ms.length,
    controllers: new Set(ms.map(m => m.controller ?? m.id)).size,
    kinds: ms.reduce((a, m) => ({ ...a, [m.kind ?? 'human']: (a[m.kind ?? 'human'] ?? 0) + 1 }), {}),
  };
}

/** 賛同を取り消す。採択済みの目標は、取り消しで自動には取り消されない（調整役に知らせる）。 */
function uncosign(w, actor, { goal }) {
  const [g, e] = liveGoal(w, goal);
  if (e) return e;
  if (!g.cosigners.includes(actor)) return fail('賛同していない');
  g.cosigners = g.cosigners.filter(x => x !== actor);
  log(w, 'goal', `${label.who(w, actor)}が「${g.title}」への賛同を取り消した。出した申し出はそのまま（取り下げは別の操作）`, { goal });
  if (g.coordinator === actor) handOver(w, g, actor);
  return ok();
}

/** 調整役が抜けたとき、次の調整役を決める。残る賛同者がいなければ空にする（誰でも名乗り出られる）。 */
function handOver(w, g, leaving) {
  const next = g.cosigners.find(c => c !== leaving && w.members[c].present && w.members[c].playable !== false)
    ?? g.cosigners.find(c => c !== leaving && w.members[c].present);
  g.coordinator = next ?? null;
  log(w, 'goal', next ? `調整役が${label.who(w, next)}に移った（残っている賛同者の最初の人）` : '調整役がいなくなった。国の仲間なら誰でも名乗り出られる', { goal: g.id });
}

/** 調整役がいないときに名乗り出る。名乗り出た人は賛同者にもなる。物の持ち主は変わらない。 */
function volunteer(w, actor, { goal }) {
  const [g, e] = liveGoal(w, goal);
  if (e) return e;
  if (g.coordinator) return fail(`調整役は${label.who(w, g.coordinator)}がいる`);
  if (w.members[actor].expelled) return fail('追放中は名乗り出られない');
  g.coordinator = actor;
  if (!g.cosigners.includes(actor)) g.cosigners.push(actor);
  log(w, 'goal', `${label.who(w, actor)}が調整役に名乗り出た`, { goal });
  return ok();
}

/** 必要なものごとに、その人が申し出られるか。理由つき。 */
export function canPledge(w, actor, goalId, needId) {
  const g = w.goals[goalId];
  const n = needOf(w, goalId, needId);
  if (!g || !n) return { ok: false, reason: 'その必要はない' };
  if (g.status !== '提案中' && g.status !== '準備中') return { ok: false, reason: `目標は「${g.status}」` };
  if (w.members[actor].expelled) return { ok: false, reason: '追放中は申し出られない' };
  if (findPledge(w, actor, goalId, needId)) return { ok: false, reason: 'もう申し出ている' };
  if (n.kind === 'deliver') {
    if (n.to.kind === 'village' && n.to.member === actor) return { ok: false, reason: '自分の村への納めは、自分の在庫をそのまま使えばよい' };
    if ((w.stock[actor][n.resource] ?? 0) <= 0 && !facilitiesOf(w, actor, '工房').length) return { ok: false, reason: `${label.res(n.resource)}を持っていない` };
    return { ok: true };
  }
  if (n.kind === 'build') {
    if (facilitiesOf(w, actor, n.building).length >= BUILD_LIMIT[n.building]) return { ok: false, reason: `${n.building}は一人${BUILD_LIMIT[n.building]}つまで（S1 の上限）` };
    const p = needProgress(w, goalId, needId);
    if (p.satisfied || p.inTransit) return { ok: false, reason: 'もう建っている（または建設中）' };
    const other = Object.values(w.pledges).find(x => x.goal === goalId && x.need === needId && isLive(x) && x.provider !== actor);
    if (other) return { ok: false, reason: `${label.who(w, other.provider)}が建てると申し出ている（1マスに建物1つ）` };
    return { ok: true };
  }
  if (n.kind === 'garrison') {
    const fort = Object.values(w.facilities).find(f => f.kind === '砦' && f.at === g.site && f.status !== '奪われた');
    const fortPledger = Object.values(w.pledges).find(p => p.goal === goalId && p.need === 'fort' && isLive(p))?.provider;
    const fortOwner = fort?.owner ?? fortPledger;
    if (fortOwner && fortOwner !== actor) return { ok: false, reason: `S1 では砦に兵を置けるのは砦の持ち主（${label.who(w, fortOwner)}）だけ。代わりに、持ち主が兵を訓練するための食料を送れる` };
    if (!fortOwner) return { ok: false, reason: '砦を建てる人がまだいない。兵を置けるのは砦の持ち主だけ' };
    return { ok: true };
  }
  if (n.kind === 'watch' || n.kind === 'escort') return { ok: true };
  return { ok: false, reason: '申し出られない' };
}

function pledge(w, actor, { goal, need, qty = 0, cap, method, vault }) {
  const c = canPledge(w, actor, goal, need);
  if (!c.ok) return fail(c.reason);
  const n = needOf(w, goal, need);
  const p = {
    id: null, goal, need, provider: actor, version: w.goals[goal].version,
    resource: n.kind === 'deliver' ? n.resource : null,
    qty: 0, cap: 0, sent: 0, status: '申し出', method: null, vault: null, at: w.turn,
  };
  if (n.kind === 'deliver') {
    qty = toInt(qty);
    if (!(qty > 0)) return fail('量を1以上にする');
    cap = cap == null ? qty : toInt(cap);
    if (!(cap >= qty)) return fail('提供の上限は、申し出る量以上の整数にする');
    p.qty = qty; p.cap = cap;
    if (n.to.kind === 'vault-at') {
      if (method === '預ける') return fail('「預ける（持ち主のまま他人が使う）」には使用権が要る。S1 にはない（②に依頼中）');
      const own = vaultsAt(w, n.to.at, true).find(f => f.owner === actor);
      const willBuild = Object.values(w.pledges).some(x => x.goal === goal && x.provider === actor && isLive(x) && needOf(w, goal, x.need)?.kind === 'build' && needOf(w, goal, x.need)?.building === '倉');
      p.method = own || willBuild ? '自分の倉に置く' : '倉の持ち主に贈る';
    } else {
      p.method = '贈る';
    }
    const have = (w.stock[actor][n.resource] ?? 0) - (pledgeTotals(w, actor)[n.resource] ?? 0);
    if (qty > have) p.status = '準備中';
  } else if (n.kind === 'garrison') {
    qty = qty == null || qty === 0 ? n.qty : toInt(qty);
    if (!(qty > 0)) return fail('人数を1以上にする');
    p.qty = qty; p.cap = qty; p.method = '自分の砦に置く';
  } else if (n.kind === 'build') {
    p.method = `自分の${n.building}を建てる`; p.qty = 1;
  } else if (n.kind === 'watch') {
    p.method = method === '塔' ? '見張り塔を建てる' : '偵察を出す'; p.qty = 1;
  } else if (n.kind === 'escort') {
    p.method = '護衛（封じた進軍）'; p.qty = 1;
  }
  p.id = nextId(w, 'p');
  w.pledges[p.id] = p;
  const g = w.goals[goal];
  if (n.kind === 'escort') log(w, 'pledge', `「${g.title}」に護衛の申し出が1件あった（中身は封）`, { goal });
  else log(w, 'pledge', `${label.who(w, actor)}が申し出た：${describeNeed(w, n)}${p.resource ? ` を ${p.qty}（上限 ${p.cap}）` : ''}・${p.method}${p.status === '準備中' ? '（手元に足りない分は作ってから）' : ''}`, { goal, pledge: p.id });
  return ok({ pledge: p.id });
}

export function describeNeed(w, n) {
  if (n.kind === 'deliver') {
    const to = n.to.kind === 'village' ? `${label.who(w, n.to.member)}の村へ` : '拠点の倉へ';
    return `${label.res(n.resource)} ${n.qty} ${to}`;
  }
  if (n.kind === 'build') return `${label.place(n.at)}に${n.building}`;
  if (n.kind === 'garrison') return `砦の守備兵 ${n.qty}`;
  if (n.kind === 'watch') return `${label.place(n.at)}の見張り`;
  if (n.kind === 'escort') return '荷車の護衛（任意）';
  return n.id;
}

function ownPledge(w, actor, id) {
  const p = w.pledges[id];
  if (!p) return [null, fail('その申し出はない')];
  if (p.provider !== actor) return [null, fail(`この申し出の持ち主は${label.who(w, p.provider)}。持ち主しか動かせない`)];
  return [p, null];
}

function withdraw(w, actor, { pledge: id, reason = '' }) {
  const [p, e] = ownPledge(w, actor, id);
  if (e) return e;
  if (!isLive(p)) return fail(`申し出は「${p.status}」`);
  const left = Math.max(0, p.qty - p.sent);
  p.status = '取り下げ';
  const n = needOf(w, p.goal, p.need);
  log(w, 'withdraw', `${label.who(w, actor)}が申し出を取り下げた：${describeNeed(w, n)}（未発送 ${left}${p.sent ? `、発送済み ${p.sent} はそのまま届く` : ''}）${reason ? `。理由：${reason}` : ''}`, { goal: p.goal, pledge: id });
  return ok();
}

function decline(w, actor, { goal, need }) {
  w.declined[`${actor}|${goal}|${need}`] = w.turn;
  return ok();
}

function dispatch(w, actor, { pledge: id, qty }) {
  const [p, e] = ownPledge(w, actor, id);
  if (e) return e;
  if (!isLive(p) || p.status === '再確認待ち') return fail(`申し出は「${p.status}」。発送の前に${p.status === '再確認待ち' ? '続けるか決める' : '申し出し直す'}`);
  const n = needOf(w, p.goal, p.need);
  if (n.kind !== 'deliver') return fail('物を送る申し出ではない');
  if (!goalIsLive(w.goals[p.goal])) return fail(`目標は「${w.goals[p.goal].status}」。もう送る必要はない`);
  const dest = destinationOf(w, p);
  if (!dest) return fail('受け取る倉がまだない。先に誰かが拠点に倉を建てる必要がある');
  qty = toInt(qty ?? (p.qty - p.sent));
  const room = Math.min(p.cap - p.sent, p.qty - p.sent);
  if (!(qty > 0)) return fail('量を1以上にする');
  if (qty > room) return fail(`申し出の残り（${room}）を超えている`);
  const have = w.stock[actor][n.resource] ?? 0;
  if (qty > have) return fail(`手元の${label.res(n.resource)}は ${have}。足りない`);
  const from = w.members[actor].home;
  const to = placeOf(w, dest);
  w.stock[actor][n.resource] = have - qty;
  const s = {
    id: nextId(w, 's'), pledge: p.id, owner: actor, resource: n.resource, qty, from, to: dest,
    sentAt: w.turn, state: '送信済み', eta: w.turn + 1 + travelTurns(from, to), delay: 0, reason: null, arrivedOwner: null,
    toGen: dest.kind === 'facility' ? w.facilities[dest.id].gen : null,
  };
  w.shipments[s.id] = s;
  p.sent += qty;
  p.status = p.sent >= p.qty ? '発送済み' : '一部発送';
  log(w, 'ship', `${label.who(w, actor)}が${label.res(n.resource)} ${qty} を送った（送信済み。まだ届いていない。到着見込み：ターン${s.eta}）`, { goal: p.goal, shipment: s.id });
  return ok({ shipment: s.id });
}

function payCost(w, actor, cost) {
  const st = w.stock[actor];
  const short = Object.entries(cost).filter(([r, v]) => (st[r] ?? 0) < v).map(([r, v]) => `${label.res(r)} ${v - (st[r] ?? 0)}`);
  if (short.length) return short;
  for (const [r, v] of Object.entries(cost)) st[r] -= v;
  return null;
}

function build(w, actor, { kind, at, pledge: pid }) {
  const cost = BUILD_COST[kind];
  if (!cost) return fail('その建物は建てられない');
  if (!(at === 'site' || at === 'pass' || at === w.members[actor].home)) return fail('建てられるのは拠点・峠・自分の村だけ（試作）');
  let linked = null;
  if (pid != null) {
    const p = w.pledges[pid];
    const n = p && needOf(w, p.goal, p.need);
    const fits = n && ((n.kind === 'build' && n.building === kind && n.at === at) || (n.kind === 'watch' && kind === '見張り塔' && n.at === at));
    if (!p || p.provider !== actor || !isCounted(p) || !fits || !goalIsLive(w.goals[p.goal])) return fail('この申し出には、この建物で応えられない');
    linked = p;
  }
  if (facilitiesOf(w, actor, kind).length >= BUILD_LIMIT[kind]) return fail(`${kind}は一人${BUILD_LIMIT[kind]}つまで（S1 の上限）`);
  if (kind === '砦' && Object.values(w.facilities).some(f => f.kind === '砦' && f.at === at && f.status !== '奪われた' && f.status !== '壊れた')) return fail('ここにはもう砦がある');
  const short = payCost(w, actor, cost);
  if (short) return fail(`材料が足りない：${short.join('、')}`);
  const f = { id: nextId(w, 'f'), kind, owner: actor, at, status: '建設中', readyAt: w.turn + BUILD_TURNS[kind], contents: {}, troops: 0, gen: 0 };
  w.facilities[f.id] = f;
  if (linked) { linked.status = '発送済み'; linked.sent = 1; }
  log(w, 'build', `${label.who(w, actor)}が${label.place(at)}に${kind}を建て始めた（持ち主：${label.who(w, actor)}。完成：ターン${f.readyAt}）`, { facility: f.id });
  return ok({ facility: f.id });
}

/** 行動に結びつける自分の申し出（生きている目標・数えてよい申し出・必要の種類が合うもの）。 */
function ownCountedPledge(w, actor, kind, at) {
  return Object.values(w.pledges).find(x => x.provider === actor && isCounted(x) && goalIsLive(w.goals[x.goal])
    && needOf(w, x.goal, x.need)?.kind === kind && (at == null || needOf(w, x.goal, x.need)?.at === at));
}

function train(w, actor, { n }) {
  n = toInt(n);
  if (!(n > 0)) return fail('人数を1以上にする');
  const food = n * FOOD_PER_SPEARMAN;
  if ((w.stock[actor].food ?? 0) < food) return fail(`食料が足りない（${food} 要る）`);
  w.stock[actor].food -= food;
  w.reserve[actor] += n;
  log(w, 'train', `${label.who(w, actor)}が自分の村で槍兵 ${n} を訓練した（食料 ${food}）`);
  return ok();
}

/** 砦の持ち主が、自分の予備の兵を砦に置く（S1 の FortGarrison。持ち主だけ。次のターンから数える）。 */
function garrison(w, actor, { n }) {
  const fort = Object.values(w.facilities).find(f => f.kind === '砦' && f.owner === actor && f.status === '稼働');
  if (!fort) return fail('稼働している自分の砦がない。砦に兵を置けるのは砦の持ち主だけ');
  n = toInt(n);
  if (!(n > 0)) return fail('人数を1以上にする');
  if (w.reserve[actor] < n) return fail(`予備の兵は ${w.reserve[actor]}。足りない`);
  w.reserve[actor] -= n;
  const m = { id: nextId(w, 'm'), kind: 'garrison', owner: actor, size: n, to: fort.id, state: '移動中', eta: w.turn + 1 };
  w.marches[m.id] = m;
  const p = ownCountedPledge(w, actor, 'garrison');
  if (p) { p.sent = Math.min(p.qty, p.sent + n); p.status = p.sent >= p.qty ? '発送済み' : '一部発送'; }
  log(w, 'army', `${label.who(w, actor)}が自分の砦に兵 ${n} を置く命令を出した（ターン${m.eta}から数える）`);
  return ok();
}

function scout(w, actor, { at = 'pass' }) {
  if (!PLACES[at] || at.startsWith('v:')) return fail('偵察の行き先が正しくない');
  if (w.reserve[actor] < 10) return fail('偵察に出す兵（10）がいない');
  w.reserve[actor] -= 10;
  const t = travelTurns(w.members[actor].home, at);
  const s = { id: nextId(w, 'sc'), owner: actor, at, state: '偵察中', returnAt: w.turn + 2 * t, returnedAt: null };
  w.scouts.push(s);
  const p = ownCountedPledge(w, actor, 'watch', at);
  if (p) { p.sent = 1; p.status = '発送済み'; }
  log(w, 'scout', `${label.who(w, actor)}が${label.place(at)}へ偵察を出した（戻り：ターン${s.returnAt}）`);
  return ok();
}

/** 進軍（封じた進軍の代わり）。持ち主が出したときだけ動く。どんな条件でも自動では出ない。 */
function march(w, actor, { n, to = 'pass', purpose = '進軍' }) {
  n = toInt(n);
  if (!(n > 0)) return fail('人数を1以上にする');
  if (!PLACES[to]) return fail('行き先が正しくない');
  const fort = Object.values(w.facilities).find(f => f.kind === '砦' && f.owner === actor && f.status === '稼働');
  const fromFort = purpose === '砦から出る';
  const pool = fromFort ? fort?.troops ?? 0 : w.reserve[actor];
  if (pool < n) return fail(`${fromFort ? '砦の兵' : '予備の兵'}は ${pool}。足りない`);
  if (fromFort) fort.troops -= n; else w.reserve[actor] -= n;
  const m = { id: nextId(w, 'm'), kind: purpose === '護衛' ? 'escort' : 'march', owner: actor, size: n, to, state: '移動中(封)', eta: w.turn + travelTurns(fromFort ? 'site' : w.members[actor].home, to), sealed: true };
  w.marches[m.id] = m;
  if (purpose === '護衛') {
    const p = ownCountedPledge(w, actor, 'escort');
    if (p) { p.sent = 1; p.status = '発送済み'; }
    log(w, 'army', '拠点へ向かう荷車の護衛が1件出た（中身は封）');
  } else {
    log(w, 'army', `${label.who(w, actor)}が自分の判断で軍を出した（行き先は封）`);
  }
  return ok();
}

/** 目標から抜ける。未発送の申し出はすべて取り下げ。発送済みの荷はそのまま届く。 */
function leaveGoal(w, actor, { goal, reason = '' }) {
  const g = w.goals[goal];
  if (!g) return fail('その目標はない');
  const mine = Object.values(w.pledges).filter(p => p.goal === goal && p.provider === actor && isLive(p));
  for (const p of mine) p.status = '取り下げ';
  const moving = Object.values(w.shipments).filter(s => s.owner === actor && (s.state === '送信済み' || s.state === '輸送中') && w.pledges[s.pledge]?.goal === goal);
  log(w, 'withdraw', `${label.who(w, actor)}が「${g.title}」から抜けた。未発送の申し出 ${mine.length} 件は取り下げ${moving.length ? `。輸送中の荷 ${moving.length} 台は、そのまま行き先へ届き、受け取った人の物になる` : ''}${reason ? `。理由：${reason}` : ''}`, { goal });
  if (goalIsLive(g)) {
    g.cosigners = g.cosigners.filter(x => x !== actor);
    if (g.coordinator === actor) handOver(w, g, actor);
  }
  return ok({ withdrawn: mine.length });
}

/**
 * 方針変更（調整役だけ）。新しい版を作る。未発送の申し出はすべて「再確認待ち」になり、
 * 本人が続けるか決めるまで、申し出の量として数えない。発送済みの荷は行き先が同じなのでそのまま届く。
 */
function amend(w, actor, { goal, deadline, qty = {}, purpose, optional = [], note = '' }) {
  const [g, e] = liveGoal(w, goal);
  if (e) return e;
  if (!g.coordinator || g.coordinator !== actor) return fail(g.coordinator ? `方針を変えられるのは調整役（${label.who(w, g.coordinator)}）だけ。提案者でも、他人の物は動かせない` : '調整役がいない。先に名乗り出る');
  if (deadline != null && !(toInt(deadline) > w.turn)) return fail('期限は今より後のターンにする');
  for (const [nid, v] of Object.entries(qty)) {
    if (!needOf(w, goal, nid)) return fail('その必要はない');
    if (!(toInt(v) >= 1)) return fail('必要量は1以上の整数にする');
  }
  for (const nid of optional) if (!needOf(w, goal, nid)) return fail('その必要はない');
  if (deadline != null) deadline = toInt(deadline);
  const changes = [];
  if (deadline != null && deadline !== g.deadline) { changes.push(`期限 ${g.deadline}→${deadline}`); g.deadline = deadline; }
  for (const [nid, v] of Object.entries(qty)) {
    const n = needOf(w, goal, nid);
    if (n && n.qty !== toInt(v)) { changes.push(`${describeNeed(w, n)}→${toInt(v)}`); n.qty = toInt(v); }
  }
  for (const nid of optional) {
    const n = needOf(w, goal, nid);
    if (n && !n.optional) { n.optional = true; changes.push(`${describeNeed(w, n)}を任意に`); }
  }
  if (purpose && purpose !== g.purpose) { changes.push(`目的「${purpose}」`); g.purpose = purpose; }
  const answering = g.conflict && !g.conflict.answered;
  if (!changes.length && !answering) return fail('変更がない');
  if (!changes.length) {
    g.conflict.answered = true;
    g.requiresStance = {};
    log(w, 'goal', `${label.who(w, actor)}が、変わった前提のまま目標を続けると決めた（方針は変えない）`, { goal });
    return ok();
  }
  g.history.push({ version: g.version, turn: w.turn, changes, note });
  g.version += 1;
  let n = 0;
  for (const p of Object.values(w.pledges)) {
    if (p.goal !== goal || !isLive(p)) continue;
    if (p.qty - p.sent > 0 || p.status === '申し出' || p.status === '準備中') { p.status = '再確認待ち'; p.version = g.version - 1; n++; }
  }
  if (answering) { g.conflict.answered = true; g.requiresStance = {}; }
  log(w, 'goal', `${label.who(w, actor)}が方針を変えた（第${g.version}版）：${changes.join('、')}。未発送の申し出 ${n} 件は、本人が続けるか決めるまで数えない`, { goal });
  return ok();
}

function reconfirm(w, actor, { pledge: id, keep, qty }) {
  const [p, e] = ownPledge(w, actor, id);
  if (e) return e;
  if (p.status !== '再確認待ち') return fail('再確認の必要はない');
  if (!keep) { p.status = '取り下げ'; log(w, 'withdraw', `${label.who(w, actor)}は新しい方針では続けないことにした`, { goal: p.goal }); return ok(); }
  if (qty != null) { p.qty = Math.max(p.sent, Math.floor(qty)); p.cap = Math.max(p.cap, p.qty); }
  p.version = w.goals[p.goal].version;
  p.status = p.sent > 0 ? (p.sent >= p.qty ? '発送済み' : '一部発送') : '申し出';
  log(w, 'pledge', `${label.who(w, actor)}が新しい方針でも続けると確かめた（第${p.version}版）`, { goal: p.goal });
  return ok();
}

/** 依頼：特定の人に頼む。受けるかどうかは頼まれた人が決める。 */
function request(w, actor, { to, goal, need, qty, text = '' }) {
  if (!w.members[to]) return fail('知らない人');
  if (to === actor) return fail('自分には頼めない');
  if (!goalIsLive(w.goals[goal])) return fail('その目標は、もう申し出を受け付けていない');
  if (!needOf(w, goal, need)) return fail('その必要はない');
  if (qty != null && !(toInt(qty) > 0)) return fail('量を1以上にする');
  const r = { id: nextId(w, 'r'), from: actor, to, goal, need, qty: qty ?? null, text, status: '未回答', at: w.turn };
  w.requests[r.id] = r;
  const n = needOf(w, goal, need);
  log(w, 'request', `${label.who(w, actor)}が${label.who(w, to)}に頼んだ：${describeNeed(w, n)}${qty ? `（${qty}）` : ''}。受けるかは${label.who(w, to)}が決める`, { goal });
  return ok({ request: r.id });
}

function answer(w, actor, { request: id, accept, qty }) {
  const r = w.requests[id];
  if (!r || r.to !== actor) return fail('自分あての依頼ではない');
  if (r.status !== '未回答') return fail('もう答えた');
  r.status = accept ? '受けた' : '断った';
  if (!accept) { log(w, 'request', `${label.who(w, actor)}は依頼を断った`, { goal: r.goal }); return ok(); }
  const n = needOf(w, r.goal, r.need);
  const res = pledge(w, actor, { goal: r.goal, need: r.need, qty: qty ?? r.qty ?? n.qty, cap: qty ?? r.qty ?? n.qty, method: n.kind === 'watch' ? '偵察' : undefined });
  if (!res.ok) { r.status = '未回答'; return res; }
  log(w, 'request', `${label.who(w, actor)}が依頼を受けた`, { goal: r.goal });
  return res;
}

function vote(w, actor, { vote: id, yes }) {
  const v = w.votes[id];
  if (!v || v.status !== '投票中') return fail('投票中の議題ではない');
  if (w.members[actor].expelled) return fail('追放中は投票できない');
  if (v.yes.includes(actor) || v.no.includes(actor)) return fail('もう投票した（1村1票、やり直しはできない）');
  (yes ? v.yes : v.no).push(actor);
  log(w, 'vote', `${label.who(w, actor)}が投票した（議題：${v.title}）`);
  return ok();
}

/** 調整役が不在のとき、賛同した人が調整役を引き継ぐ。物の持ち主は変わらない。 */
function takeOver(w, actor, { goal }) {
  const [g, e] = liveGoal(w, goal);
  if (e) return e;
  if (!g.cosigners.includes(actor)) return fail('引き継げるのは賛同した人だけ');
  if (!g.coordinator) return fail('調整役がいない。名乗り出る');
  if (g.coordinator === actor) return fail('もう調整役');
  if (!coordinatorAbsent(w, g)) return fail(`調整役（${label.who(w, g.coordinator)}）は不在ではない`);
  const prev = g.coordinator;
  g.coordinator = actor;
  log(w, 'goal', `${label.who(w, actor)}が調整役を引き継いだ（${label.who(w, prev)}が不在のため）。引き継ぐのは計画の編集だけで、${label.who(w, prev)}の物は動かせない`, { goal });
  return ok();
}

export function seemsAbsent(w, id) {
  const m = w.members[id];
  return !m.present || w.turn - m.lastActive >= ABSENT_TURNS;
}
function coordinatorAbsent(w, g) {
  return !!g.coordinator && !w.members[g.coordinator].present;
}

/** 目標を閉じる（調整役だけ）。中止しても、届いた物は受け取った人の物のまま。 */
function closeGoal(w, actor, { goal, reason = '' }) {
  const g = w.goals[goal];
  if (!g) return fail('その目標はない');
  if (g.coordinator !== actor) return fail('閉じられるのは調整役だけ');
  if (!goalIsLive(g)) return fail(`目標はもう「${g.status}」`);
  g.status = '中止';
  g.outcome = { turn: w.turn, kind: '中止', reason };
  for (const p of Object.values(w.pledges)) if (p.goal === goal && isLive(p)) p.status = '終了';
  log(w, 'goal', `${label.who(w, actor)}が「${g.title}」を中止した${reason ? `（${reason}）` : ''}。届いた物は受け取った人の物のまま。返すかどうかは受け取った人が決める`, { goal });
  return ok();
}

/** 他の人の村へ物を贈る（S1 の「他人への隊商」）。着いたら相手の物。返すときもこれを使う。 */
function returnGift(w, actor, { to, resource, qty, why = '返す', returnOf = null }) {
  qty = toInt(qty);
  if (!(qty > 0)) return fail('量を1以上にする');
  if (!w.members[to] || to === actor) return fail('送り先が正しくない');
  if (!RESOURCES[resource]) return fail('その資源はない');
  if ((w.stock[actor][resource] ?? 0) < qty) return fail('手元に足りない');
  if (returnOf != null && (w.shipments[returnOf]?.arrivedOwner !== actor || w.shipments[returnOf]?.returned)) return fail('返せる荷ではない');
  w.stock[actor][resource] -= qty;
  if (returnOf != null) w.shipments[returnOf].returned = true;
  const from = w.members[actor].home;
  const dest = { kind: 'village', member: to };
  const s = { id: nextId(w, 's'), pledge: null, owner: actor, resource, qty, from, to: dest, sentAt: w.turn, state: '送信済み', eta: w.turn + 1 + travelTurns(from, w.members[to].home), delay: 0, reason: null, why, arrivedOwner: null };
  w.shipments[s.id] = s;
  log(w, 'ship', `${label.who(w, actor)}が${label.who(w, to)}へ${label.res(resource)} ${qty} を送った（${why}。送信済み。着けば${label.who(w, to)}の物）`);
  return ok({ shipment: s.id });
}

// ------------------------------------------------------------------ ターンを進める

/**
 * n ターン進める。ここで起きるのは「すでに出された命令の結果」と「建物の自動の働き」だけ。
 * 軍の出発・発送・投票・方針変更は、ここでは決して起きない。
 */
export function advance(w, n = 1) {
  for (let i = 0; i < n; i++) step(w);
  return w;
}

function step(w) {
  w.turn += 1;
  // 工房の産出（持ち主の村の在庫に入る。鉱石2・木材1で兵器1：arms.rs）
  for (const f of Object.values(w.facilities)) {
    if (f.kind !== '工房' || f.status !== '稼働' || !w.members[f.owner]) continue;
    const st = w.stock[f.owner];
    const k = Math.min(f.perTurn, Math.floor((st.ore ?? 0) / 2), st.wood ?? 0);
    if (k > 0) { st.ore -= 2 * k; st.wood -= k; st.arms += k; }
  }
  // 建設の完了
  for (const f of Object.values(w.facilities)) {
    if (f.status === '建設中' && f.readyAt <= w.turn) {
      f.status = '稼働';
      log(w, 'build', `${label.who(w, f.owner)}の${f.kind}が${label.place(f.at)}に完成した`, { facility: f.id });
    }
  }
  // 荷車
  for (const s of Object.values(w.shipments)) {
    if (s.state === '送信済み') { s.state = '輸送中'; continue; }
    if (s.state !== '輸送中' || s.eta > w.turn) continue;
    arrive(w, s);
  }
  // 軍（すでに出された命令だけ）
  for (const m of Object.values(w.marches)) {
    if (m.state === '移動中' && m.eta <= w.turn && m.kind === 'garrison') {
      const fort = w.facilities[m.to];
      if (fort && fort.status === '稼働' && fort.owner === m.owner) { fort.troops += m.size; m.state = '到着'; }
      else { w.reserve[m.owner] += m.size; m.state = '戻った'; }
    } else if (m.state === '移動中(封)' && m.eta <= w.turn) {
      m.state = '到着(封)';
      if (m.kind === 'escort') m.until = w.turn + ESCORT_TURNS;
    } else if (m.kind === 'escort' && m.state === '到着(封)' && m.until <= w.turn) {
      m.state = '帰還中(封)';
      m.backAt = w.turn + travelTurns(m.to, w.members[m.owner].home);
    } else if (m.kind === 'escort' && m.state === '帰還中(封)' && m.backAt <= w.turn) {
      m.state = '帰還';
      w.reserve[m.owner] += m.size;
      log(w, 'army', '護衛が1件、村に戻った（中身は封）');
    }
  }
  // 偵察
  for (const s of w.scouts) {
    if (s.state === '偵察中' && s.returnAt <= w.turn) {
      s.state = '帰還'; s.returnedAt = w.turn; w.reserve[s.owner] += 10;
      log(w, 'scout', `${label.who(w, s.owner)}の偵察が戻った：${label.place(s.at)}に北の国の軍勢の跡（知らせは${SCOUT_FRESH_TURNS}ターンのあいだ有効）`);
    }
  }
  // 申し出の「準備中」：手元がそろえば「申し出」に戻る
  for (const p of Object.values(w.pledges)) {
    if (p.status !== '準備中' || !p.resource) continue;
    const others = Object.values(w.pledges).filter(x => x !== p && x.provider === p.provider && x.resource === p.resource && isLive(x) && x.status !== '準備中')
      .reduce((a, x) => a + Math.max(0, x.qty - x.sent), 0);
    if ((w.stock[p.provider][p.resource] ?? 0) - others >= p.qty - p.sent) {
      p.status = '申し出';
      log(w, 'pledge', `${label.who(w, p.provider)}の${label.res(p.resource)}がそろった。発送は${label.who(w, p.provider)}が決める`, { goal: p.goal });
    }
  }
  // 投票の締め切り（nation.rs passes：賛成>反対 かつ 賛成>=3）
  for (const v of Object.values(w.votes)) {
    if (v.status !== '投票中' || v.closesAt > w.turn) continue;
    const passed = v.yes.length > v.no.length && v.yes.length >= QUORUM;
    v.status = passed ? '可決' : '否決';
    log(w, 'vote', `議題「${v.title}」は${v.status}（賛成${v.yes.length}・反対${v.no.length}、定足数${QUORUM}）`);
    if (passed && v.kind === 'stance') {
      w.nation.stance[v.target] = v.value;
      for (const g of openGoals(w)) {
        if (g.requiresStance[v.target] && g.requiresStance[v.target] !== v.value) {
          g.conflict = { vote: v.id, turn: w.turn, answered: false,
            text: `国の構えが「${w.stanceNames[v.target]}：${stanceName(v.value)}」になった。塔と柵は${w.stanceNames[v.target]}を削らず止めなくなる（structure.rs stops）。砦は戦いでは構えを見ずに戦う（S1 契約 2.6）` };
          log(w, 'goal', `「${g.title}」の前提が変わった：${g.conflict.text}`, { goal: g.id });
        }
      }
    }
  }
  // 採択されない提案は消える
  for (const g of Object.values(w.goals)) {
    if (g.status === '提案中' && w.turn - g.proposedAt >= PROPOSAL_EXPIRES_TURNS) {
      g.status = '不成立';
      for (const p of Object.values(w.pledges)) if (p.goal === g.id && isLive(p)) p.status = '終了';
      log(w, 'goal', `「${g.title}」は判断する人の賛同が${ADOPT_COSIGNERS}に届かないまま${PROPOSAL_EXPIRES_TURNS}ターンたち、不成立になった。発送済みの荷は行き先へ届き、受け取った人の物になる`, { goal: g.id });
    }
  }
  // 成立と期限
  for (const g of Object.values(w.goals)) {
    if (g.status !== '準備中') continue;
    if (w.turn < g.deadline) continue;
    const r = readiness(w, g.id);
    if (r.ready) {
      g.status = '成立'; g.readyAt = w.turn;
      g.outcome = { turn: w.turn, kind: '成立' };
      for (const p of Object.values(w.pledges)) if (p.goal === g.id && isLive(p)) p.status = '終了';
      log(w, 'goal', `「${g.title}」が成立した：期限のターンに、条件が実際に使える状態でそろっていた。次に軍をどうするかは、それぞれの持ち主が決める（自動では出ない）`, { goal: g.id });
    } else {
      g.status = '期限切れ';
      g.outcome = { turn: w.turn, kind: '期限切れ', missing: r.missing };
      for (const p of Object.values(w.pledges)) if (p.goal === g.id && isLive(p)) p.status = '終了';
      log(w, 'goal', `「${g.title}」は期限（ターン${g.deadline}）までにそろわなかった。足りなかったもの：${r.missing.map(id => describeNeed(w, needOf(w, g.id, id))).join('、')}`, { goal: g.id });
    }
  }
}

function arrive(w, s) {
  if (s.to.kind === 'village') {
    const m = w.members[s.to.member];
    w.stock[s.to.member][s.resource] = (w.stock[s.to.member][s.resource] ?? 0) + s.qty;
    s.state = '到着済み'; s.arrivedOwner = s.to.member; s.arrivedAt = w.turn;
    log(w, 'ship', `${label.who(w, s.owner)}の${label.res(s.resource)} ${s.qty} が${m.name}の村に着いた。今から${m.name}の物`, { shipment: s.id });
    return;
  }
  const f = w.facilities[s.to.id];
  if (!f || f.status === '壊れた' || (s.toGen != null && f.gen !== s.toGen)) {
    s.state = '失われた'; s.arrivedAt = w.turn;
    log(w, 'ship', `${label.who(w, s.owner)}の${label.res(s.resource)} ${s.qty} は失われた。行き先の倉が${f && f.gen !== s.toGen ? '送った後に奪われていた（世代が変わった倉には届かない：S1 契約 1b の GEN）' : 'なくなっていた（行き先がない荷は LOST）'}`, { shipment: s.id });
    return;
  }
  const total = Object.values(f.contents).reduce((a, v) => a + v, 0);
  const room = Math.max(0, VAULT_CAP - total);
  const put = Math.min(s.qty, room);
  f.contents[s.resource] = (f.contents[s.resource] ?? 0) + put;
  s.overflow = s.qty - put;
  s.state = '到着済み'; s.arrivedOwner = f.owner; s.arrivedAt = w.turn;
  log(w, 'ship', `${label.who(w, s.owner)}の${label.res(s.resource)} ${put} が${label.who(w, f.owner)}の倉（${label.place(f.at)}）に着いた。今から${label.who(w, f.owner)}の物${s.overflow ? `。倉の上限を超えた ${s.overflow} は失われた（S1：VAULT_CAP）` : ''}`, { shipment: s.id });
}

export const stanceName = v => ({ war: '戦争', pass: '通行を許す', ally: '同盟' }[v] ?? v);

// ------------------------------------------------------------------ 世界の出来事（試作で起こす）

export const EVENTS = {
  delay: {
    title: '物流の遅延',
    detail: '最後に送った荷車が、期限を越えるまで遅れる',
    fact: '仮。S1 では、行き先が占領の決着待ちだと到着の確定が待たされる（CapturePending）。遅れの長さは仮',
  },
  txfail: {
    title: '送信が確定しない',
    detail: '送信済みの荷が、チェーンで確定しなかった',
    fact: '④の実行状態の扱い。試作では、荷は送り主の手元に戻る',
  },
  raid: {
    title: '荷車の襲撃',
    detail: '拠点へ向かう荷車が峠の手前で襲われる。護衛がいれば守れる',
    fact: '事実：襲撃は荷車ごと奪う（caravan.rs、決定 J2）。護衛の判定は仮',
  },
  withdraw: {
    title: '参加者の退出',
    detail: 'ミラの村が攻められ、ミラが目標から抜ける',
    fact: '試作の台本。抜けるのはいつでも自由',
  },
  facility: {
    title: '施設を失う',
    detail: 'ミラの工房が北の国に奪われる',
    fact: '仮。S1 の工房は村の建物で、村が奪われると失う',
  },
  stance: {
    title: '方針の対立（構えの投票）',
    detail: 'ユキが「北の国に通行を許す」を議会に出す',
    fact: `事実：構えの投票（nation.rs）。定足数${QUORUM}、賛成>反対で可決。締め切りは実際は${REAL_VOTE_WINDOW_TURNS}ターン、試作では${VOTE_WINDOW_TURNS}ターン`,
  },
  rival: {
    title: '方針の対立（競合する目標）',
    detail: 'ユキが「東の砦攻め」を提案し、兵器を求める',
    fact: '試作の台本。兵器の行き先を、持ち主がどちらかに決める',
  },
  vaultLost: {
    title: '倉を奪われる',
    detail: '拠点の倉が北の国に奪われる（中身ごと）',
    fact: '事実：SeizeVault で持ち主が奪った人になり、中身は倉に残り、世代（GEN）が1増える。向かっていた荷は届かず失われる（S1-1B 契約 3.4・3.6）',
  },
  fortLost: {
    title: '砦を失う',
    detail: '拠点の砦が落ちて奪われる（守備兵は0）',
    fact: '事実：守備兵0の砦は「落ちた」になり、SeizeStructure で奪える（S1-1E 契約 2.6）。試作では落ちて奪われるまでを1回で起こす',
  },
  absent: {
    title: '所有者の不在',
    detail: 'ソウタが不在になる（倉と食料はソウタの物のまま）',
    fact: '仮。不在の人の物は、誰も動かせない',
  },
  back: {
    title: '不在から戻る',
    detail: '不在の人が戻る',
    fact: '試作の操作',
  },
};

export function inject(w, kind, args = {}) {
  const f = {
    delay: evDelay, txfail: evTxFail, raid: evRaid, withdraw: evWithdraw, facility: evFacility,
    stance: evStance, rival: evRival, absent: evAbsent, back: evBack, vaultLost: evVaultLost, fortLost: evFortLost,
  }[kind];
  if (!f) return fail('知らない出来事');
  return f(w, args);
}

/** 遅らせるのは、指定がなければ最後に送った荷。turns がなければ、目標の期限を4ターン越えるまで遅らせる。 */
function evDelay(w, { shipment, turns }) {
  const s = shipment ? w.shipments[shipment]
    : Object.values(w.shipments).filter(x => x.state === '輸送中' || x.state === '送信済み').sort((a, b) => b.sentAt - a.sentAt || b.qty - a.qty)[0];
  if (!s || (s.state !== '輸送中' && s.state !== '送信済み')) return fail('遅らせる荷車がない（先に誰かが発送する）');
  const g = s.pledge ? w.goals[w.pledges[s.pledge].goal] : null;
  if (turns == null) turns = Math.max(10, (g ? g.deadline - s.eta : 0) + 4);
  s.eta += turns; s.delay += turns;
  s.reason = '受け取り側のマスで戦いが続き、到着の確定が待たされている';
  log(w, 'event', `出来事：${label.who(w, s.owner)}の${label.res(s.resource)} ${s.qty} の荷車が遅れる（+${turns}ターン、到着見込み：ターン${s.eta}）。理由：${s.reason}`, { shipment: s.id });
  return ok({ shipment: s.id });
}

function evTxFail(w, { shipment }) {
  const s = shipment ? w.shipments[shipment] : Object.values(w.shipments).find(x => x.state === '送信済み');
  if (!s || s.state !== '送信済み') return fail('送信済み（未確定）の荷がない。発送した直後に起こす');
  s.state = '送信失敗';
  w.stock[s.owner][s.resource] += s.qty;
  const p = w.pledges[s.pledge];
  if (p) {
    p.sent -= s.qty;
    if (p.status === '一部発送' || p.status === '発送済み') p.status = p.sent > 0 ? '一部発送' : '申し出';
  }
  log(w, 'event', `出来事：${label.who(w, s.owner)}の送信が確定しなかった。${label.res(s.resource)} ${s.qty} は手元に残っている（送り直すかは本人が決める）`, { shipment: s.id });
  return ok();
}

function evRaid(w, { shipment }) {
  const s = shipment ? w.shipments[shipment]
    : Object.values(w.shipments).find(x => x.state === '輸送中' && x.to.kind === 'facility');
  if (!s || s.state !== '輸送中') return fail('拠点の倉へ向かう荷車がない');
  const escort = Object.values(w.marches).find(m => m.kind === 'escort' && m.to === placeOf(w, s.to) && m.state === '到着(封)' && m.size > 0);
  // 護衛の判定は仮。待ち構えている護衛がいれば守り、護衛は少し減る
  if (escort) {
    log(w, 'event', `出来事：峠の手前で荷車が襲われたが、待ち構えていた護衛が守った（${label.who(w, s.owner)}の${label.res(s.resource)} ${s.qty} は無事）`);
    escort.size = Math.max(0, escort.size - 10);
    return ok({ defended: true });
  }
  s.state = '奪われた';
  log(w, 'event', `出来事：${label.who(w, s.owner)}の${label.res(s.resource)} ${s.qty} の荷車が北の国に奪われた（荷車ごと：決定 J2）`, { shipment: s.id });
  return ok({ defended: false });
}

function evWithdraw(w, { member = 'mira', goal = 'outpost' }) {
  const m = w.members[member];
  if (!m.present) return fail(`${m.name}は不在`);
  const r = leaveGoal(w, member, { goal, reason: '自分の村が攻められ、手元の兵器を自分の守りに使う' });
  if (r.ok) touch(w, member);
  return r;
}

function evFacility(w, { facility = 'ws-mira' }) {
  const f = w.facilities[facility];
  if (!f || f.status === '奪われた') return fail('その施設はもうない');
  f.status = '奪われた';
  const was = f.owner;
  f.owner = 'enemy';
  for (const p of Object.values(w.pledges)) {
    if (p.provider === was && isLive(p) && p.status !== '再確認待ち' && p.resource === 'arms' && p.qty - p.sent > (w.stock[was].arms ?? 0)) p.status = '供給元を失った';
  }
  log(w, 'event', `出来事：${label.who(w, was)}の工房（${label.place(f.at)}）が北の国に奪われた。これから兵器は作れない。手元の兵器 ${w.stock[was].arms} は残る`);
  return ok();
}

function evStance(w, {}) {
  if (Object.values(w.votes).some(v => v.status === '投票中')) return fail('もう投票中の議題がある');
  const v = { id: nextId(w, 'v'), kind: 'stance', target: 'north', value: 'pass', title: '北の国に通行を許す',
    proposer: 'yuki', yes: ['yuki', 'rio'], no: [], openAt: w.turn, closesAt: w.turn + VOTE_WINDOW_TURNS, status: '投票中',
    why: '北の国と交易したい。戦争のままだと、港町の荷車が北の峠を通れない' };
  w.votes[v.id] = v;
  log(w, 'event', `出来事：ユキが議会に「${v.title}」を出した（締め切り：ターン${v.closesAt}）。ユキとリオは賛成。可決には賛成${QUORUM}以上が要る`);
  return ok({ vote: v.id });
}

function evRival(w, {}) {
  if (w.goals[RIVAL_GOAL.id]) return fail('もう出ている');
  const g = proposeGoal(w, RIVAL_GOAL, 'yuki');
  cosign(w, 'rio', { goal: g.id });
  cosign(w, 'ren', { goal: g.id });
  log(w, 'goal', `「${g.title}」には3村が賛同したが、3村とも同じ運営者が動かす台本なので、判断する人は1と数える（採択されない）。採択されていなくても、申し出と発送はできる。兵器を持つ人は、どちらに出すか（出さないか）を選ぶ`, { goal: g.id });
  return ok();
}

function evVaultLost(w, { facility }) {
  const f = facility ? w.facilities[facility] : Object.values(w.facilities).find(x => x.kind === '倉' && x.at === 'site' && x.status === '稼働' && w.members[x.owner]?.inNation);
  if (!f || f.kind !== '倉' || f.status !== '稼働' || f.owner === 'enemy') return fail('奪われる倉がない');
  const was = f.owner;
  f.owner = 'enemy'; f.gen += 1; f.status = '奪われた';
  log(w, 'event', `出来事：${label.who(w, was)}の倉（${label.place(f.at)}）が北の国に奪われた。中身（${Object.entries(f.contents).map(([r, v]) => `${label.res(r)} ${v}`).join('・') || 'なし'}）は奪った人の物。向かっている荷は届かず失われる`);
  return ok();
}

function evFortLost(w, { facility }) {
  const f = facility ? w.facilities[facility] : Object.values(w.facilities).find(x => x.kind === '砦' && x.status === '稼働' && w.members[x.owner]?.inNation);
  if (!f || f.kind !== '砦' || f.status !== '稼働') return fail('失う砦がない');
  const was = f.owner;
  const lost = f.troops;
  f.troops = 0; f.owner = 'enemy'; f.status = '奪われた';
  log(w, 'event', `出来事：${label.who(w, was)}の砦（${label.place(f.at)}）が落ち、北の国に奪われた。守備兵 ${lost} は失われた`);
  return ok();
}

function evAbsent(w, { member = 'sota' }) {
  const m = w.members[member];
  if (!m.present) return fail('もう不在');
  m.present = false;
  log(w, 'event', `出来事：${m.name}が不在になった。${m.name}の村・倉・荷車・申し出は${m.name}の物のまま。誰も代わりに動かせない`);
  return ok();
}

function evBack(w, { member }) {
  const m = member ? w.members[member] : Object.values(w.members).find(x => !x.present);
  if (!m || m.present) return fail('不在の人はいない');
  m.present = true; m.lastActive = w.turn;
  log(w, 'event', `${m.name}が戻った`);
  return ok();
}

// ------------------------------------------------------------------ 次に必要な判断

/**
 * その人に今必要な判断の一覧。各判断に「選べること」を並べ、それぞれの結果（consequence）と、
 * 押せないときの理由（reason）を付ける。「待つ」も一つの選択として、何が起きるかを書く。
 */
export function decisionsFor(w, me) {
  const out = [];
  const m = w.members[me];
  if (!m.present) {
    return [{ id: 'absent', title: `${m.name}は不在`, why: '戻るまで、あなたの物は誰も動かせない。卓の仲間には「不在」と見えている', options: [
      { label: '戻る', event: 'back', args: { member: me }, consequence: '自分の判断を再開する', enabled: true },
    ] }];
  }
  for (const g of Object.values(w.goals)) {
    const mineLive = Object.values(w.pledges).filter(p => p.goal === g.id && p.provider === me && isLive(p));
    const isCoord = g.coordinator === me;
    const involved = mineLive.length > 0 || isCoord || g.cosigners.includes(me);

    if (g.status === '提案中' && !g.cosigners.includes(me)) {
      out.push({ id: `cosign-${g.id}`, goal: g.id, title: `「${g.title}」に賛同するか`, why: `${label.who(w, g.proposer)}の提案。賛同が${ADOPT_COSIGNERS}そろうと国の目標になる（今 ${g.cosigners.length}）。賛同しても、何かを出す約束にはならない`, options: [
        { label: '賛同する', act: 'cosign', args: { goal: g.id }, consequence: '国の目標として卓の上に出す。出す物は、あとで自分で決める', enabled: true },
        waitOption('他の人の判断を待つ。賛同が足りなければ、提案はいずれ消える'),
      ] });
    }

    if (g.status === '提案中' || g.status === '準備中') {
      if (g.conflict && !g.conflict.answered) {
        if (isCoord) {
          out.push({ id: `conflict-${g.id}`, goal: g.id, title: '前提が変わった：目標をどうするか', why: g.conflict.text, options: [
            { label: '目的を「交易の中継拠点」に変える', act: 'amend', args: { goal: g.id, purpose: '北の峠の手前に、前線の倉と砦を置き、交易と守りの中継にする', qty: { garrison: 200 }, optional: ['watch'] },
              consequence: '方針変更（新しい版）。守備兵を200に、見張りを任意にする。全員の未発送の申し出が再確認待ちになる', enabled: true },
            { label: 'このまま続ける', act: 'amend', args: { goal: g.id, purpose: `${g.purpose}（構えが変わっても、砦は戦いでは北の国とも戦う）` },
              consequence: '目的の書き方だけ変える。塔は北の国を削らなくなるので、見張りの価値は下がる。仲間は続けるか決め直す', enabled: true },
            { label: '目標を中止する', act: 'closeGoal', args: { goal: g.id, reason: '国の構えが変わったため' },
              consequence: '届いた物は受け取った人の物のまま。未発送の申し出は終わる', enabled: true },
          ] });
        } else if (involved) {
          out.push({ id: `conflict-m-${g.id}`, goal: g.id, title: '前提が変わった', why: `${g.conflict.text}。調整役（${label.who(w, g.coordinator)}）の判断を待つ間も、自分の申し出は自分で決められる`, options: [
            ...mineLive.filter(p => p.qty - p.sent > 0).slice(0, 1).map(p => ({ label: '自分の申し出を取り下げる', act: 'withdraw', args: { pledge: p.id, reason: '構えが変わったため' }, consequence: '未発送分を手元に残す。記録に「取り下げ」が残る', enabled: true })),
            { label: '議会に構えを戻す議題を出す', disabled: true, enabled: false, reason: '試作では未実装。実際の S1 では、投票権のある村が構えの議題を出せる（1村1件まで）', consequence: '' },
            waitOption('調整役が方針を決めるまで待つ。発送済みの荷はそのまま届く'),
          ] });
        }
      }

      if (isCoord && !(g.conflict && !g.conflict.answered)) {
        out.push(...coordinatorDecisions(w, g, me));
        const c = cosignCount(w, g);
        if (g.status === '準備中' && c.controllers < ADOPT_COSIGNERS && !g.belowAck) {
          out.push({ id: `below-${g.id}`, goal: g.id, title: '賛同が採択の数を下回った', why: `今の賛同は${c.villages}村・判断する人${c.controllers}（採択に${ADOPT_COSIGNERS}）。採択は卓の表示のための仮説で、自動では取り消さない。出した申し出と荷は、それぞれの持ち主のまま`, options: [
            { label: 'このまま続ける', act: 'ackBelow', args: { goal: g.id }, consequence: '卓には「賛同が足りない目標」として出る', enabled: true },
            { label: '中止する', act: 'closeGoal', args: { goal: g.id, reason: '賛同が減ったため' }, consequence: '未発送の申し出は終わる。届いた物は受け取った人の物のまま', enabled: true },
          ] });
        }
      }
      if (goalIsLive(g) && !g.coordinator && !w.members[me].expelled) {
        out.push({ id: `volunteer-${g.id}`, goal: g.id, title: `「${g.title}」に調整役がいない`, why: '計画の見直しと依頼をする人がいない。名乗り出ても、人の物は動かせない', options: [
          { label: '調整役に名乗り出る', act: 'volunteer', args: { goal: g.id }, consequence: 'あなたが賛同者にもなり、期限・必要量・依頼を見直せるようになる', enabled: true },
          waitOption('誰かが名乗り出るのを待つ。申し出と発送はそのまま続けられる'),
        ] });
      }
      if (g.status === '準備中' && g.cosigners.includes(me) && !isCoord && coordinatorAbsent(w, g)) {
        out.push({ id: `takeover-${g.id}`, goal: g.id, title: `調整役（${label.who(w, g.coordinator)}）が不在`, why: '計画の見直しが止まっている。引き継げるのは計画の編集だけで、不在の人の物は動かせない', options: [
          { label: '調整役を引き継ぐ', act: 'takeOver', args: { goal: g.id }, consequence: '期限・必要量・依頼をあなたが見直せるようになる', enabled: true },
          waitOption(`${label.who(w, g.coordinator)}が戻るのを待つ`),
        ] });
      }

      for (const n of g.needs) {
        if (n.kind === 'escort' && mineLive.some(p => p.need === 'escort')) continue;
        const prog = needProgress(w, g.id, n.id);
        if (prog.satisfied && n.kind !== 'escort') continue;
        if (w.declined[`${me}|${g.id}|${n.id}`] != null) continue;
        if (mineLive.some(p => p.need === n.id)) continue;
        const c = canPledge(w, me, g.id, n.id);
        if (!c.ok) continue;
        if (n.kind === 'deliver' && prog.onTime >= n.qty) continue;
        if (n.kind === 'watch' && (prog.inTransit || Object.values(w.pledges).some(x => x.goal === g.id && x.need === n.id && isLive(x) && w.members[x.provider].present))) continue;
        if (n.kind === 'garrison' && prog.arrived + prog.inTransit + prog.pledged >= n.qty) continue;
        if (n.kind === 'escort' && (w.reserve[me] < 40 || !Object.values(w.pledges).some(x => x.goal === g.id && destinationOf(w, x, true)?.kind === 'facility' && isLive(x)))) continue;
        out.push({ ...pledgeDecision(w, g, n, me, prog), prio: n.optional ? 4 : 3 });
      }
    }

    const moving = p => Object.values(w.shipments).some(s => s.pledge === p.id && (s.state === '送信済み' || s.state === '輸送中'));
    for (const p of Object.values(w.pledges).filter(p => p.goal === g.id && p.provider === me && (isLive(p) || moving(p)))) out.push(...pledgeDecisions(w, g, p, me));

    if (g.status === '成立' && fortOwnerOf(w, g) === me) {
      out.push({ id: `after-${g.id}`, goal: g.id, title: '拠点が成立した。砦の兵をどうするか', why: '軍は自動では出ない。出すかどうか、どこへかは、砦の持ち主のあなたが決める', options: [
        { label: '砦で守る（何もしない）', wait: true, enabled: true, consequence: '砦の兵は砦のマスの戦いに加わる（S1 の砦の自動の守り）' },
        { label: '砦から峠へ兵100を出す（封じた進軍）', act: 'march', args: { n: 100, to: 'pass', purpose: '砦から出る' }, consequence: '砦の守りは減る。峠で北の国の軍とぶつかるかもしれない', enabled: (fortAt(w, g.site)?.troops ?? 0) >= 100, reason: '砦の兵が100より少ない' },
      ] });
    }
    if (g.status === '期限切れ' || g.status === '中止') out.push(...afterFailure(w, g, me));
  }
  for (const r of Object.values(w.requests)) {
    if (r.to !== me || r.status !== '未回答') continue;
    const g = w.goals[r.goal];
    const n = needOf(w, r.goal, r.need);
    const c = canPledge(w, me, r.goal, r.need);
    out.push({ id: `req-${r.id}`, goal: r.goal, title: `${label.who(w, r.from)}からの依頼：${describeNeed(w, n)}${r.qty ? `（${r.qty}）` : ''}`, why: `${r.text || `「${g.title}」のため`}。断っても罰はない。受けると、申し出として卓に出る`, options: [
      { label: '受ける', act: 'answer', args: { request: r.id, accept: true }, consequence: costLine(w, me, n, r.qty ?? n.qty), enabled: c.ok, reason: c.reason },
      { label: '断る', act: 'answer', args: { request: r.id, accept: false }, consequence: '記録に「断った」が残る。手元の物は自分の村に使える', enabled: true },
    ] });
  }
  for (const v of Object.values(w.votes)) {
    if (v.status !== '投票中' || v.yes.includes(me) || v.no.includes(me)) continue;
    out.push({ id: `vote-${v.id}`, title: `議会：「${v.title}」に投票する`, why: `${label.who(w, v.proposer)}の理由：${v.why}。今 賛成${v.yes.length}・反対${v.no.length}。締め切りターン${v.closesAt}。可決すると、国の目標の前提が変わることがある`, options: [
      { label: '賛成', act: 'vote', args: { vote: v.id, yes: true }, consequence: '北の国と通行できるようになる。国境の塔と柵は北の国を止めなくなる', enabled: true },
      { label: '反対', act: 'vote', args: { vote: v.id, yes: false }, consequence: '戦争の構えのまま。港町の交易は北の峠を通れない', enabled: true },
      waitOption('投票しない。1村1票なので、入れなければ数に入らない'),
    ] });
  }
  const rank = d => d.prio ?? (/^(vote|req|conflict|takeover|risk|delay|lost|reconfirm)/.test(d.id) ? 1 : 2);
  return out.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map(x => x.d);
}

function waitOption(consequence) {
  return { label: '待つ', wait: true, enabled: true, consequence };
}

function fortOwnerOf(w, g) {
  return fortAt(w, g.site)?.owner ?? null;
}

function costLine(w, me, n, qty) {
  if (!n) return '';
  if (n.kind === 'deliver') return `代わりにできたこと：${opportunity(w, me, n.resource, qty)}`;
  if (n.kind === 'build') return `材料：${Object.entries(BUILD_COST[n.building]).map(([r, v]) => `${label.res(r)}${v}`).join('・')}。建物はあなたの物のまま`;
  if (n.kind === 'watch') return '偵察なら兵10を一度だけ。塔ならあなたの物として残る';
  return '';
}

/** 機会費用の言葉。数字は S1 のルールから計算できるものだけ。 */
export function opportunity(w, me, resource, qty) {
  if (resource === 'arms') return `長槍兵 ${Math.floor((qty * 100) / ARMS_PER_100_PIKEMEN)} 人の訓練、または包囲の宣言 ${Math.floor(qty / 50)} 回分（arms.rs）`;
  if (resource === 'stone') return `見張り塔（石材400）の ${(qty / 400).toFixed(1)} 基分、または自分の倉（石材200）${Math.floor(qty / 200)} つ分`;
  if (resource === 'food') return `槍兵 ${Math.floor(qty / FOOD_PER_SPEARMAN)} 人の訓練（食料は仮の値）、または自分の兵の維持`;
  if (resource === 'wood') return `倉（木材200）${Math.floor(qty / 200)} つ分`;
  return `${label.res(resource)} ${qty}`;
}

function pledgeDecision(w, g, n, me, prog) {
  const ben = BENEFITS[me];
  const why = [
    `${n.use}。`,
    n.kind === 'deliver' ? `到着済み ${prog.arrived}／必要 ${n.qty}（輸送中 ${prog.inTransit}${prog.lateTransit ? `、うち期限後に着く ${prog.lateTransit}` : ''}、申し出 ${prog.pledged}）。` : '',
  ].join('');
  const options = [];
  if (n.kind === 'deliver') {
    const have = (w.stock[me][n.resource] ?? 0) - (pledgeTotals(w, me)[n.resource] ?? 0);
    const remain = Math.max(0, n.qty - prog.arrived - prog.inTransit - prog.pledged);
    const canMake = n.resource === 'arms' && facilitiesOf(w, me, '工房').some(f => f.status === '稼働');
    const want = remain || n.qty;
    const q = Math.max(1, have >= want || canMake || have <= 0 ? want : have);
    const toVault = n.to.kind === 'vault-at';
    const ownVault = toVault && vaultsAt(w, n.to.at).find(f => f.owner === me);
    const anyVault = toVault && vaultsAt(w, n.to.at)[0];
    const method = !toVault ? `贈る：着いたら${label.who(w, n.to.member)}の物になる` : ownVault ? '自分の倉に置く：あなたの物のまま' : anyVault ? `倉の持ち主（${label.who(w, anyVault.owner)}）に贈る：着いたらその人の物` : '受け取る倉がまだない。申し出はできるが、倉が建つまで送れない';
    options.push({ label: `${q} を申し出る`, act: 'pledge', args: { goal: g.id, need: n.id, qty: q, cap: q }, form: { kind: 'qty', max: Math.max(have, q), value: q, resource: n.resource },
      consequence: `${method}。${have < q ? `手元は ${Math.max(have, 0)}。足りない分は作るまで「準備中」。` : ''}代わりにできたこと：${opportunity(w, me, n.resource, q)}`, enabled: true });
    if (toVault) options.push({ label: '預ける（持ち主のまま、他人が使う）', enabled: false, reason: '使用権が要る。S1 にはない（②の担当）', consequence: '' });
  } else if (n.kind === 'build') {
    options.push({ label: `自分の${n.building}を建てると申し出る`, act: 'pledge', args: { goal: g.id, need: n.id }, consequence: costLine(w, me, n), enabled: true });
  } else if (n.kind === 'garrison') {
    options.push({ label: `守備兵 ${n.qty} を置くと申し出る`, act: 'pledge', args: { goal: g.id, need: n.id, qty: n.qty }, consequence: `予備 ${w.reserve[me]}。足りない分は自分の村で訓練する（食料）。その間、兵は自分の村の守りに使えない`, enabled: true });
  } else if (n.kind === 'watch') {
    options.push({ label: '偵察を一度出す（短い参加）', act: 'pledge', args: { goal: g.id, need: n.id, method: '偵察' }, consequence: `兵10を${2 * travelTurns(w.members[me].home, n.at)}ターン出す。知らせは${SCOUT_FRESH_TURNS}ターン有効なので、期限の近くにもう一度要るかもしれない`, enabled: w.reserve[me] >= 10, reason: '予備の兵が10より少ない' });
    options.push({ label: '峠に見張り塔を建てると申し出る', act: 'pledge', args: { goal: g.id, need: n.id, method: '塔' }, consequence: costLine(w, me, { kind: 'build', building: '見張り塔' }), enabled: facilitiesOf(w, me, '見張り塔').length < BUILD_LIMIT['見張り塔'] });
  } else if (n.kind === 'escort') {
    options.push({ label: '護衛を申し出る（中身は封）', act: 'pledge', args: { goal: g.id, need: n.id }, consequence: '卓には件数だけが出る。出す兵と場所はあなただけが知る。その兵は護衛の間、他に使えない', enabled: true });
  }
  options.push({ label: n.optional ? '出さない' : '自給を選ぶ（これには出さない）', act: 'decline', args: { goal: g.id, need: n.id }, consequence: ben ? `${ben.alone}` : '手元の物を自分の村に使う', enabled: true });
  return { id: `need-${g.id}-${n.id}`, goal: g.id, title: `必要：${describeNeed(w, n)}`, why, benefit: ben?.join ?? null, options };
}

function pledgeDecisions(w, g, p, me) {
  const out = [];
  const n = needOf(w, g.id, p.need);
  const prog = needProgress(w, g.id, p.need);
  if (p.status === '再確認待ち') {
    out.push({ id: `reconfirm-${p.id}`, goal: g.id, title: `方針が変わった：${describeNeed(w, n)}を続けるか`, why: `「${g.title}」が第${g.version}版になった（${g.history.at(-1)?.changes.join('、')}）。あなたが決めるまで、申し出は数えない`, options: [
      { label: '続ける', act: 'reconfirm', args: { pledge: p.id, keep: true }, consequence: '申し出として数えに戻す', enabled: true },
      { label: '取り下げる', act: 'reconfirm', args: { pledge: p.id, keep: false }, consequence: `未発送分を手元に残す。${p.sent ? `発送済みの ${p.sent} は止まらず、元の行き先へ届く（方針変更は荷を取り消さず、送り先も変えない）` : ''}`, enabled: true },
    ] });
    return out;
  }
  if (p.status === '供給元を失った') {
    const alt = Object.values(w.facilities).find(f => f.kind === '工房' && f.status === '稼働' && f.owner !== me && w.members[f.owner]?.inNation);
    const have = w.stock[me].arms ?? 0;
    out.push({ id: `lost-${p.id}`, goal: g.id, title: '工房を失った：兵器の申し出をどうするか', why: `あなたの工房は奪われた。手元の兵器は ${have}、申し出の残りは ${p.qty - p.sent}`, options: [
      { label: `手元の ${have} だけ送る（量を減らす）`, act: 'dispatch', args: { pledge: p.id, qty: Math.min(have, p.qty - p.sent) }, consequence: '残りは他の人に頼むことになる', enabled: have > 0, reason: '手元に兵器がない' },
      ...(alt ? [{ label: `${label.who(w, alt.owner)}に兵器づくりを頼む`, act: 'request', args: { to: alt.owner, goal: g.id, need: p.need, qty: p.qty - p.sent, text: `私の工房が奪われた。鉱石を送るので、${label.who(w, alt.owner)}の工房で兵器を作って出してほしい` },
        consequence: `依頼になる。受けるかは${label.who(w, alt.owner)}が決める。贈った鉱石は着いたら${label.who(w, alt.owner)}の物、作った兵器も${label.who(w, alt.owner)}の物で、送るのも${label.who(w, alt.owner)}`, enabled: true }] : []),
      ...(alt && (w.stock[me].ore ?? 0) >= 2 ? [{ label: `鉱石 ${Math.min(100, w.stock[me].ore)} を${label.who(w, alt.owner)}に贈る`, act: 'gift', args: { to: alt.owner, resource: 'ore', qty: Math.min(100, w.stock[me].ore), why: `${label.who(w, alt.owner)}の工房で兵器にしてもらうため` },
        consequence: `着いたら${label.who(w, alt.owner)}の物。兵器にするか、どこへ送るかは${label.who(w, alt.owner)}が決める（約束を守らせる仕組みは S1 にない）`, enabled: true }] : []),
      { label: 'ハルの工房を借りて自分で作る', enabled: false, reason: '他人の施設を使う権利（使用権）は S1 にない（②の担当）', consequence: '' },
      { label: '取り下げる', act: 'withdraw', args: { pledge: p.id, reason: '工房を失った' }, consequence: '調整役が、他の人に頼むか量を見直す', enabled: true },
    ] });
    return out;
  }
  if (n.kind === 'deliver' && (p.status === '申し出' || p.status === '一部発送' || p.status === '準備中')) {
    const dest = destinationOf(w, p);
    const have = w.stock[me][n.resource] ?? 0;
    const left = p.qty - p.sent;
    const q = Math.min(have, left);
    const eta = dest ? w.turn + 1 + travelTurns(w.members[me].home, placeOf(w, dest)) : null;
    const late = eta != null && eta > g.deadline;
    const building = !dest && destinationOf(w, p, true);
    out.push({ id: `send-${p.id}`, goal: g.id, title: `発送するか：${label.res(n.resource)}（残り ${left}）`, why: `${dest ? `今送ると、到着見込みはターン${eta}${late ? `。期限（ターン${g.deadline}）に間に合わない` : ''}。` : (building ? `受け取る倉は建設中（ターン${w.facilities[building.id].readyAt}に完成）。` : '受け取る倉がまだない。')}発送しても、着くまでは「到着済み」に数えない`, options: [
      { label: `${q} を送る`, act: 'dispatch', args: { pledge: p.id, qty: q }, form: { kind: 'qty', max: q, value: q, resource: n.resource },
        consequence: `着くまであなたの物。${dest && recipientOf(w, dest) !== me ? `着いたら${label.who(w, recipientOf(w, dest))}の物になる。` : '着いた先はあなたの倉。'}`, enabled: !!dest && q > 0, reason: !dest ? '受け取る倉がまだない' : `手元の${label.res(n.resource)}がない（作っている途中なら、そろうまで待つ）` },
      waitOption(p.status === '準備中' ? '工房で作る。そろったら知らせが出る' : '手元に置いたまま。卓では「申し出」のまま'),
      { label: '取り下げる', act: 'withdraw', args: { pledge: p.id }, consequence: '記録に「取り下げ」が残る。手元の物は自分の村に使える', enabled: true },
    ] });
  }
  if (n.kind === 'build' && p.status === '申し出') {
    const cost = BUILD_COST[n.building];
    const short = Object.entries(cost).filter(([r, v]) => (w.stock[me][r] ?? 0) < v).map(([r, v]) => `${label.res(r)} ${v - (w.stock[me][r] ?? 0)}`);
    out.push({ id: `build-${p.id}`, goal: g.id, title: `${n.building}を建てるか`, why: short.length ? `材料が足りない：${short.join('、')}。届くのを待つか、量を頼む` : `材料はそろっている。建て始めると${BUILD_TURNS[n.building]}ターンで完成`, options: [
      { label: '建て始める', act: 'build', args: { kind: n.building, at: n.at, pledge: p.id }, consequence: `材料を使う。${n.building}はあなたの物。奪われることもある`, enabled: !short.length, reason: `足りない：${short.join('、')}` },
      waitOption('材料が届くのを待つ'),
      { label: '取り下げる', act: 'withdraw', args: { pledge: p.id }, consequence: '別の人が建てるかを、調整役が探す', enabled: true },
    ] });
  }
  if (n.kind === 'garrison' && (p.status === '申し出' || p.status === '一部発送')) {
    const fort = fortAt(w, g.site);
    const left = p.qty - p.sent;
    const reserve = w.reserve[me];
    const opts = [];
    opts.push({ label: `予備の兵 ${Math.min(left, reserve)} を砦に置く`, act: 'garrison', args: { n: Math.min(left, reserve) }, consequence: '次のターンから砦の守りに数える。その兵は村の守りから外れる', enabled: !!fort && fort.owner === me && reserve > 0, reason: !fort ? '砦がまだ稼働していない' : '予備の兵がいない' });
    if (reserve < left) opts.push({ label: `槍兵 ${left - reserve} を訓練する（食料 ${(left - reserve) * FOOD_PER_SPEARMAN}）`, act: 'train', args: { n: left - reserve }, consequence: '自分の食料を使う。足りなければ、食料の倉の持ち主に送ってもらう必要がある', enabled: (w.stock[me].food ?? 0) >= (left - reserve) * FOOD_PER_SPEARMAN, reason: '食料が足りない' });
    opts.push(waitOption('砦の完成と兵の準備を待つ'));
    out.push({ id: `garrison-${p.id}`, goal: g.id, title: `砦に守備兵を置くか（残り ${left}）`, why: `予備の兵 ${reserve}。S1 では、砦に兵を置けるのは砦の持ち主だけ`, options: opts });
  }
  if (n.kind === 'watch' && p.status === '申し出') {
    const tower = p.method === '見張り塔を建てる';
    out.push({ id: `watch-${p.id}`, goal: g.id, title: tower ? '見張り塔を建てるか' : '偵察を出すか', why: tower ? '塔は残るので、期限まで見張りが続く' : `偵察の知らせは${SCOUT_FRESH_TURNS}ターン有効。期限（ターン${g.deadline}）の近くで出すほうがよい`, options: [
      tower ? { label: '峠に見張り塔を建て始める', act: 'build', args: { kind: '見張り塔', at: 'pass', pledge: p.id }, consequence: costLine(w, me, { kind: 'build', building: '見張り塔' }), enabled: Object.entries(BUILD_COST['見張り塔']).every(([r, v]) => (w.stock[me][r] ?? 0) >= v), reason: '材料が足りない' }
        : { label: '偵察を出す', act: 'scout', args: { at: 'pass' }, consequence: `兵10を出す。戻りはターン${w.turn + 2 * travelTurns(w.members[me].home, 'pass')}`, enabled: w.reserve[me] >= 10, reason: '予備の兵が足りない' },
      waitOption('あとで出す'),
      { label: '取り下げる', act: 'withdraw', args: { pledge: p.id }, consequence: '他の人が見張りを引き受けるかは、調整役が探す', enabled: true },
    ] });
  }
  if (n.kind === 'escort' && p.status === '申し出') {
    out.push({ id: `escort-${p.id}`, goal: g.id, title: '護衛を出すか（封）', why: '峠の手前で待ち構える。どの荷車を守るかは他人に見えない', options: [
      { label: '兵40を峠の手前へ出す', act: 'march', args: { n: 40, to: 'site', purpose: '護衛' }, consequence: 'その兵は護衛の間、他に使えない。襲撃があれば戦う', enabled: w.reserve[me] >= 40, reason: '予備の兵が40より少ない' },
      waitOption('荷車が出るまで待つ'),
      { label: '取り下げる', act: 'withdraw', args: { pledge: p.id }, consequence: '卓の件数が減る', enabled: true },
    ] });
  }
  // 自分の荷車が遅れている／送れなかった
  for (const s of Object.values(w.shipments)) {
    if (s.pledge !== p.id) continue;
    if ((s.state === '輸送中' || s.state === '送信済み') && s.delay > 0 && !s.acknowledged && goalIsLive(g)) {
      const late = s.eta > g.deadline;
      const near = vaultsAt(w, 'site').filter(f => f.owner === me);
      const altFrom = Object.values(w.members).filter(x => x.id !== me && x.present && x.playable && x.inNation && x.id !== n.consumer && (w.stock[x.id][s.resource] ?? 0) > 0)
        .sort((a, b) => travelTurns(a.home, placeOf(w, s.to)) - travelTurns(b.home, placeOf(w, s.to)));
      out.push({ id: `delay-${s.id}`, goal: g.id, title: `あなたの荷車が遅れている（${label.res(s.resource)} ${s.qty}）`, why: `到着見込みはターン${s.eta}${late ? `。期限（ターン${g.deadline}）に間に合わない` : ''}。理由：${s.reason}`, options: [
        { label: '手元から追加で送る', act: 'pledgeMore', enabled: (w.stock[me][s.resource] ?? 0) > 0 && goalIsLive(g) && !['準備中', '再確認待ち', '供給元を失った'].includes(p.status), reason: !goalIsLive(g) ? `目標は「${g.status}」` : (w.stock[me][s.resource] ?? 0) > 0 ? `申し出は「${p.status}」。先にそれを決める` : `手元の${label.res(s.resource)}がない`, consequence: `新しい荷も同じ道なら同じく遅れうる。追加分も着くまであなたの物`, args: { goal: g.id, need: p.need, qty: Math.min(s.qty, w.stock[me][s.resource] ?? 0) } },
        { label: `近くの人に頼む（${altFrom.slice(0, 1).map(x => x.name).join('') || 'なし'}）`, act: 'request', args: { to: altFrom[0]?.id, goal: g.id, need: p.need, qty: s.qty, text: '私の荷車が遅れている。近い所から出してもらえないか' }, consequence: '受けるかは頼まれた人が決める。遅れた荷も後で届くので、余りが出る（余りは受け取った人の物）', enabled: altFrom.length > 0, reason: '頼める人がいない' },
        { label: '遅れを受け入れる', act: 'ack', args: { shipment: s.id }, consequence: late ? '調整役に期限の見直しを任せる' : '期限には間に合うので、そのまま待つ', enabled: true },
      ] });
    }
  }
  return out;
}

function coordinatorDecisions(w, g, me) {
  const out = [];
  const risks = [];
  for (const n of g.needs) {
    if (n.optional) continue;
    const pr = needProgress(w, g.id, n.id);
    if (pr.satisfied) continue;
    if (n.kind === 'deliver' && pr.onTime < n.qty) risks.push({ n, pr, gap: n.qty - pr.onTime });
    if ((n.kind === 'build' || n.kind === 'watch') && !pr.inTransit && !pr.pledged) risks.push({ n, pr, gap: 1 });
    if (n.kind === 'garrison' && pr.arrived + pr.inTransit + pr.pledged < n.qty) risks.push({ n, pr, gap: n.qty - pr.arrived - pr.inTransit - pr.pledged });
  }
  if (!risks.length) return out;
  const urgency = r => (r.n.kind === 'deliver' || r.n.kind === 'garrison' ? 0 : 1);
  risks.sort((a, b) => urgency(a) - urgency(b));
  const lines = risks.map(({ n, pr, gap }) => `${describeNeed(w, n)}：${n.kind === 'deliver' ? `期限までに届く見込み ${pr.onTime}／${n.qty}（不足 ${gap}${pr.lateTransit ? `、遅れて期限後に着く ${pr.lateTransit}` : ''}）` : '引き受け手がいない'}`);
  const first = risks[0];
  const askable = Object.values(w.members).filter(x => x.id !== me && x.id !== first.n.consumer && x.inNation && x.present && x.playable && !Object.values(w.pledges).some(p => p.goal === g.id && p.need === first.n.id && p.provider === x.id && isLive(p)) && canPledge(w, x.id, g.id, first.n.id).ok)
    .filter(x => first.n.kind !== 'deliver' || (w.stock[x.id][first.n.resource] ?? 0) > 0 || facilitiesOf(w, x.id, '工房').length);
  const latest = Math.max(...Object.values(w.shipments).filter(s => w.pledges[s.pledge]?.goal === g.id && (s.state === '輸送中' || s.state === '送信済み')).map(s => s.eta), g.deadline);
  const options = [];
  const destPlace = first.n.kind === 'deliver' ? (first.n.to.kind === 'village' ? w.members[first.n.to.member].home : first.n.to.at) : g.site;
  askable.sort((a, b) => travelTurns(a.home, destPlace) - travelTurns(b.home, destPlace));
  for (const x of askable.slice(0, 3)) {
    options.push({ label: `${x.name}に頼む：${describeNeed(w, first.n)}`, act: 'request', args: { to: x.id, goal: g.id, need: first.n.id, qty: first.n.kind === 'deliver' ? Math.min(first.gap, Math.max(1, w.stock[x.id][first.n.resource] ?? first.gap)) : undefined },
      consequence: `${x.name}が受けるか決める。断られても罰はない`, enabled: true });
  }
  options.push({ label: `期限を延ばす（ターン${latest + 2}へ）`, act: 'amend', args: { goal: g.id, deadline: latest + 2 }, consequence: '方針変更。全員の未発送の申し出が再確認待ちになる。北の国が先に峠を越えるかもしれない', enabled: latest + 2 > g.deadline, reason: '遅れた荷がない' });
  if (g.shrink) {
    const nq = id => g.needs.find(n => n.id === id);
    const shrunk = nq('food')?.qty <= g.shrink.food && nq('garrison')?.qty <= g.shrink.garrison && (!g.shrink.watchOptional || nq('watch')?.optional);
    options.push({ label: `縮小案にする（食料${g.shrink.food}・守備兵${g.shrink.garrison}${g.shrink.watchOptional ? '・見張りは任意' : ''}）`, act: 'amend', args: { goal: g.id, qty: { food: Math.min(g.shrink.food, nq('food')?.qty ?? g.shrink.food), garrison: Math.min(g.shrink.garrison, nq('garrison')?.qty ?? g.shrink.garrison) }, optional: g.shrink.watchOptional ? ['watch'] : [] },
      consequence: '方針変更。守りは弱くなるが、期限に間に合いやすい。全員が続けるか決め直す', enabled: !shrunk, reason: 'もう縮小案になっている' });
  }
  options.push(waitOption('このまま様子を見る。期限を過ぎると「期限切れ」になる'));
  out.push({ id: `risk-${g.id}`, goal: g.id, title: 'このままだと期限にそろわない', why: lines.join('／'), options });
  return out;
}

function afterFailure(w, g, me) {
  const got = Object.values(w.shipments).filter(s => s.arrivedOwner === me && s.owner !== me && !s.returned && !s.kept && w.pledges[s.pledge]?.goal === g.id);
  const out = [];
  if (got.length) {
    const s = got[0];
    out.push({ id: `return-${g.id}`, goal: g.id, title: `受け取った物をどうするか（${label.who(w, s.owner)}の${label.res(s.resource)} ${s.qty}）`, why: `「${g.title}」は${g.status}。届いた物はあなたの物。返すかどうかはあなたが決める（仕組みは強制しない）。記録は誰でも見られる`, options: [
      { label: '送り主に返す', act: 'returnGift', args: { to: s.owner, resource: s.resource, qty: Math.min(s.qty, w.stock[me][s.resource] ?? 0), returnOf: s.id }, consequence: '荷車で返す。着けば送り主の物', enabled: (w.stock[me][s.resource] ?? 0) > 0, reason: 'もう使ってしまった' },
      { label: '自分の守りに使う', act: 'keep', args: { shipment: s.id }, enabled: true, consequence: '手元に残す。次に頼むとき、相手は記録を見て判断する' },
    ] });
  }
  return out;
}

// pledgeMore と ack は、判断の選択肢から呼ばれる小さな補助
/** 追加で送る。先にすべてを確かめ、通るときだけ世界を変える。 */
ACTIONS.pledgeMore = (w, actor, { goal, need, qty }) => {
  qty = toInt(qty);
  if (!(qty > 0)) return fail('量を1以上にする');
  if (!goalIsLive(w.goals[goal])) return fail('その目標は、もう申し出を受け付けていない');
  const n = needOf(w, goal, need);
  if (!n || n.kind !== 'deliver') return fail('物を送る必要ではない');
  if ((w.stock[actor][n.resource] ?? 0) < qty) return fail(`手元の${label.res(n.resource)}が足りない`);
  const mine = Object.values(w.pledges).filter(p => p.goal === goal && p.need === need && p.provider === actor);
  const open = mine.find(isLive);
  if (open && !['申し出', '一部発送'].includes(open.status)) return fail(`今の申し出は「${open.status}」。先にそれを決める`);
  const base = open ?? mine.find(p => p.status === '発送済み');
  if (!destinationOf(w, base ?? { goal, need, provider: actor })) return fail('受け取る倉がまだない');
  if (base) {
    base.qty += qty; base.cap = Math.max(base.cap, base.qty);
    base.status = '一部発送';
    return dispatch(w, actor, { pledge: base.id, qty });
  }
  const r = pledge(w, actor, { goal, need, qty, cap: qty });
  if (!r.ok) return r;
  return dispatch(w, actor, { pledge: r.pledge, qty });
};
/** 倉の持ち主が、倉の中身を誰かの村へ送る（使う）。期限の前に出すと、目標の条件が崩れることがある。 */
ACTIONS.sendFromVault = (w, actor, { facility, resource, qty, to }) => {
  const f = w.facilities[facility];
  if (!f || f.kind !== '倉' || f.owner !== actor || f.status !== '稼働') return fail('自分の稼働中の倉ではない');
  qty = toInt(qty);
  if (!(qty > 0)) return fail('量を1以上にする');
  if (!RESOURCES[resource] || (f.contents[resource] ?? 0) < qty) return fail('倉に足りない');
  if (!w.members[to]) return fail('送り先が正しくない');
  f.contents[resource] -= qty;
  const s = { id: nextId(w, 's'), pledge: null, owner: actor, resource, qty, from: f.at, to: { kind: 'village', member: to }, sentAt: w.turn, state: '送信済み',
    eta: w.turn + 1 + travelTurns(f.at, w.members[to].home), delay: 0, reason: null, why: '倉から送る', arrivedOwner: null, toGen: null };
  w.shipments[s.id] = s;
  log(w, 'ship', `${label.who(w, actor)}が自分の倉（${label.place(f.at)}）から${label.who(w, to)}へ${label.res(resource)} ${qty} を送った（着けば${label.who(w, to)}の物）`);
  return ok({ shipment: s.id });
};
ACTIONS.keep = (w, actor, { shipment }) => {
  const s = w.shipments[shipment];
  if (!s || s.arrivedOwner !== actor || s.returned || s.kept) return fail('決める荷ではない');
  s.kept = true;
  log(w, 'ship', `${label.who(w, actor)}は、${label.who(w, s.owner)}から届いた${label.res(s.resource)} ${s.qty} を返さずに使うことにした`);
  return ok();
};
ACTIONS.ackBelow = (w, actor, { goal }) => {
  const g = w.goals[goal];
  if (!g || g.coordinator !== actor) return fail('調整役ではない');
  g.belowAck = true;
  return ok();
};
ACTIONS.ack = (w, actor, { shipment }) => {
  const s = w.shipments[shipment];
  if (!s || s.owner !== actor) return fail('自分の荷車ではない');
  s.acknowledged = true;
  return ok();
};

// ------------------------------------------------------------------ 検査用

/** 物の総量（村・倉・荷車・失われた・奪われた）。工房と建設と訓練の出入りを除けば保存される。 */
export function inventory(w, resource) {
  let villages = 0, vaults = 0, moving = 0, gone = 0;
  for (const st of Object.values(w.stock)) villages += st[resource] ?? 0;
  for (const f of Object.values(w.facilities)) vaults += f.contents[resource] ?? 0;
  for (const s of Object.values(w.shipments)) {
    if (s.resource !== resource) continue;
    if (s.state === '送信済み' || s.state === '輸送中') moving += s.qty;
    if (s.state === '失われた' || s.state === '奪われた') gone += s.qty;
    if (s.overflow) gone += s.overflow;
  }
  return { villages, vaults, moving, gone, total: villages + vaults + moving + gone };
}

/**
 * 判断の選択肢を実行する（画面とテストが同じ道を通るため）。args を上書きしたいとき（量の入力）は over を渡す。
 * 「待つ」は世界を変えない。
 */
export function perform(w, me, option, over = {}) {
  if (!option || option.enabled === false) return fail(option?.reason || '選べない');
  if (option.wait) return ok({ waited: true });
  if (option.event) return inject(w, option.event, { ...option.args, ...over });
  return act(w, me, option.act, { ...option.args, ...over });
}
