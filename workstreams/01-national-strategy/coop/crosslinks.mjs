// 自分・依頼・協力の進捗を、板の view の既存の鍵だけで結ぶ（2026-11-17）。読むだけ：数え方・報酬・判定は作らない。
//
// 鍵（goal.mjs coopView・record.mjs fold の契約）：
//   依頼は id（記録の ID。一意）。依頼の世界は ctx {programId, seasonId}。
//   協力の進捗（joint）は「goalId｜依頼した人（host）」ごと：coopView は hosts[`${q.goalId}|${q.requester}`] に、その鍵の依頼をすべて
//   （文脈を分けずに）足す。だから、依頼 → 進捗は goalId と requester で一つに決まる。
//   自分（personal）の myRequests・myResponses は依頼の id を持つ。
// 結ぶのは一つに決まり、世界が今の板の世界と同じものだけ。進捗に別の文脈（前の世界）の依頼が混ざるときは、どの世界の進捗かが
// 一つに決まらないので結ばない（「分からない」と言う）。同じ座標・同じ名前だから同じ、とは推し量らない。

export const sameCtx = (c, s) => !!c && !!s && typeof c.programId === 'string' && c.programId === s.programId && String(c.seasonId) === String(s.seasonId);

/** goalId と依頼した人で決まる、同じ協力の進捗に足される依頼（view.requests から）。 */
const groupOf = (view, goalId, host) => (Array.isArray(view?.requests) ? view.requests.filter(x => x.goalId === goalId && x.requester === host) : []);

/**
 * 依頼 → 協力の進捗。
 * → {state: 'one', goalId, host} | {state: 'other-world'|'none'|'mixed'|'ambiguous', why}
 */
export function jointOfRequest(view, q, season) {
  if (!q || !sameCtx(q.ctx, season)) return { state: 'other-world', why: 'この板の今の世界の依頼ではない（前の文脈か、世界が読めない）' };
  const js = Array.isArray(view?.joint) ? view.joint.filter(j => j.goalId === q.goalId && j.host === q.requester) : null;
  if (js === null) return { state: 'ambiguous', why: '協力の進捗が読めない' };
  if (js.length === 0) return { state: 'none', why: 'この依頼の協力の進捗は、いまの表示にない' };
  if (js.length > 1) return { state: 'ambiguous', why: '同じ鍵の協力の進捗が二つ以上ある' };
  const group = groupOf(view, q.goalId, q.requester);
  if (!group.some(x => x.id === q.id)) return { state: 'ambiguous', why: 'この依頼が、その進捗の依頼の中に見えない' };
  if (group.some(x => !sameCtx(x.ctx, season))) return { state: 'mixed', why: 'この進捗には別の文脈（前の世界）の依頼も足されているため、どの世界の進捗か一つに決まらない' };
  return { state: 'one', goalId: q.goalId, host: q.requester };
}

/**
 * 協力の進捗 → その依頼。
 * → {state: 'ok', ids} | {state: 'mixed'|'none', why}
 */
export function requestsOfJoint(view, j, season) {
  const group = groupOf(view, j?.goalId, j?.host);
  if (!group.length) return { state: 'none', why: 'この進捗の依頼が、いまの表示にない' };
  if (group.some(x => !sameCtx(x.ctx, season))) return { state: 'mixed', why: '別の文脈（前の世界）の依頼も足されているため、この画面からは結ばない' };
  return { state: 'ok', ids: group.map(x => x.id) };
}

/**
 * 自分 → 依頼：personal の myRequests・myResponses の id を、view.requests の依頼に結ぶ（id が表示にあるときだけ）。
 * → {requests: [{id, found, state}], responses: [{id, found, state, withdrawn, answer}]} | null（personal がない）
 */
export function personalLinks(view) {
  const p = view?.personal;
  if (!p) return null;
  const byId = new Map((Array.isArray(view.requests) ? view.requests : []).map(q => [q.id, q]));
  const one = (id, extra = {}) => { const q = byId.get(id); return { id, found: !!q, state: q?.stateNow ?? null, ...extra }; };
  return {
    requests: (Array.isArray(p.myRequests) ? p.myRequests : []).map(r => one(r.id)),
    responses: (Array.isArray(p.myResponses) ? p.myResponses : []).map(r => one(r.id, { answer: r.response?.answer ?? null, withdrawn: !!r.response?.withdrawn })),
  };
}
