// `?fx=hand-…`: the panels of a conquest season shown alone, from records of finished runs on the local test chain
// (hud/handdemo-data.mjs), under the demo tag. Like the effects demo (fx/demo.mjs) it is the labelled exception to
// "every moment on the board is driven by a record of the chain": the tag says so for as long as a sample stands, the
// page's own state (`FS`) is never written, and without `?fx=hand-…` this file is not loaded.
//
//   ?fx=hand-keep            the keep's panel, a contest running (Aster on Fjordal's keep, 41 / 72 turns)
//   ?fx=hand-keep-taken      the same keep after its capture: the history with the capture's signature and the caption
//   ?fx=hand-keep-wait       the same keep while the viewer's host is forming up (the turn from which it can depart)
//   ?fx=hand-keeps           the host's card "March on a keep": three keeps in reach
//   ?fx=hand-strip           "Provinces held", the count rising when the capture record arrives
//   ?fx=hand-prize           the prize panel after Tally and Finalize, with the contribution lines and the estimate
//   ?fx=hand-season-end      the season-end card
//   ?fx=hand-verify          the battle report's caption, the record's slot and the "Match" stamp
//   &fxv=<nation 0–5>        the viewer's nation in the sample (default 0, Aster)
import { html, setHtml } from '../../util.mjs';
import { hostId } from '../faddr.mjs';
import { L, onLangChange } from '../../lang.mjs';
import { renderKeep } from '../screens/conquest.mjs';
import { render as renderPrize } from '../screens/prize.mjs';
import { resultText } from '../screens/report.mjs';
import { icon } from './icons.mjs';
import { renderKeepsPop, sigChip } from './keephand.mjs';
import { stripModel, renderStrip, changedCounts, seasonEndModel, renderSeasonEnd } from './provstrip.mjs';
import { KEEP_4_M1, STANDINGS_BEFORE, STANDINGS_AFTER, POOL_FINAL, LEDGER, CLASH_REF, keepAt, recordAt } from './handdemo-data.mjs';
import { fmtNum } from '../../lang.mjs';
import { unitCount } from '../fi18n.mjs';
import { UNIT_ORDER } from '../fland.mjs';
import { hostRows } from '../screens/host.mjs';

export const HAND_SAMPLES = Object.freeze(['hand-keep', 'hand-keep-taken', 'hand-keep-wait', 'hand-keeps', 'hand-strip', 'hand-prize', 'hand-season-end', 'hand-verify']);

const season = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, minLead: 2, maxLead: 144, conquestParams: { keepBells: 72 } };
/** A store of the sample's own (never the page's): the season of the records, the viewer's nation, the turn. */
export function sampleStore({ bell = 52, faction = 0, extra = {} } = {}) {
  const keep = keepAt(KEEP_4_M1, bell);
  return { mode: 'play', season, nowBell: bell, citizen: { faction }, holdings: [], provinces: new Map(), inFlight: 0, chain: { now: () => 0 }, wallet: null,
    conquest: { status: 'ready', keeps: new Map([['4,-1', keep]]), history: new Map([['4,-1', recordAt(KEEP_4_M1, bell)]]), standings: bell >= 84 ? STANDINGS_AFTER : STANDINGS_BEFORE, final: null, events: [] }, ...extra };
}

/** The sample's store with the viewer's village (province 2,0) and one host of 500 Spearmen in that province's record. */
function withHost(FS, { state, fromBell }) {
  const home = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: FS.citizen.faction, state: 2, order: 1, tier: 0, flags: 0, stores: [], reserve: Array(8).fill(0), queue: [], transit: [{ state: 0 }], explore: { state: 0 }, finalTs: 1n };
  const entry = { id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state, tile: 20, troops: 500000, staminaValue: 120, staminaBell: FS.nowBell, readyBell: 0, pendOp: 0, fromBell };
  return Object.assign(FS, { holdings: [home], land: { stage: 'final' }, chain: { now: () => 1000 }, provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: FS.nowBell, entries: [entry], ticketCohorts: [] } }]]) });
}
const popHead = (title, sub = '') => html`<div class="pop-head"><strong class="pop-title">${title}</strong>${sub ? html`<span class="pop-sub">${sub}</span>` : ''}</div>`;
const route = (hexes, provinces, secs) => ({ hexes, provinces: Array.from({ length: provinces }, (_, i) => i), secs });

/** The markup of a sample and where it stands: `{place: 'sheet' | 'pop' | 'strip' | 'end', markup, after?}`. */
export function sampleOf(name, { faction = 0 } = {}) {
  if (name === 'hand-keep') { const FS = sampleStore({ bell: 52, faction }); return { place: 'sheet', markup: renderKeep(FS, FS.conquest.keeps.get('4,-1')) }; }
  if (name === 'hand-keep-taken') { const FS = sampleStore({ bell: 92, faction }); return { place: 'sheet', markup: renderKeep(FS, FS.conquest.keeps.get('4,-1')) }; }
  if (name === 'hand-keep-wait') {
    // (the viewer's host mustered at turn 9 stands from turn 11: the record's `fromBell`)
    const FS = withHost(sampleStore({ bell: 9, faction }), { state: 2, fromBell: 11 });
    return { place: 'sheet', markup: renderKeep(FS, FS.conquest.keeps.get('4,-1')) };
  }
  if (name === 'hand-keeps') {
    const FS = withHost(sampleStore({ bell: 9, faction }), { state: 1, fromBell: 8 });
    const r = hostRows(FS)[0];
    FS.conquest.keeps.set('4,-2', { ...keepAt(KEEP_4_M1, 9), q: -2, tile: 4 });
    FS.conquest.keeps.set('0,4', { p: 0, q: 4, tile: 26, holder: 1, troops: 0, heartland: false, consolidatedUntil: 0, contender: 0, progress: 33, requiredBells: 72, asOfBell: 9 });
    FS.conquest.hostReach = { key: 'sample', host: String(r.id), ok: true, unreachable: [], rows: [
      { p: 4, q: -2, tile: 4, holder: 5, troops: 100, route: route(12, 4, 1680) }, { p: 4, q: -1, tile: 10, holder: 5, troops: 100, route: route(13, 3, 1800) }, { p: 0, q: 4, tile: 26, holder: 1, troops: 0, route: route(19, 4, 2460) }] };
    return { place: 'pop', markup: renderKeepsPop(FS, { host: { ...r, id: String(r.id) }, name: unitCount(UNIT_ORDER[r.unit], r.troops) }, { head: popHead }) };
  }
  if (name === 'hand-strip') {
    const a = stripModel(sampleStore({ bell: 82, faction })), b = stripModel(sampleStore({ bell: 92, faction }));
    return { place: 'strip', markup: renderStrip(a), after: { markup: renderStrip(b), changed: changedCounts(a, b) } };
  }
  if (name === 'hand-prize') return { place: 'sheet', markup: renderPrize({ ...sampleStore({ bell: 96, faction }), prize: POOL_FINAL, prizeLedger: LEDGER }) };
  if (name === 'hand-season-end') return { place: 'end', markup: renderSeasonEnd(seasonEndModel({ ...sampleStore({ bell: 96, faction }), prize: POOL_FINAL })) };
  if (name === 'hand-verify') {
    const v = { result: 'match' };
    return { place: 'sheet', markup: html`<section class="report doc"><footer class="doc-foot"><p class="rep-recheck">${icon('check')}<span><strong>${L`戦い：公開された記録から、このブラウザで計算し直します`}</strong> <span class="muted">${L`（記録のスロット ${fmtNum(CLASH_REF.slot)}）`}</span></span></p>
      <p class="notice ok" role="status" data-verify-result="match"><span class="rep-match">${L`一致`}</span><span>${resultText(v)}</span></p>${CLASH_REF.sig ? html`<p class="rep-ref">${sigChip(CLASH_REF.sig, { label: L`戦いの記録の署名` })}</p>` : ''}</footer></section>` };
  }
  return null;
}

/** Start the samples named in `?fx=` (app.mjs calls this only when one of them is). */
export function startHandDemo({ params, doc = globalThis.document }) {
  const names = String(params.get('fx') ?? '').split(',').map(s => s.trim()).filter(n => HAND_SAMPLES.includes(n));
  if (!names.length || !doc?.createElement) return null;
  const faction = Math.max(0, Math.min(5, Number(params.get('fxv') ?? 0) || 0));
  const host0 = doc.createElement('div');
  host0.className = 'hand-demo-root';
  doc.body.append(host0);
  const draw = () => {
    host0.replaceChildren();
    for (const name of names) {
      const s = sampleOf(name, { faction });
      if (!s) continue;
      const el = doc.createElement('div');
      el.className = { sheet: 'hand-demo', pop: 'hand-demo-pop hand-pop', strip: 'hand-demo-strip', end: 'season-end' }[s.place];
      el.dataset.sample = name;
      // (the sample's own tag, on the sample: what it is and where its figures come from)
      el.dataset.tag = L`見本 · 終わった実行の記録から`;
      setHtml(el, s.markup);
      host0.append(el);
      if (s.after) setTimeout(() => {
        if (!el.isConnected) return;
        setHtml(el, s.after.markup);
        for (const c of s.after.changed) { const n = el.querySelector(`.ps-n[data-f="${c.faction}"]`); if (n) { n.dataset.delta = `${c.to > c.from ? '+' : '−'}${Math.abs(c.to - c.from)}`; n.classList.add(c.to > c.from ? 'ps-up' : 'ps-down'); } }
      }, 1800);
    }
  };
  draw();
  onLangChange(draw);
  return { names };
}
