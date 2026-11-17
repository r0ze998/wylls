// 送り元の村を選ぶ（2026-11-17）：送る人の Citizen に載っている村（holding・holdingsN、chain.mjs citizenOf）を候補にし、
// 各村の今の口座の持ち主（chain.mjs holdingNow）を読んだ時点で添える。読むだけ：応じる・署名・送信はしない。
//
// 守っていること：
//   - 候補は「Citizen に載っている村」。持ち主の確かめは読んだ時点のもので、所有の判定ではない。送るときは planSend が
//     その村の口座をもう一度読み、持ち主が送る人の Citizen か確かめる（NotYourVillage）。ここで省いたり緩めたりしない。
//   - 読めないときは「読めない」と言う（空・村がない・持ち主でない、にしない）。
//   - 選ばなければ、これまでどおり planSend の既定（Citizen の最初の村）。

import { citizenOf, holdingNow } from './chain.mjs';

/** 村の鍵（送り元は {p, q, site} で決まる：Holding の口座の種と同じ）。 */
export const placeKey = s => `${s.p},${s.q},${s.site}`;

/**
 * 送り元の村の候補を読む。
 * → {status: 'ok', cands: [{p, q, site, gen|null, owner: 'mine'|'other'|'unverified', why|null}]}（Citizen に村がなければ cands は空）
 *   か {status: 'unread', why}（チェーンや Citizen が読めない。村がないとは言わない）
 */
export async function sourceCandidates(reader, season, wallet) {
  if (!reader) return { status: 'unread', why: 'チェーンを読めない（板に --rpc がない）' };
  let me;
  try { me = await citizenOf(reader, season, wallet); } catch (e) { return { status: 'unread', why: `チェーンを読めない：${e.message ?? e}` }; }
  if (me.status !== 'verified') return { status: 'unread', why: me.why ?? 'Citizen を確かめられない' };
  if (!Array.isArray(me.holdings)) return { status: 'unread', why: 'Citizen の村の欄が読めない' };
  const n = Number(me.holdingsN ?? 0);
  if (!Number.isInteger(n) || n < 0) return { status: 'unread', why: 'Citizen の村の数が読めない' };
  const cands = [];
  for (const r of me.holdings.slice(0, n)) {
    let h;
    try { h = await holdingNow(reader, season, r); } catch (e) { h = { status: 'unverified', why: `チェーンを読めない：${e.message ?? e}` }; }
    cands.push({
      p: r.p, q: r.q, site: r.site,
      gen: h.status === 'found' ? h.gen : null,
      owner: h.status !== 'found' ? 'unverified' : h.ownerCitizen === me.citizen ? 'mine' : 'other',
      why: h.status === 'found' ? null : (h.why ?? '村の口座を確かめられない'),
    });
  }
  return { status: 'ok', cands };
}

/**
 * 送るときに planSend へ渡す送り元。
 *   pick：この送る人・世界・依頼について読んだ候補（{status, why, cands}。読んでいなければ null）、chosen：選んだ村の placeKey か null（最初の村）。
 * → {ok: true, source: {p, q, site} | null}（null は planSend の既定：Citizen の最初の村）か {ok: false, why}
 * 選んだ村が、いまの候補にない・読み直し中・読めない・今の持ち主が自分でないなら送らない（黙って最初の村に替えない）。
 */
export function sourceToUse(pick, chosen) {
  if (chosen === null || chosen === undefined) return { ok: true, source: null };
  if (!pick) return { ok: false, why: '送り元の村の候補を読んでいない。読んでから選んでください' };
  if (pick.status === 'loading') return { ok: false, why: '送り元の村の候補を読み直している途中。読み終えてから押してください' };
  if (pick.status !== 'ok') return { ok: false, why: `送り元の村の候補を読めない（${pick.why ?? '?'}）。読み直してから選んでください` };
  const c = pick.cands.find(x => placeKey(x) === chosen);
  if (!c) return { ok: false, why: '選んだ送り元の村が、読み直した候補にない。選び直してください' };
  if (c.owner === 'other') return { ok: false, why: '選んだ村の今の持ち主が自分ではない。選び直してください' };
  return { ok: true, source: { p: c.p, q: c.q, site: c.site } };
}
