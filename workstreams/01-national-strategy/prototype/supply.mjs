// 国際供給網の試作：共同成果と、各人・各国の評価を分けて数える。行動と時間は model.mjs をそのまま使う。
//
// 守っていること（docs/14-international-supply.ja.md）：
//   1. 国籍で参加を強制も禁止もしない。物を動かせるのは持ち主だけ。交換は両方の持ち主の同意で成立する。
//   2. 共同成果は「他の人から届き（確定した到着だけ）、受け取った人が実際に使った量」で数える。
//      送った量・取引の回数・往復は数えない。現実の役に立ったかまでは判定しない。
//   3. 共同成果・個人の評価・国の評価は別々に記録する。報酬・賞金はない。
//   4. ②の試作で扱えるのは「素材」と「生産済みの兵器」の交換だけ。それ以外は未実装の契約として閉じる。

import { act, advance, inject, perform as performModel, label, TIER_UP, workshopCost } from './model.mjs';
import {
  SUPPLY_MEMBERS, SUPPLY_STOCK, SUPPLY_RESERVE, SUPPLY_FACILITIES, SUPPLY_TRAVEL, SUPPLY_NATIONS,
  PERSONAL_GOALS, NATION_GOALS, JOINT, DEAL_TEMPLATES, CLOSED_DEALS,
} from './scenario-supply.mjs';

const ok = (x = {}) => ({ ok: true, ...x });
const fail = error => ({ ok: false, error });

/** 供給網の世界（固定の配置）。model.mjs の act・advance・inject がそのまま使える形。 */
export function createSupplyWorld() {
  const w = {
    turn: 0,
    nation: { id: 'mixed', name: '三国の交易路', stance: {} },
    stanceNames: {},
    members: Object.fromEntries(SUPPLY_MEMBERS.map(m => [m.id, {
      ...m, playable: true, kind: 'human', present: true, lastActive: 0, inNation: true, expelled: false, tier: '村',
    }])),
    stock: structuredClone(SUPPLY_STOCK),
    reserve: { ...SUPPLY_RESERVE },
    facilities: Object.fromEntries(SUPPLY_FACILITIES.map(f => [f.id, { ...f, status: '稼働', contents: {}, troops: 0, readyAt: 0, gen: 0 }])),
    goals: {}, pledges: {}, shipments: {}, requests: {}, votes: {}, marches: {}, scouts: [], declined: {},
    log: [], seq: 1, offers: {}, consumed: [],
    travelOverride: { ...SUPPLY_TRAVEL },
    supply: { left: {}, answeredNation: {}, joint: { status: '未達成', achievedAt: null, closedAt: null } },
  };
  w.log.push({ turn: 0, kind: 'goal', text: `共同成果「三国の交易路が使われる」：他の人から届いて実際に使った量が${JOINT.perPerson}以上の人が、${JOINT.nations}か国・${JOINT.people}人以上（ターン${JOINT.deadline}まで）。報酬はない` });
  return w;
}

// ------------------------------------------------------------------ 数え方

/** 確定した到着だけ（④で確かめられていない到着は数えない）。 */
export const isVerifiedArrival = s => s.state === '到着済み' && s.verified !== false;

/**
 * 人ごとの「使われた交易」（クレジット）。資源ごとに、確定した到着・送り・消費を時間の順にたどる帳簿で数える。
 * 送りは受け取った分から先に減らし（通り抜け・往復は数えない）、消費は帳簿の上で自分の物から先に使ったとみなす。
 * これは混ざった在庫の帰属の規則で、受け取った物が本当に必要だったことの証明ではない（docs 15章 15-3）。
 */
export function credits(w) {
  const out = {};
  const seqOf = s => Number(String(s.id).replace(/\D/g, '')) || 0;
  for (const id of Object.keys(w.members)) {
    // 出来事を時間の順に並べる。同じターンの中は：工房の消費 → 到着 → 行動（送る・消費）の順（model.mjs の step と行動の順）
    const evs = [];
    const per = {};
    const touch = r => (per[r] ??= { received: 0, sent: 0, used: 0, credit: 0, unverified: 0, ownUsed: 0, net: 0 });
    for (const s of Object.values(w.shipments)) {
      if (s.to?.kind !== 'village') continue;
      if (s.to.member === id && s.owner !== id) {
        if (isVerifiedArrival(s)) evs.push({ t: s.arrivedAt, ph: 1, q: seqOf(s), kind: 'in', r: s.resource, v: s.qty - (s.overflow ?? 0) });
        else if (s.state === '到着済み') touch(s.resource).unverified += s.qty;
      }
      if (s.owner === id && s.to.member !== id && s.state !== '送信失敗') evs.push({ t: s.sentAt, ph: 2, q: seqOf(s), kind: 'out', r: s.resource, v: s.qty });
    }
    for (const c of w.consumed ?? []) {
      if (c.who !== id) continue;
      for (const [r, v] of Object.entries(c.cost)) evs.push({ t: c.turn, ph: c.phase ?? 2, q: c.seq ?? 0, kind: 'use', r, v, before: c.before?.[r] ?? v });
    }
    evs.sort((a, b) => a.t - b.t || a.ph - b.ph || a.q - b.q);
    // pool：他の人から受け取って、まだ使っても送ってもいない量
    const pool = {};
    for (const e of evs) {
      const p = touch(e.r);
      const have = pool[e.r] ?? 0;
      if (e.kind === 'in') { p.received += e.v; pool[e.r] = have + e.v; }
      else if (e.kind === 'out') { p.sent += e.v; pool[e.r] = have - Math.min(have, e.v); }   // 受け取った物から先に送る（通り抜け）
      else {
        // 帳簿の上で自分の物から先に使う。自分の物で足りなかった分だけを、受け取った物を使った分とする
        p.used += e.v;
        const own = Math.max(0, e.before - have);
        const fromOthers = Math.min(have, Math.max(0, e.v - own));
        p.credit += fromOthers;
        p.ownUsed += e.v - fromOthers;
        pool[e.r] = have - fromOthers;
      }
    }
    let total = 0;
    for (const [r, p] of Object.entries(per)) { p.net = Math.max(0, p.received - p.sent); total += p.credit; void r; }
    out[id] = { total, per };
  }
  return out;
}

/** 共同成果の判定（記録だけ。報酬はない）。 */
export function jointStatus(w) {
  const cr = credits(w);
  const qualified = Object.entries(cr).filter(([, c]) => c.total >= JOINT.perPerson).map(([id]) => id);
  const nations = new Set(qualified.map(id => w.members[id].nation));
  const controllers = new Set(qualified.map(id => w.members[id].controller ?? id));
  const met = controllers.size >= JOINT.people && nations.size >= JOINT.nations;
  return { met, qualified, nations: [...nations], people: controllers.size, credits: cr };
}

/** 個人の評価（本人の状態だけで判定）。 */
export function personalStatus(w, id) {
  const g = PERSONAL_GOALS[id];
  const m = w.members[id];
  if (!g || g.kind === 'none') return { goal: g?.text ?? '', done: null, progress: '—' };
  if (g.kind === 'tier') return { goal: g.text, done: m.tier === g.tier, progress: m.tier === g.tier ? '町になった' : m.tierUpAt != null ? `昇格中（ターン${m.tierUpAt}に完成）` : '村のまま' };
  if (g.kind === 'workshops') {
    const f = Object.values(w.facilities).find(x => x.kind === '工房' && (x.owner === id || x.lostBy === id));
    const copies = f && f.status === '稼働' ? f.copies : 0;
    return { goal: g.text, done: copies >= g.copies, progress: f ? `${copies}基${f.status !== '稼働' ? `（${f.status}）` : ''}` : '工房なし' };
  }
  if (g.kind === 'trained') {
    const n = (w.consumed ?? []).filter(c => c.who === id && c.sink === '訓練：長槍兵').reduce((a, c) => a + (c.cost.arms ?? 0) * 2, 0);
    return { goal: g.text, done: n >= g.n, progress: `${n}／${g.n}` };
  }
  return { goal: g.text, done: null, progress: '—' };
}

/** 国の評価（国ごとの目標。共同成果とは別。国は持ち主の物を動かせない）。 */
export function nationStatus(w, nation) {
  const ms = Object.values(w.members).filter(m => m.nation === nation);
  if (nation === 'A') {
    const arms = ms.reduce((a, m) => a + (w.stock[m.id].arms ?? 0), 0);
    return { goal: NATION_GOALS.A.text, done: arms >= NATION_GOALS.A.wants.qty, progress: `A国の村の兵器 ${arms}／${NATION_GOALS.A.wants.qty}` };
  }
  if (nation === 'B') {
    const ore = credits(w).tou.per.ore;
    const fromB = Object.values(w.shipments).filter(s => s.to?.member === 'tou' && s.resource === 'ore' && isVerifiedArrival(s) && w.members[s.owner].nation === 'B').reduce((a, s) => a + s.qty, 0);
    const all = ore?.received ?? 0;
    return { goal: NATION_GOALS.B.text, done: all > 0 ? fromB >= all : null, progress: all ? `トウに届いた鉱石のうちB国から ${fromB}／${all}` : 'まだ鉱石は届いていない' };
  }
  if (nation === 'C') {
    const partners = new Set(Object.values(w.offers ?? {}).filter(o => o.status === '成立' && (o.from === 'rin' || o.to === 'rin')).map(o => w.members[o.from === 'rin' ? o.to : o.from].nation));
    return { goal: NATION_GOALS.C.text, done: partners.size >= 2, progress: `リンが交換した相手の国 ${partners.size}／2（回数ではなく国の数）` };
  }
  return { goal: '', done: null, progress: '—' };
}

/** 共同成果の一区切りを記録する（達成は期限までに限る。一度記録したら変えない）。 */
function checkJoint(w) {
  const j = w.supply.joint;
  if (j.status !== '未達成') return;
  const st = jointStatus(w);
  if (st.met && w.turn <= JOINT.deadline) {
    j.status = '達成'; j.achievedAt = w.turn; j.qualified = st.qualified;
    w.log.push({ turn: w.turn, kind: 'goal', text: `共同成果「三国の交易路が使われる」を達成（${st.qualified.map(id => w.members[id].name).join('・')}。${st.nations.length}か国）。ここで共同成果は一区切り。個人と国の評価は別に続く` });
  } else if (w.turn >= JOINT.deadline) {
    j.status = '期限切れ'; j.closedAt = w.turn;
    w.log.push({ turn: w.turn, kind: 'goal', text: `共同成果は期限（ターン${JOINT.deadline}）までに達成されなかった。届いた物・建てた物は、それぞれの持ち主の物のまま` });
  }
}

/** ターンを進める。期限の過ぎた申し出は「期限切れ」にし、共同成果の一区切りを記録する。 */
export function advanceSupply(w, n = 1) {
  for (let i = 0; i < n; i++) {
    advance(w, 1);
    for (const o of Object.values(w.offers)) if (o.status === '申し出中' && w.turn > o.until) o.status = '期限切れ';
    checkJoint(w);
  }
  return w;
}

// ------------------------------------------------------------------ 出来事

export const SUPPLY_EVENTS = {
  delay: { title: '一人が遅れる', detail: '最後に出た荷車が8ターン遅れる', fact: '仮（S1 の遅れの主な原因は、行き先の決着待ちなど）' },
  terms: { title: '条件を変える', detail: 'トウが、自分あての申し出を断り、鉱石を1.5倍にした申し出を返す', fact: '成立済みの交換には影響しない' },
  facility: { title: '施設を失う', detail: 'トウの工房が奪われる', fact: '仮。手元の兵器は残るが、もう作れない' },
  leave: { title: '途中で退出する', detail: 'リンが交易路から抜ける（申し出をすべて取り下げる）', fact: '成立済みの交換の荷車はそのまま届く' },
  unverified: { title: '到着が未検証', detail: '最後に着いた荷が、④でまだ確かめられていない', fact: '共同成果の数には入れない（確かめられたら入る）' },
  verify: { title: '到着を確かめる', detail: '未検証の到着を、④で確かめた扱いにする', fact: '試作の操作' },
  absent: { title: '持ち主の不在', detail: 'トウが不在になる', fact: '不在の人の物は誰も動かせない' },
  back: { title: '不在から戻る', detail: '不在の人が戻る', fact: '試作の操作' },
};

export function injectSupply(w, kind, args = {}) {
  const log = text => w.log.push({ turn: w.turn, kind: 'event', text });
  if (kind === 'delay') return inject(w, 'delay', { turns: 8 });
  if (kind === 'facility') return inject(w, 'facility', { facility: 'ws-tou' });
  if (kind === 'absent') return inject(w, 'absent', { member: 'tou' });
  if (kind === 'back') return inject(w, 'back', { member: args.member });
  if (kind === 'terms') {
    const offers = Object.values(w.offers).filter(o => o.to === 'tou' && o.status === '申し出中');
    if (!offers.length) return fail('トウあての申し出がない（先に誰かがトウに申し出る）');
    if (!w.members.tou.present) return fail('トウは不在');
    for (const o of offers) {
      o.status = '断られた';
      // 返すのは、手元にある分だけ。相手に求める量は、元の条件の1.5倍の割合
      const have = w.stock.tou[o.want.res] ?? 0;
      const give = Math.min(have, o.want.qty);
      if (give <= 0) { log(`出来事：トウが${w.members[o.from].name}の申し出を断った（${label.res(o.want.res)}が手元になく、条件を変えて返せない）`); continue; }
      const want = Math.ceil(o.give.qty * 1.5 * (give / o.want.qty));
      log(`出来事：トウが${w.members[o.from].name}の申し出を断り、条件を変えて返した（${label.res(o.want.res)} ${give} に ${label.res(o.give.res)} ${want}）`);
      act(w, 'tou', 'offerExchange', { to: o.from, give: { res: o.want.res, qty: give }, want: { res: o.give.res, qty: want } });
    }
    return ok();
  }
  if (kind === 'leave') {
    if (w.supply.left.rin) return fail('リンはもう抜けている');
    w.supply.left.rin = w.turn;
    for (const o of Object.values(w.offers)) {
      if (o.status !== '申し出中') continue;
      if (o.from === 'rin') o.status = '取り下げ';
      if (o.to === 'rin') o.status = '断られた';
    }
    log('出来事：リンが交易路から抜けた。申し出はすべて取り下げ・お断り。成立済みの交換の荷車はそのまま届き、着けば受け取った人の物');
    return ok();
  }
  if (kind === 'unverified') {
    const s = args.shipment ? w.shipments[args.shipment]
      : Object.values(w.shipments).filter(x => x.state === '到着済み' && x.verified !== false).sort((a, b) => b.arrivedAt - a.arrivedAt)[0];
    if (!s || s.state !== '到着済み' || s.verified === false) return fail('まだ着いた荷がない');
    s.verified = false;
    log(`出来事：${w.members[s.owner].name}の${label.res(s.resource)} ${s.qty} の到着は、④でまだ確かめられていない。共同成果の数には入れない`);
    return ok();
  }
  if (kind === 'verify') {
    const s = Object.values(w.shipments).find(x => x.verified === false);
    if (!s) return fail('未検証の到着はない');
    s.verified = true;
    log(`${w.members[s.owner].name}の${label.res(s.resource)} ${s.qty} の到着が確かめられた`);
    return ok();
  }
  return fail('知らない出来事');
}

// ------------------------------------------------------------------ 判断

const travelOf = (w, a, b) => {
  const o = w.travelOverride;
  return o[`${a}|${b}`] ?? o[`${b}|${a}`] ?? 10;
};

/**
 * その人の判断。交渉（申し出・応答・取り下げ）、相手選び（見本の中の別の相手）、費用（何を渡すか）、
 * 目標の行動（昇格・工房・訓練）、国からの頼み、抜ける・何もしない。閉じた選択肢には理由を付ける。
 */
export function supplyDecisions(w, me) {
  const m = w.members[me];
  const out = [];
  if (!m.present) return [{ id: 'absent', title: `${m.name}は不在`, why: '戻るまで、あなたの物は誰も動かせない', options: [{ label: '戻る', event: 'back', enabled: true, consequence: '判断を再開する' }] }];
  const left = w.supply.left[me] != null;
  const goal = PERSONAL_GOALS[me];
  // 自分あての申し出
  for (const o of Object.values(w.offers)) {
    if (o.to !== me || o.status !== '申し出中') continue;
    const can = (w.stock[me][o.want.res] ?? 0) >= o.want.qty;
    const late = w.turn > o.until;
    const fromAway = !w.members[o.from].present;
    const fromShort = (w.stock[o.from][o.give.res] ?? 0) < o.give.qty;
    const t = travelOf(w, w.members[o.from].home, m.home);
    out.push({ id: `offer-${o.id}`, title: `${w.members[o.from].name}（${SUPPLY_NATIONS[w.members[o.from].nation]}）からの交換の申し出`, why: `あなたが${label.res(o.want.res)} ${o.want.qty} を渡し、${label.res(o.give.res)} ${o.give.qty} を受け取る。受けた時点で両方の荷車が出る（片方だけ持ち逃げはできない）。届くまで${t}ターン。②の交換権（模擬）`, options: [
      { label: '受ける', act: 'answerExchange', args: { offer: o.id, accept: true }, enabled: can && !late && !fromAway && !fromShort,
        reason: late ? '期限が過ぎた' : fromAway ? `${w.members[o.from].name}が不在（本人の在庫は動かせない）` : fromShort ? `${w.members[o.from].name}の${label.res(o.give.res)}がもう足りない` : `手元の${label.res(o.want.res)}が足りない（${w.stock[me][o.want.res] ?? 0}）`, consequence: `代わりにできたこと：${label.res(o.want.res)} ${o.want.qty} を自分の${goal?.text ?? '目標'}に使う` },
      { label: '断る', act: 'answerExchange', args: { offer: o.id, accept: false }, enabled: true, consequence: '断っても罰はない。相手は別の相手を探すか、条件を変える' },
    ] });
  }
  // 自分の出している申し出
  for (const o of Object.values(w.offers)) {
    if (o.from !== me || o.status !== '申し出中') continue;
    out.push({ id: `mine-${o.id}`, title: `出している申し出：${w.members[o.to].name}へ`, why: `${label.res(o.give.res)} ${o.give.qty} と ${label.res(o.want.res)} ${o.want.qty}。相手が受けるまで、何も動かない（ターン${o.until}まで）`, options: [
      { label: '取り下げる', act: 'withdrawOffer', args: { offer: o.id }, enabled: true, consequence: '成立していないので何も失わない。別の相手に申し出られる' },
      { label: '待つ', wait: true, enabled: true, consequence: '相手の返事を待つ' },
    ] });
  }
  // 見本の申し出（相手選び・費用の判断）
  if (!left) {
    const opts = [];
    for (const d of DEAL_TEMPLATES.filter(x => x.from === me)) {
      if (w.supply.left[d.to] != null) continue;
      const exists = Object.values(w.offers).some(o => o.from === me && o.to === d.to && o.give.res === d.give.res && o.want.res === d.want.res && ((o.status === '申し出中' && w.turn <= o.until) || o.status === '成立'));
      if (exists) continue;
      const have = w.stock[me][d.give.res] ?? 0;
      const other = w.members[d.to];
      opts.push({ label: `${other.name}（${SUPPLY_NATIONS[other.nation]}）に：${label.res(d.give.res)} ${d.give.qty} と ${label.res(d.want.res)} ${d.want.qty}`, act: 'offerExchange', args: { to: d.to, give: d.give, want: d.want },
        enabled: have >= d.give.qty, reason: `手元の${label.res(d.give.res)}は ${have}（交換で手に入れてから）`,
        consequence: `${d.why}。届くまで${travelOf(w, m.home, other.home)}ターン。相手が受けなければ何も起きない` });
    }
    for (const c of CLOSED_DEALS.filter(x => x.who[0] === me)) opts.push({ label: c.label, enabled: false, reason: c.reason, consequence: '' });
    if (opts.length) out.push({ id: 'deals', title: '誰と、何を条件に組むか', why: '交換は両方の持ち主が同意したときだけ成立する。相手の国は問わない', options: [...opts, { label: '今は組まない（自給）', wait: true, enabled: true, consequence: goalSelfText(me) }] });
  }
  // 目標の行動
  if (goal?.kind === 'tier' && m.tier === '村' && m.tierUpAt == null) {
    const c = TIER_UP['村'].cost;
    const short = Object.entries(c).filter(([r, v]) => (w.stock[me][r] ?? 0) < v).map(([r, v]) => `${label.res(r)} ${v - (w.stock[me][r] ?? 0)}`);
    out.push({ id: 'tier', title: '村を町にするか', why: `要るもの：木材${c.wood}・石材${c.stone}・金${c.gold}（S1）。使った材料は消える（共同成果では「実際に使った量」になる）`, options: [
      { label: '昇格を始める', act: 'tierUp', enabled: !short.length, reason: `足りない：${short.join('、')}`, consequence: '36ターンで町になり、生産が増える。材料は戻らない' },
      { label: '待つ', wait: true, enabled: true, consequence: '材料がそろうのを待つ' },
    ] });
  }
  if (goal?.kind === 'workshops') {
    const f = Object.values(w.facilities).find(x => x.kind === '工房' && x.owner === me);
    if (f && f.status === '稼働' && f.copies < goal.copies) {
      const cost = workshopCost(f.copies);
      const short = Object.entries(cost).filter(([r, v]) => (w.stock[me][r] ?? 0) < v).map(([r, v]) => `${label.res(r)} ${v - (w.stock[me][r] ?? 0)}`);
      out.push({ id: 'workshop', title: `工房を足すか（今 ${f.copies}基）`, why: `要るもの：${Object.entries(cost).map(([r, v]) => `${label.res(r)}${v}`).join('・')}。鉱石は兵器づくりにも要るので、どちらに回すかの判断になる`, options: [
        { label: '工房を1基足す', act: 'addWorkshop', enabled: !short.length, reason: `足りない：${short.join('、')}`, consequence: '材料は戻らない。工房が増えると、1ターンに作れる兵器が増える' },
        { label: '待つ', wait: true, enabled: true, consequence: '鉱石を兵器づくりに回す' },
      ] });
    }
  }
  if (goal?.kind === 'trained') {
    out.push({ id: 'train', title: '長槍兵を訓練するか', why: '兵器50と食料100で100人（S1：100人あたり兵器50）', options: [
      { label: '長槍兵100を訓練する', act: 'trainPikemen', args: { n: 100 }, enabled: (w.stock[me].arms ?? 0) >= 50 && (w.stock[me].food ?? 0) >= 100, reason: `兵器は ${w.stock[me].arms ?? 0}（50要る）`, consequence: '兵器と食料は消える。渡り場の守りになる' },
      { label: '待つ', wait: true, enabled: true, consequence: '兵器が届くのを待つ' },
    ] });
  }
  // 国からの頼み（国は持ち主の物を動かせない）
  for (const [n, g] of Object.entries(NATION_GOALS)) {
    if (m.nation !== n || !g.asks.includes(me) || w.supply.answeredNation[`${n}|${me}`]) continue;
    out.push({ id: `nation-${n}`, title: `${SUPPLY_NATIONS[n]}からの頼み`, why: `${g.text}。国はあなたの物を動かせない。応じるかはあなたが決める。断り続ければ、国は投票で追放を決めることはできる（S1 の実装）`, options: [
      { label: '国の目標を優先する', act: 'ackNation', args: { nation: n, follow: true }, enabled: true, consequence: nationFollowText(n) },
      { label: '自分の取引を優先する', act: 'ackNation', args: { nation: n, follow: false }, enabled: true, consequence: '記録に残る。国の評価は下がりうるが、あなたの物はあなたの判断のまま' },
    ] });
  }
  // 抜ける
  if (!left && Object.values(w.offers).some(o => (o.from === me || o.to === me))) {
    out.push({ id: 'leave', title: 'この交易路から抜けるか', why: '抜けると、自分の申し出は取り下げ、自分あての申し出は断る。成立済みの交換の荷車はそのまま届く', options: [
      { label: '抜ける', act: 'leaveSupply', enabled: true, consequence: '共同成果には数えられなくなるかもしれない。個人の目標は自分で続けられる' },
      { label: '続ける', wait: true, enabled: true, consequence: '今の申し出のまま' },
    ] });
  }
  return out;
}

function goalSelfText(me) {
  return {
    nagi: '木材が足りないので、町にはなれない。鉱石は自分の村に残る',
    tou: '鉱石が足りないので、工房は増やせず、兵器も少ししか作れない',
    rin: '兵器がないので、長槍兵は訓練できない。木材と食料は残る',
    sena: '工房の兵器を自分に残す',
    kai: '鉱石を自分に残す',
  }[me] ?? '手元の物を自分に使う';
}
function nationFollowText(n) {
  return {
    A: '兵器を他国に渡さず、A国の砦攻めのために持っておく。リンとの交換はやめることになる',
    B: '鉱石はB国のカイから得る（遠い・時間がかかる）。ナギとの交換はやめることになる',
    C: '渡り場で、どの国とも取引する。国の構えの投票では「通行を許す」に入れる',
  }[n];
}

/** 判断の選択肢を実行する（画面とテストが同じ道を通る）。 */
export function performSupply(w, me, option, over = {}) {
  if (!option || option.enabled === false) return fail(option?.reason || '選べない');
  if (option.wait) return ok({ waited: true });
  if (option.event) return injectSupply(w, option.event, { member: me, ...(option.args ?? {}) });
  const m = w.members[me];
  if ((option.act === 'ackNation' || option.act === 'leaveSupply') && !m.present) return fail(`${m.name}は不在。本人の判断は本人しかできない`);
  if (option.act === 'ackNation') {
    const { nation, follow } = option.args;
    if (nation !== m.nation) return fail('自分の国の頼みではない');
    if (w.supply.answeredNation[`${nation}|${me}`]) return fail('もう答えた');
    w.supply.answeredNation[`${nation}|${me}`] = follow ? '応じた' : '断った';
    if (follow) {
      // 国の目標に沿って、関係する見本の申し出を自分で取り下げる（持ち主の判断として）
      for (const o of Object.values(w.offers)) {
        if (o.status !== '申し出中' || !conflictsWithNation(w, o, nation, me)) continue;
        o.status = o.from === me ? '取り下げ' : '断られた';
      }
    }
    w.log.push({ turn: w.turn, kind: 'goal', text: `${w.members[me].name}は${SUPPLY_NATIONS[nation]}の頼みに${follow ? '応じた' : '応じず、自分の取引を優先した'}` });
    return ok();
  }
  if (option.act === 'leaveSupply') {
    if (w.supply.left[me] != null) return fail('もう抜けている');
    w.supply.left[me] = w.turn;
    for (const o of Object.values(w.offers)) {
      if (o.status !== '申し出中') continue;
      if (o.from === me) o.status = '取り下げ';
      if (o.to === me) o.status = '断られた';
    }
    w.log.push({ turn: w.turn, kind: 'withdraw', text: `${w.members[me].name}が交易路から抜けた。成立済みの交換の荷車はそのまま届く` });
    return ok();
  }
  const r = performModel(w, me, option, over);
  if (r.ok) checkJoint(w);   // 行動で条件を満たしたら、そのターンのうちに記録する
  return r;
}

/** 国の頼みに応じたとき、取り下げる（断る）ことになる申し出。自分が兵器を他国へ渡す（A）、他国から鉱石を得る（B）。 */
function conflictsWithNation(w, o, nation, me) {
  const other = w.members[o.from === me ? o.to : o.from];
  const iGive = o.from === me ? o.give : o.want;
  const iGet = o.from === me ? o.want : o.give;
  if (nation === 'A') return iGive.res === 'arms' && other.nation !== 'A';
  if (nation === 'B') return iGet.res === 'ore' && other.nation !== 'B';
  return false;
}
