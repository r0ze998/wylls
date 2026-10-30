// 共同の目的（最初の1件）と、達成の判定（仮・切り替え可能）。共同・国・個人を別々に表示する形を作る。
//
//   - 目的は具体的な1件：依頼した人の村の近くに貯蔵庫を1つ建てる。その材料のうち木材と石材を、ほかの人から受け取る。
//     貯蔵庫の費用は S1 の値（permutation-server/web/frontier/fcaravan.mjs VAULT_COST = caravan.rs）：木材200・石材200・金50。
//   - 貢献は「送った量」ではなく、④の確定の記録で確かめた到着の量。未検証の量は数えず、未検証と表示する。
//   - 資源は合計しない。木材と石材を別々に判定する（50 の単純合計は使わない）。
//   - 判定は仮。`JUDGES` から選ぶ。報酬はない。勝利条件・世界の終了・中央塔とは結び付けない。

import { RESOURCES, RESOURCE_JA, stateAt, ownerTagOf } from './record.mjs';
import { arrivalsOf } from './arrival.mjs';
import { VAULT_COST } from '../../../permutation-server/web/frontier/fcaravan.mjs';

const vaultCost = Object.fromEntries(RESOURCES.map((r, i) => [r, VAULT_COST[i] ?? 0]).filter(([, v]) => v > 0));

export const GOALS = Object.freeze({
  'crossing-storehouse-v1': Object.freeze({
    id: 'crossing-storehouse-v1',
    title: '渡り場の貯蔵庫を建てる',
    what: '依頼した人の村の近くに、貯蔵庫（倉）を1つ建てる。建てるのも、建てた倉も、依頼した人のもの（国の共有の物ではない）',
    cost: vaultCost,                       // 建てる費用（S1）：木材200・石材200・金50
    fromOthers: { wood: 200, stone: 200 }, // ほかの人から受け取りたい分（依頼の上限ではなく、判定の基準）［仮］
    crossNations: 1,                       // 依頼した人の国（申告）と違う国（申告）から、少なくとも何か国［仮］
    facility: 'vault',
  }),
});

/**
 * 達成の判定（どれも仮）。`{id, label, judge(ctx) → {done, why}}`。
 * ctx：{goal, host, perResource: {r: verified}, nations: Set, vaultSeenAfter: bool | null}
 */
export const JUDGES = Object.freeze({
  arrivals: {
    id: 'arrivals',
    label: '仮A：確定した到着だけで判定（資源ごと）',
    judge: c => {
      const short = Object.entries(c.goal.fromOthers).filter(([r, n]) => (c.perResource[r] ?? 0) < n);
      if (short.length) return { done: false, why: `足りない：${short.map(([r, n]) => `${RESOURCE_JA[r]} ${c.perResource[r] ?? 0}／${n}`).join('、')}` };
      if (c.nations.size < c.goal.crossNations) return { done: false, why: `ほかの国からの確定した到着が ${c.nations.size}／${c.goal.crossNations} か国` };
      return { done: true, why: '資源ごとに、確定した到着が基準に届いた' };
    },
  },
  'arrivals-and-facility': {
    id: 'arrivals-and-facility',
    label: '仮B：確定した到着＋施設ができたことの観測',
    judge: c => {
      const a = JUDGES.arrivals.judge(c);
      if (!a.done) return a;
      if (c.vaultSeenAfter === null) return { done: false, why: '施設の観測ができない（ヘラルドの一覧がない）' };
      if (!c.vaultSeenAfter) return { done: false, why: '到着の後に、依頼した人の新しい貯蔵庫がまだ見えない' };
      return { done: true, why: '到着の後に、依頼した人の新しい貯蔵庫が見えた（届いた物で建てたかどうかは区別できない）' };
    },
  },
});

const blank = () => Object.fromEntries(RESOURCES.map(r => [r, 0]));

/**
 * 表示の形。共同・国・個人を別々に返す。
 *   state：record.mjs の fold の結果、file：ヘラルドの caravans.json、obs：板の観測（{ended: {key: t}, vaults: {key: t}}）、
 *   viewer：見ている人のウォレット（なくてもよい）、now：秒、judgeId：JUDGES の鍵。
 */
export function coopView({ state, file, obs = { ended: {}, vaults: {} }, viewer = null, viewerNation = null, now, judgeId = 'arrivals', season }) {
  const judge = JUDGES[judgeId] ?? JUDGES.arrivals;
  const arrivals = arrivalsOf(state, file);
  const byReq = {};
  for (const a of arrivals) (byReq[a.requestId] ??= []).push(a);
  const requests = Object.values(state.requests).map(q => ({ ...q, stateNow: stateAt(q, now), arrivals: byReq[q.id] ?? [] }));

  // ---------------------------------------------------------------- 共同（依頼した人＝施設の持ち主ごと）
  const hosts = {};
  for (const q of requests) {
    const goal = GOALS[q.goalId];
    const h = (hosts[`${q.goalId}|${q.requester}`] ??= { goal, host: q.requester, nation: q.nation, perResource: blank(), nations: new Set(), contributors: new Set(), requests: [], lastArrivalSeen: 0 });
    h.requests.push(q.id);
    for (const a of q.arrivals) {
      if (a.state === 'delivered') {
        for (const [r, v] of Object.entries(a.verifiedQty)) h.perResource[r] += v;
        const link = q.links.find(l => l.caravan.ownerTag === a.caravanId.ownerTag && l.caravan.seq === a.caravanId.seq);
        if (link && link.nation !== q.nation) h.nations.add(link.nation);
        h.contributors.add(a.responder);
        h.lastArrivalSeen = Math.max(h.lastArrivalSeen, obs.ended?.[`${a.caravanId.ownerTag}:${a.caravanId.seq}`] ?? 0);
      } else if (a.state === 'moving' || a.state === 'unknown') {
        h.unverifiedCount = (h.unverifiedCount ?? 0) + 1;   // 量は分からないので、件数だけ
      }
    }
  }
  const joint = Object.values(hosts).map(h => {
    let vaultSeenAfter = null;
    if (Array.isArray(file?.vaults) && season) {
      const tag = ownerTagOf(season, h.host);
      vaultSeenAfter = file.vaults.some(v => String(v.ownerTag) === tag && (obs.vaults?.[`${v.p},${v.q},${v.tile}`] ?? 0) > h.lastArrivalSeen && h.lastArrivalSeen > 0);
    }
    const verdict = judge.judge({ goal: h.goal, host: h.host, perResource: h.perResource, nations: h.nations, vaultSeenAfter });
    return {
      goalId: h.goal.id, title: h.goal.title, host: h.host, hostNation: h.nation, judge: judge.id, judgeLabel: judge.label,
      progress: Object.entries(h.goal.fromOthers).map(([r, n]) => ({ resource: r, verified: h.perResource[r], need: n })),
      otherNations: [...h.nations], contributors: [...h.contributors], unverifiedCaravans: h.unverifiedCount ?? 0,
      done: verdict.done, why: verdict.why, vaultSeenAfter,
    };
  });

  // ---------------------------------------------------------------- 国（申告の国ごとの記録。国の目標はこの版では決めない）
  const nation = viewerNation === null ? null : {
    nation: viewerNation,
    note: '国の目標はこの版では設定しない（誰がどう決めるかは未決定）。国の議会の構え・投票は既存の画面にある',
    requests: requests.filter(q => q.nation === viewerNation).length,
    deliveredFromNation: requests.flatMap(q => q.arrivals.filter(a => a.state === 'delivered' && q.links.find(l => l.caravan.seq === a.caravanId.seq && l.caravan.ownerTag === a.caravanId.ownerTag)?.nation === viewerNation)).length,
  };

  // ---------------------------------------------------------------- 個人
  const personal = viewer === null ? null : {
    viewer,
    myRequests: requests.filter(q => q.requester === viewer).map(q => ({ id: q.id, state: q.stateNow, need: q.need, responses: q.responses, arrivals: q.arrivals })),
    myResponses: requests.filter(q => q.responses[viewer]).map(q => ({ id: q.id, requester: q.requester, response: q.responses[viewer], arrivals: q.arrivals.filter(a => a.responder === viewer) })),
    myVerified: (() => {
      const t = blank();
      for (const q of requests) for (const a of q.arrivals) if (a.responder === viewer && a.state === 'delivered') for (const [r, v] of Object.entries(a.verifiedQty)) t[r] += v;
      return Object.fromEntries(Object.entries(t).filter(([, v]) => v > 0));
    })(),
    left: Object.entries(state.left).filter(([, ws]) => ws.includes(viewer)).map(([g]) => g),
  };

  return { requests, arrivals, joint, nation, personal, rejected: state.rejected };
}
