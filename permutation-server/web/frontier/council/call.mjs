// The members-only Strike Order (contract §6.1 call read, §6.5 step 6, §8.2 `GET /f/ai/council/call`; "Call" is the
// code name). Until the order opens at S + 2 only citizens of the nation can read which option was adopted and which
// tile it targets: the page signs a call-read record with the viewer's session key and sends it as query parameters.
// The service checks the session and the nation, refuses non-members (NotMember), allows two reads per bell, and
// answers `{period, option, kind, p, q, tile, strike_bell, follow_from, invited, nonce, call_commit}`.
//
// The page shows the option, the kind and the place, the strike bell, how many armies are invited and the
// commitment's first hex digits. It never shows the nonce, a host id or the viewer's wallet.
import { encodeCallRead, signRecord } from './aisocial.mjs';
import { int, placeText } from './parts.mjs';
import { nationName } from './lang.mjs';
import { refusalText } from './notice.mjs';

/** An unsuccessful answer `{ok:false, code}` (the codes are the page's own words, see lang.mjs `err.*` and `keys.err.*`). */
const refused = code => ({ ok: false, code });
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null);

/** The signed query of a call read. `unix` is chain time in seconds (fresh from /h/season: the service allows 600 s of skew). */
export async function signCallRead({ signer, season, faction, period, unix }) {
  const bytes = encodeCallRead({ season, faction, period, wallet: signer.wallet, unix: BigInt(Math.trunc(unix)) });
  const signed = await signRecord(bytes, signer.sign);
  const q = new URLSearchParams({ faction: String(faction), period: String(period), wallet: signer.wallet, unix: String(Math.trunc(unix)), sig: signed.sig_b64 });
  return { path: `/f/ai/council/call?${q.toString()}`, signed };
}

/** The service's answer → what the page prints (anything missing becomes null; no field is trusted as text). */
export function normalizeCall(j) {
  if (!j || typeof j !== 'object' || num(j.option) === null) return null;
  return {
    period: num(j.period), option: num(j.option), kind: ['strike', 'camp', 'raid'].includes(j.kind) ? j.kind : '', p: num(j.p), q: num(j.q), tile: num(j.tile),
    strikeBell: num(j.strike_bell), followFrom: num(j.follow_from), invited: Array.isArray(j.invited) ? j.invited.length : 0,
    commit: typeof j.call_commit === 'string' ? j.call_commit.slice(0, 12) : '',
  };
}

/** Read the sealed order: `{ok:true, call}` or `{ok:false, code}`. `get(path) → {status, json}`. `seasonUnix()` → fresh chain time. */
export async function readCall({ signer, season, faction, period, get, seasonUnix }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let q;
    try { q = await signCallRead({ signer, season, faction, period, unix: await seasonUnix() }); } catch (e) { return refused(e?.code ?? 'BadBytes'); }
    let res;
    try { res = await get(q.path); } catch { return refused('network'); }
    if (res?.json?.error || res?.json?.code) {
      const code = res.json.code ?? res.json.error;
      if (code === 'BellSkew' && attempt === 0) continue; // one retry with a fresh chain time
      return { ok: false, code };
    }
    const call = normalizeCall(res?.json);
    return call ? { ok: true, call } : refused('BadBytes');
  }
  return refused('BellSkew');
}

export function renderCallPanel(ctx, { me, faction, period, state, call, error, onRead }) {
  const { h, t, lang } = ctx;
  const box = h('div', { class: 'call-panel' }, h('h4', null, t('call.title')));
  if (!me) { box.appendChild(h('p', { class: 'muted' }, t('call.need_key'))); return box; }
  if (call) {
    box.appendChild(h('p', { class: 'call-read' }, t('call.sealed_for_you', {
      name: nationName(faction, lang), n: int(call.option), kind: call.kind ? t(`council.kind.${call.kind}`) : '?', at: call.p !== null ? placeText(t, call.p, call.q) : '?', s: call.strikeBell !== null ? int(call.strikeBell) : '?',
    })));
    box.appendChild(h('p', { class: 'muted' }, [t('call.invited', { n: call.invited }), call.followFrom !== null ? t('call.follow_from', { n: int(call.followFrom) }) : null, call.commit ? t('call.commit', { commit: call.commit }) : null].filter(Boolean).join(' · ')));
  } else if (state === 'opened') {
    box.appendChild(h('p', { class: 'muted' }, t('call.opened')));
  } else if (state === 'closed' && period !== null) {
    box.appendChild(h('p', { class: 'muted' }, t('call.members_only')));
    box.appendChild(h('button', { type: 'button', class: 'btn', on: { click: onRead } }, t('call.read')));
    if (error) box.appendChild(h('p', { class: 'error', role: 'status' }, t('call.error', { why: refusalText(t, error) })));
  } else box.appendChild(h('p', { class: 'muted' }, t('call.none')));
  return box;
}
