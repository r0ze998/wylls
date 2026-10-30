// The harness page of ws07-s1.screen.mjs: the page's own S1 parts in a real browser, fed S1 records. The records are
// built from the page's v2 log table (sdk/frontier/abi-v2-logs.mjs) and read through the page's own reader
// (hud/awayread.mjs), model (hud/returnsum.mjs), words (hud/returnwords.mjs), notices (hud/feed.mjs renderToast) and
// stylesheet. They are synthetic: no S1 event log was recorded on a chain. The whole page is not booted (its S1
// world needs layout-v2 fixtures the screen fixtures do not have), so "seen" is wired here as app.mjs wires it.
import { LOGS } from '../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { setLang, lang } from '../../../permutation-server/web/lang.mjs';
import { setHtml, html } from '../../../permutation-server/web/util.mjs';
import * as RS from '../../../permutation-server/web/frontier/hud/returnsum.mjs';
import * as RW from '../../../permutation-server/web/frontier/hud/returnwords.mjs';
import * as RR from '../../../permutation-server/web/frontier/hud/awayread.mjs';
import * as feed from '../../../permutation-server/web/frontier/hud/feed.mjs';
import * as SV from '../../../permutation-server/web/frontier/hud/statusview.mjs';

const q = new URLSearchParams(location.search);
setLang(q.get('lang') === 'en' ? 'en' : 'ja');
document.documentElement.lang = lang();

function body(name, bell, fields = {}) {
  const spec = LOGS.kinds.find(k => k.name === name);
  const parts = [...spec.key, ...spec.payload];
  const b = new Uint8Array(6 + parts.reduce((a, f) => a + f.len, 0) + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) {
    const x = fields[f.name];
    if (x instanceof Uint8Array) b.set(x.subarray(0, f.len), o);
    else if (x !== undefined) { if (f.len === 8) v.setBigUint64(o, BigInt(x), true); else if (f.len === 4) v.setInt32(o, Number(x), true); else if (f.len === 2) v.setUint16(o, Number(x), true); else if (f.len === 1) b[o] = Number(x); }
    o += f.len;
  }
  return toBase64(b);
}
const cargo = arr => { const b = new Uint8Array(32), v = new DataView(b.buffer); arr.forEach((n, i) => v.setUint32(i * 4, n, true)); return b; };
const ME = 0x51n, RAIDER = 0x77n;
const ev = (seq, name, bell, f) => ({ seq: String(seq), body_b64: body(name, bell, f) });
const H = [
  ev(101, 'CARAVAN_SENT', 300, { owner_tag: ME, seq: 3, faction: 2 }),
  ev(102, 'CARAVAN_SENT', 301, { owner_tag: ME, seq: 4, faction: 2 }),
  ev(104, 'CARAVAN_RAIDED', 310, { owner_tag: ME, seq: 3, p: 1, q: 0, bell: 305, choice: 0, by: 0, raider_tag: RAIDER, taken: cargo([0, 300, 0, 0, 0, 0, 0, 0]) }),
  ev(105, 'CARAVAN_SETTLED', 320, { owner_tag: ME, seq: 4, outcome: 0, cargo: cargo([400, 0, 0, 0, 0, 0, 0, 0]) }),
  ev(106, 'CARAVAN_SETTLED', 330, { owner_tag: ME, seq: 3, outcome: 0, cargo: cargo([0, 300, 0, 0, 0, 0, 0, 0]) }),
  ev(107, 'CARAVAN_SETTLED', 332, { owner_tag: ME, seq: 8, outcome: 0, cargo: cargo([50, 0, 0, 0, 0, 0, 0, 0]) }),
  ev(108, 'SIEGE_DECLARED', 340, { p: 0, q: 0, site: 0, attacker: 3, owner_faction: 2, owner_tag: ME, required: 44 }),
];
// the scenario: `fail` makes the herald's second page fail; `gap` reads from a later cursor than the mark
const scenario = q.get('s') ?? 'first';
const failing = scenario === 'fail';
const herald = { calls: 0, async events(after) { const n = this.calls++; if (failing && n === 1) return { ok: false }; const rows = H.filter(e => BigInt(e.seq) > BigInt(after)).slice(0, 3); return { ok: true, events: rows, next: rows.at(-1)?.seq ?? null, full: rows.length === 3 }; } };
const me = { tag: ME, faction: 2, holdings: [{ p: 0, q: 0, site: 0 }], hostOf: () => null };
// storage: the browser's own, or one that refuses (?store=refuse)
const store = q.get('store') === 'refuse' ? { getItem: k => localStorage.getItem(k), setItem: () => { throw new Error('QuotaExceeded'); } } : localStorage;
if (scenario === 'gap' && !localStorage.getItem(RS.storeKey('7', 'W'))) RS.confirm(localStorage, { seasonId: '7', wallet: 'W', confirm: { ok: true, toSeq: '100', toBell: 299, horizonBell: null, caravans: {} }, at: 1 });

let notices = [];
const dismissed = new Set();
const headText = (s, saved) => `${RW.headText(s)} ${saved === undefined ? RW.confirmText(s) : RW.confirmedText(saved)}`;
function render() {
  const live = notices.filter(x => !dismissed.has(x.id));
  setHtml(document.getElementById('feed'), html`${live.map(x => feed.renderToast(x))}`);
  document.body.dataset.ready = '1';
}
async function look() {
  const marks = RS.loadMarks(store, '7', 'W');
  const from = scenario === 'gap' ? '103' : marks?.confirmedSeq ?? '100';
  const r = await RR.createAwayReader({ events: a => herald.events(a) }).start({ scope: 'g|7|W', from });
  const s = RS.summarize({ records: r.records, read: { after: scenario === 'gap' ? '103' : r.after, complete: r.complete, failed: r.failed }, marks, last: RS.loadLast(store), season: '7', wallet: 'W', nowBell: 400, headSeq: '108', me });
  const head = { id: 'away:1', kind: 'away', bell: 400, text: headText(s), away: { ok: s.confirm.ok, summary: s } };
  const items = s.items.map(i => ({ id: `aw:${i.seq}`, kind: 's1', bell: i.bell, text: RW.itemText(i), awayOf: i, ...(i.at ? { p: i.at.p, q: i.at.q } : {}) }));
  notices = [head, ...items];
  window.ws07 = { summary: s, marks: () => RS.loadMarks(localStorage, '7', 'W') };
  render();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const x = notices.find(y => y.id === b.dataset.id);
  if (b.dataset.act === 'feed-dismiss') { dismissed.add(b.dataset.id); render(); return; }
  if (b.dataset.act !== 'away-seen' || !x?.away?.summary?.confirm?.ok) return;
  // (as app.mjs 'away-seen': the summary's own confirm; a refused write keeps the notice and says so)
  const saved = RS.confirm(store, { seasonId: '7', wallet: 'W', confirm: x.away.summary.confirm, at: 1 });
  if (!saved) { notices = notices.map(y => (y.id === x.id ? { ...y, text: headText(y.away.summary, null) } : y)); render(); return; }
  window.ws07.saved = saved;
  for (const y of notices) dismissed.add(y.id);
  render();
});
// the display contract's states (04, 05), each as the page words it
setHtml(document.getElementById('contract'), html`${[
  SV.cancelView({ stage: 'stopNew' }), SV.cancelView({ stage: 'awaitSigned', signedPending: 2 }), SV.cancelView({ stage: 'cancelled', settled: [] }),
  SV.arrivalView({ state: 'overdue', bell: 292 }), SV.arrivalView({ state: 'settledUnverified', why: 'vault', recorded: [400, 0, 0, 0, 0, 0, 0, 0] }), SV.arrivalView({ state: 'verifiedPartial', basis: 'sentRecord', sent: [400, 0, 0, 0, 0, 0, 0, 0], arrived: [250, 0, 0, 0, 0, 0, 0, 0] }), SV.arrivalView({ state: 'verifiedFull', basis: 'sentRecord', sent: [400, 0, 0, 0, 0, 0, 0, 0], arrived: [400, 0, 0, 0, 0, 0, 0, 0] }), SV.arrivalView({ state: 'lost', recorded: [400, 0, 0, 0, 0, 0, 0, 0] }),
  SV.costView({ phase: 'reserved', amounts: [0, 50, 0, 0, 0, 0, 0, 0] }), SV.costView({ phase: 'committed', amounts: [0, 50, 0, 0, 0, 0, 0, 0] }), SV.costView({ phase: 'unsettled' }), SV.costView({ phase: 'released', amounts: [0, 50, 0, 0, 0, 0, 0, 0] }),
  SV.manualView({ signedPending: 1 }), SV.cancelView({ stage: '?' }),
].map(v => SV.renderStatus(v))}`);
look();
