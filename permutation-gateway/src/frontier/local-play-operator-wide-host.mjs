// TEST-ONLY wide local play (wide-depart-local, Q-W2 owner t385u 2026-11-19 22:32 JST 「おすすめで」): an operator AI
// resident's WIDE village (rings 129+) raises its own host and marches it wide -> wide onto a neighbouring province's
// keep — the page's own planner (permutation-server web/frontier/flocalplay-wide-plan.mjs) over the resident's OWN
// relay's read-only wide read; the act goes out as the page-signed local act (flocalplay-wide-host.mjs) through its own
// relay. The world's runner settles the march from public data (itest wide_depart.rs). No key leaves the process.
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { createWideHostPlanner } from '../../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import { WIDE_TRAIN, WIDE_DEPART } from '../../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
export { neighbourTargets, passablePath, WIDE_DEPARTS_MAX } from '../../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';

/**
 * The wide-host side of one resident: `decide(r, {wideTargets, villages})` → `{decision}` (a page-signed act to send
 * this turn: WideTrain, WideMuster or WideDepart) or `{why}` (nothing). `note(r, decision, outcome)` books it.
 */
export function createWideHost({ herald: base, fetch: f = (...a) => globalThis.fetch(...a), now = () => Date.now() }) {
  const herald = createHerald({ base, fetch: f });
  const clock = { at: 0, chain: null, rate: 1 };
  async function chainNow() {
    const st = await (await f(`${base}/h/status`, { signal: AbortSignal.timeout(4000) })).json();
    const c = Array.isArray(st?.live) ? Number(st.live[1]) : NaN;
    if (!Number.isSafeInteger(c)) throw Object.assign(new Error('NoChainClock'), { code: 'NoChainClock' });
    const t = now();
    if (clock.chain !== null && t - clock.at > 500 && c > clock.chain) clock.rate = Math.max(1, Math.round(((c - clock.chain) * 1000) / (t - clock.at)));
    clock.chain = c; clock.at = t;
    return c;
  }
  const readFor = r => async addresses => {
    const res = await f(`${r.origin}/f/local-play/act/context`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'frontier-local-play-act-wide-read-v1', addresses }), signal: AbortSignal.timeout(6000) });
    const j = await res.json();
    if (!Array.isArray(j?.accounts) || j.accounts.length !== addresses.length) throw Object.assign(new Error('WideReadUnavailable'), { code: 'WideReadUnavailable' });
    return j.accounts.map(a => (a ? new Uint8Array(Buffer.from(a.data_b64, 'base64')) : null));
  };
  async function decide(r, opts) {
    const planner = createWideHostPlanner({ herald, read: readFor(r), chainNow, chainRate: () => clock.rate });
    return planner.decide(r.identity, r.memory, opts);
  }
  function note(r, d, outcome) {
    const m = r.memory, bad = outcome === 'refused' || outcome === 'failed';
    m.wideHostUntil = (m.decisions ?? 0) + (bad ? 6 : 2);
    if (d.name === WIDE_TRAIN && bad) m.wideTrainN = Math.max(10, Math.floor((m.wideTrainN ?? 100) / 2));
    if (d.name === WIDE_DEPART && (outcome === 'landed' || outcome === 'unknown')) m.wideDeparts = (m.wideDeparts ?? 0) + 1;
  }
  return Object.freeze({ decide, note, herald });
}
