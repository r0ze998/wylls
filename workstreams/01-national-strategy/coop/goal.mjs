// 共同の目的（最初の1件）と、達成の判定（仮・切り替え可能）。共同・国・個人を別々に表示する形を作る。
//
//   - 目的は具体的な1件：依頼した人の村の近くに貯蔵庫を1つ建てる。その材料のうち木材と石材を、ほかの人から受け取る。
//     貯蔵庫の費用は S1 の値（permutation-server/web/frontier/fcaravan.mjs VAULT_COST = caravan.rs）：木材200・石材200・金50。
//   - 貢献は「送った量」ではなく、④の確定の記録で確かめた到着の量。未検証の量は数えず、未検証と表示する。
//   - 資源は合計しない。木材と石材を別々に判定する（50 の単純合計は使わない）。
//   - 判定は仮。`JUDGES` から選ぶ。報酬はない。勝利条件・世界の終了・中央塔とは結び付けない。
//   - 国は、チェーンの Citizen の口座で確かめた陣営だけを使う（chain.mjs）。確かめられなければ「国籍未検証」で、国際協力の達成は確定しない。
//   - 同じ隊商の到着は、一つの依頼にだけ割り当てる（重複の割当をしない）。一つの到着が、共同の目的・国の記録・個人の記録の
//     三つの表示に出るのは、別々の評価に寄与しているだけで、資源の重複割当ではない。

import { RESOURCES, RESOURCE_JA, stateAt, ownerTagOf, ctxKey } from './record.mjs';
import { arrivalsOf, caravanKeyOf } from './arrival.mjs';
import { toWs04Terminal, fulfilmentOf, pickNeed } from './ws04.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { PRESETS as V2PRESETS } from '../../../permutation-server/web/sdk/frontier/abi-v2-presets.mjs';
import { VAULT_COST } from '../../../permutation-server/web/frontier/fcaravan.mjs';

const vaultCost = Object.fromEntries(RESOURCES.map((r, i) => [r, VAULT_COST[i] ?? 0]).filter(([, v]) => v > 0));

export const GOALS = Object.freeze({
  'crossing-storehouse-v1': Object.freeze({
    id: 'crossing-storehouse-v1',
    title: '渡り場の貯蔵庫を建てる',
    what: '依頼した人の村の近くに、貯蔵庫（倉）を1つ建てる。建てるのも、建てた倉も、依頼した人のもの（国の共有の物ではない）',
    cost: vaultCost,                       // 建てる費用（S1）：木材200・石材200・金50
    fromOthers: { wood: 200, stone: 200 }, // ほかの人から受け取りたい分（依頼の上限ではなく、判定の基準）［仮］
    crossNations: 1,                       // 依頼した人の国と違う国から、少なくとも何か国［仮］。国はチェーンの Citizen で確かめたものだけ（申告は使わない）
    facility: 'vault',
  }),
});

/**
 * 達成の判定（どれも仮）。`{id, label, means, judge(ctx) → {done, why}}`。`means` は画面にそのまま出す説明。
 * ctx：{goal, perResource: {r: 証明できた量}, nations: Set（確かめた他国）, unverified: [理由], vaultSeenAfter: bool | null}
 */
export const JUDGES = Object.freeze({
  arrivals: {
    id: 'arrivals',
    label: '仮A：確定した到着の量だけ',
    means: '依頼の届け先（依頼した人の村）に、確定の記録と規則で証明できた入荷量を資源ごとに数える。届いた物を何に使ったか、使ったかどうかは見ない',
    judge: c => {
      const short = Object.entries(c.goal.fromOthers).filter(([r, n]) => (c.perResource[r] ?? 0) < n);
      if (short.length) return { done: false, why: `足りない：${short.map(([r, n]) => `${RESOURCE_JA[r]} ${c.perResource[r] ?? 0}／${n}`).join('、')}` };
      if (c.nations.size < c.goal.crossNations) {
        return { done: false, why: c.unverified.length ? `国籍未検証のため、国をまたぐ協力は確定しない（${c.unverified.join('、')}）` : `確かめた他国からの到着が ${c.nations.size}／${c.goal.crossNations} か国` };
      }
      return { done: true, why: '資源ごとに、証明できた入荷量が基準に届き、確かめた他国からの到着がある' };
    },
  },
  'arrivals-and-facility': {
    id: 'arrivals-and-facility',
    label: '仮B：仮A＋到着の後に新しい貯蔵庫が見えた',
    means: '仮Aに加えて、到着を板が見た後に、依頼した人の新しい貯蔵庫がヘラルドの一覧に初めて見えたこと。これは時刻の前後を見るだけで、届いた物を使って建てた証拠ではない（在庫は混ざる。自分の物で建てても同じに見える）',
    judge: c => {
      const a = JUDGES.arrivals.judge(c);
      if (!a.done) return a;
      if (c.vaultSeenAfter === null) return { done: false, why: '貯蔵庫の一覧がない（ヘラルドが読めない）' };
      if (!c.vaultSeenAfter) return { done: false, why: '到着を見た後に、依頼した人の新しい貯蔵庫がまだ見えない' };
      return { done: true, why: '到着を見た後に、依頼した人の新しい貯蔵庫が見えた（届いた物を使った証拠ではない）' };
    },
  },
});

const blank = () => Object.fromEntries(RESOURCES.map(r => [r, 0]));
const caravanKey = caravanKeyOf;

/**
 * 到着を依頼に割り当てる。同じ隊商は、最初に結び付けた（記録の順）依頼にだけ割り当て、二つ目からは `duplicateOf` を付けて数えない。
 * 板は同じ隊商の二度目の結び付けを断るが、記録が欠けた板や別の板の記録を混ぜたときにも二重に数えないための守り。
 */
export function allocate(arrivals, state) {
  const order = new Map();
  for (const q of Object.values(state.requests)) for (const l of q.links) order.set(`${q.id}|${caravanKey(l.caravan)}`, l.n ?? 0);
  const sorted = [...arrivals].sort((a, b) => (order.get(`${a.requestId}|${caravanKey(a.caravanId)}`) ?? 0) - (order.get(`${b.requestId}|${caravanKey(b.caravanId)}`) ?? 0));
  const first = new Map();
  return sorted.map(a => {
    const k = caravanKey(a.caravanId);
    if (!first.has(k)) { first.set(k, a.requestId); return a; }
    return { ...a, duplicateOf: first.get(k), note: `同じ隊商はもう依頼 ${first.get(k).slice(0, 8)} に割り当てた。二重に数えない` };
  });
}

/**
 * 到着時の受取人を世代から決める規則の版。確かめたのは、ルールの hash が RULESET_HASH_V3 の S1 のプログラムのコード（基準 4cd901de）。
 * シーズンの口座の RULESET_HASH がこれと違う・読めないときは、規則が同じと言えないので受取人は未検証（数えない）。
 */
export const RECIPIENT_RULE = Object.freeze({
  rulesetHash: V2PRESETS.ruleset_hash_v3,
  checkedAt: '4cd901de9f8e0d6c0b2016851d30595c4a70aa46',
  basis: 'Holding の OWNER_CITIZEN を書くのは、世代を1つ進める占領（conquest.rs:1292-1295、1322、1425-1426）と入植（citizen.rs:1465-1468、1814）だけ',
});

/**
 * 応じた後の送信か。送信の blockTime（バリデーターの時計、秒）と、板が応答を受け取った時刻（板の時計、秒）を比べる。
 * blockTime は秒単位の推定で、二つの時計も一致しないので、差が TIMING_MARGIN 秒以内は前後を証明できない → 'boundary'（保留、数えない）。
 */
export const TIMING_MARGIN = 5;
export function timingOf(sentBlockTime, acceptReceivedAt) {
  if (sentBlockTime === null || sentBlockTime === undefined) return { status: 'unknown', why: '送信の時刻（blockTime）が分からない' };
  if (acceptReceivedAt === null || acceptReceivedAt === undefined) return { status: 'unknown', why: '板が応答を受け取った時刻が分からない（古い形の記録）' };
  const d = sentBlockTime - acceptReceivedAt;
  if (d > TIMING_MARGIN) return { status: 'after', delta: d };
  if (d < -TIMING_MARGIN) return { status: 'before', delta: d, why: '応じる前に送った' };
  return { status: 'boundary', delta: d, why: `送信と応答の時刻の差が ${d} 秒で、前後を証明できない（±${TIMING_MARGIN} 秒は保留）` };
}

/** 進捗に数えてよい検証（④ CONTRACTS §9：Recorded か RuleDerived の delivered だけ）。 */
export const COUNTABLE = Object.freeze(['Recorded', 'RuleDerived']);

/**
 * 到着時の受取人（村の持ち主）を、今の口座と分けて決める。
 * 同じ世代の間、村の持ち主は変わらない：Holding の OWNER_CITIZEN を書くのは、世代を1つ進める占領（conquest.rs:1292-1295、1322、1425-1426）と
 * 入植（citizen.rs:1465-1468、1814）だけ。だから、今の口座の世代が到着の記録の世代（dst.gen）と同じなら、今の持ち主が到着時の持ち主。
 * 世代が違えば（到着の後に占領・再入植）、到着時の持ち主は今の口座からは確定できない → 未検証（推測しない）。
 *   now：chain.mjs holdingNow の結果、requesterCitizen：依頼した人の Citizen の住所
 */
export function recipientOf(arrival, now, requesterCitizen, rules = { status: 'verified', rulesetHash: RECIPIENT_RULE.rulesetHash }) {
  if (arrival.state !== 'delivered') return null;
  if (rules?.status !== 'verified') return { status: 'unverified', why: `規則の版を確かめられない：${rules?.why ?? ''}` };
  if (rules.rulesetHash !== RECIPIENT_RULE.rulesetHash) return { status: 'unverified', why: `このシーズンの規則（${String(rules.rulesetHash).slice(0, 8)}…）は、受取人の決め方を確かめた版（${RECIPIENT_RULE.rulesetHash.slice(0, 8)}…）と違う` };
  if (!now || now.status !== 'found') return { status: 'unverified', why: now?.why ?? '届け先の村の口座をまだ読んでいない' };
  if (now.gen !== arrival.dstGen) return { status: 'unverified', gen: arrival.dstGen, currentGen: now.gen, why: `村の世代が変わった（到着時 ${arrival.dstGen}、今 ${now.gen}：占領か再入植）。到着時の持ち主は今の口座からは確定できない` };
  return { status: 'verified', gen: arrival.dstGen, ownerCitizen: now.ownerCitizen, isRequester: now.ownerCitizen === requesterCitizen,
    basis: '同じ世代の間、村の持ち主は変わらない（OWNER_CITIZEN を書くのは世代を進める占領・入植だけ）' };
}

/** 一つの到着を、共同の目的に数える量（依頼の資源ごと）と、数えない理由。 */
function countOf(a, recipient, timing) {
  if (a.duplicateOf) return { counted: null, why: '同じ隊商は別の依頼に割り当て済み' };
  if (a.state !== 'delivered') return { counted: null, why: a.verification === 'KnownZero' ? '届かなかった（0 と分かっている）' : 'まだ届いていない・分からない' };
  if (!COUNTABLE.includes(a.verification)) return { counted: null, why: a.verification === 'Unverifiable' ? '到着したが、入った量を確認できない' : 'チェーンの記録で確かめていない' };
  if (recipient?.status !== 'verified') return { counted: null, why: `到着時の受取人が未検証：${recipient?.why ?? ''}` };
  if (!recipient.isRequester) return { counted: null, why: '到着時の受取人が依頼した人ではない' };
  if (timing?.status !== 'after') return { counted: null, why: timing?.status === 'before' ? '応じる前に送った隊商' : `応じた後の送信か証明できない（保留）：${timing?.why ?? ''}` };
  return { counted: a.delivered, why: null };
}

/**
 * 表示の形。共同・国・個人を別々に返す。
 *   state：record.mjs の fold の結果、file：ヘラルドの caravans.json、obs：板の観測（{ended: {key: t}, vaults: {key: t}}）、
 *   checks：チェーンで確かめた結果（{citizens: {wallet: citizenOf}, holdings: {requestId: holdingOf}, caravans: {ownerTag:seq: caravanEndFromChain}}。
 *     caravans がない（undefined）のは、チェーンを読まない板で、量はすべて未検証）、
 *   viewer：見ている人のウォレット（なくてもよい）、now：秒、judgeId：JUDGES の鍵。
 */
export function coopView({ state, file, obs = { ended: {}, vaults: {} }, checks = { citizens: {}, holdings: {} }, viewer = null, now, judgeId = 'arrivals', season }) {
  const judge = JUDGES[judgeId] ?? JUDGES.arrivals;
  // season：今の文脈（ヘラルドの一覧・新しい依頼・見ている人の国）。依頼ごとの確かめは、その依頼の文脈（q.ctx）で行う。
  const ctxOf = q => q.ctx ?? season;
  const rulesOf = q => (checks.rules && checks.rules.status ? checks.rules : checks.rules?.[ctxKey(ctxOf(q))]);
  const arrivals = allocate(arrivalsOf(state, file, checks.caravans, season ? ctxKey(season) : null), state).map(a => {
    const q = state.requests[a.requestId];
    const now = checks.holdings?.[a.requestId];
    const c0 = ctxOf(q);
    const recipient = recipientOf(a, now, c0 ? seasonAddresses(c0.programId, c0.seasonId).of('Citizen', { wallet: q.requester }) : null, rulesOf(q));
    const sent = checks.caravans?.[caravanKey(a.caravanId)]?.sent;
    const resp = q.responses[a.responder];
    const timing = timingOf(sent?.blockTime, checks.times?.[resp?.id] ?? null);
    const c = countOf(a, recipient, timing);
    // 送った荷（チェーンの最初の CARAVAN_SENT、整数単位、依頼の資源だけ）。④の Fulfilled／Partial は隊商ごとにこれと比べる
    const shipped = sent?.cargo ? pickNeed(sent.cargo, q.need) : null;
    return { ...a, recipient, timing, currentOwner: now?.status === 'found' ? { gen: now.gen, ownerCitizen: now.ownerCitizen } : null, counted: c.counted, notCountedWhy: c.why,
      shipped, terminal: toWs04Terminal(a, shipped) };
  });
  const byReq = {};
  for (const a of arrivals) (byReq[a.requestId] ??= []).push(a);
  const requests = Object.values(state.requests).map(q => ({ ...q, stateNow: stateAt(q, now), arrivals: byReq[q.id] ?? [], fulfilment: fulfilmentOf(q, byReq[q.id] ?? []),
    sendings: (q.sendings ?? []).map(z => ({ ...z, outcome: checks.sendings?.[z.walletSig] ?? { status: 'unknown', why: 'まだ確かめていない' } })) }));
  // 国は文脈ごとの Citizen の口座で確かめる（checks.citizens の鍵は「文脈|ウォレット」。古い形の「ウォレット」だけの鍵も読む）
  const citizen = (w, c = season) => checks.citizens?.[`${c ? ctxKey(c) : ''}|${w}`] ?? checks.citizens?.[w] ?? { status: 'unverified', why: 'まだ確かめていない' };
  const factionOf = (w, c = season) => (citizen(w, c).status === 'verified' ? citizen(w, c).faction : null);

  // ---------------------------------------------------------------- 共同（依頼した人＝施設の持ち主ごと）
  const hosts = {};
  for (const q of requests) {
    const h = (hosts[`${q.goalId}|${q.requester}`] ??= { goal: GOALS[q.goalId], host: q.requester, perResource: blank(), contributors: new Set(), otherNations: new Set(), unverified: new Set(), unverifiedCaravans: 0, unprovenDeliveries: 0, lastArrivalSeen: 0, holdingIssues: new Set(), records: {} });
    for (const a of q.arrivals) {
      if (a.duplicateOf) continue;
      if (a.counted) {
        for (const [r, v] of Object.entries(a.counted)) { h.perResource[r] += v; if (v > 0) h.records[r] = (h.records[r] ?? 0) + 1; }
        h.contributors.add(a.responder);
        h.lastArrivalSeen = Math.max(h.lastArrivalSeen, obs.ended?.[caravanKey(a.caravanId)] ?? 0);
        const hf = factionOf(q.requester, ctxOf(q)), rf = factionOf(a.responder, ctxOf(q));
        if (hf === null) h.unverified.add('依頼した人の国が未検証');
        if (rf === null) h.unverified.add(`届けた人 ${a.responder.slice(0, 4)}… の国が未検証`);
        if (hf !== null && rf !== null && hf !== rf) h.otherNations.add(rf);
      } else if (a.state === 'delivered') { h.unprovenDeliveries += 1; if (a.notCountedWhy) h.holdingIssues.add(a.notCountedWhy); }
      else if (a.state === 'moving' || a.state === 'unknown') h.unverifiedCaravans += 1;
    }
  }
  const joint = Object.values(hosts).map(h => {
    let vaultSeenAfter = null;
    if (Array.isArray(file?.vaults) && season) {
      const tag = ownerTagOf(season, h.host);
      vaultSeenAfter = h.lastArrivalSeen > 0 && file.vaults.some(v => String(v.ownerTag) === tag && (obs.vaults?.[`${v.p},${v.q},${v.tile}`] ?? 0) > h.lastArrivalSeen);
    }
    const verdict = judge.judge({ goal: h.goal, perResource: h.perResource, nations: h.otherNations, unverified: [...h.unverified], vaultSeenAfter });
    const hostCit = citizen(h.host);
    return {
      goalId: h.goal.id, title: h.goal.title, host: h.host, hostNation: hostCit.status === 'verified' ? hostCit.faction : null, hostNationWhy: hostCit.status === 'verified' ? null : hostCit.why,
      judge: judge.id, judgeLabel: judge.label, judgeMeans: judge.means,
      // 単位は整数（記録の cargo はミリ単位を1件ずつ切り捨てた値）。k 件を足した合計は、ミリ単位で足してから切り捨てた値より最大 k−1 少なく、
      // 本当の入荷量（ミリ単位）より k 未満少ない。underBy はその k（数えた到着の件数）。
      progress: Object.entries(h.goal.fromOthers).map(([r, n]) => ({ resource: r, verified: h.perResource[r], need: n, unit: 'whole', underBy: h.records[r] ?? 0 })),
      otherNations: [...h.otherNations], nationsUnverified: [...h.unverified], holdingIssues: [...h.holdingIssues], contributors: [...h.contributors],
      unverifiedCaravans: h.unverifiedCaravans, unprovenDeliveries: h.unprovenDeliveries,
      done: verdict.done, why: verdict.done || !h.holdingIssues.size ? verdict.why : `${verdict.why}（数えなかった到着：${[...h.holdingIssues].join('、')}）`, vaultSeenAfter,
    };
  });

  // ---------------------------------------------------------------- 国（チェーンで確かめた国ごとの記録。国の目標はこの版では決めない）
  const vf = viewer ? citizen(viewer) : null;
  const nation = !viewer ? null : vf.status !== 'verified' ? { nation: null, why: vf.why, note: '国籍未検証。国の記録は出さない' } : {
    nation: vf.faction,
    note: '国の目標はこの版では設定しない（誰がどう決めるかは未決定）。国の議会の構え・投票は既存の画面にある',
    requests: requests.filter(q => factionOf(q.requester, ctxOf(q)) === vf.faction).length,
    deliveredFromNation: arrivals.filter(a => a.counted && factionOf(a.responder, ctxOf(state.requests[a.requestId])) === vf.faction).length,
  };

  // ---------------------------------------------------------------- 個人
  const personal = viewer === null ? null : {
    viewer,
    nation: vf.status === 'verified' ? vf.faction : null, nationWhy: vf.status === 'verified' ? null : vf.why,
    myRequests: requests.filter(q => q.requester === viewer).map(q => ({ id: q.id, state: q.stateNow, need: q.need, responses: q.responses, arrivals: q.arrivals, fulfilment: q.fulfilment })),
    myResponses: requests.filter(q => q.responses[viewer]).map(q => ({ id: q.id, requester: q.requester, response: q.responses[viewer], arrivals: q.arrivals.filter(a => a.responder === viewer) })),
    myVerified: (() => {
      const t = blank();
      for (const a of arrivals) if (a.responder === viewer && a.counted) for (const [r, v] of Object.entries(a.counted)) t[r] += v;
      return Object.fromEntries(Object.entries(t).filter(([, v]) => v > 0));
    })(),
    left: Object.entries(state.left).filter(([, ws]) => ws.includes(viewer)).map(([g]) => g),
  };

  return { requests, arrivals, joint, nation, personal, rejected: state.rejected, judges: Object.values(JUDGES).map(j => ({ id: j.id, label: j.label, means: j.means })) };
}
