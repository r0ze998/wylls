// Synthetic, read-only browser fixture for the wide holding UI. No wallet, no chain, no controller/app/session modules.
import { decode } from '/web/frontier/fcodec.mjs';
import { render as renderHolding } from '/web/frontier/screens/holding.mjs';
import { renderRail, renderRest } from '/web/frontier/hud/hud.mjs';
import { selectWide, clearWideSelect } from '/web/frontier/fwide.mjs';
import { setLang } from '/web/lang.mjs';
import { setHtml } from '/web/util.mjs';
import { fromBase64 } from '/web/sdk/bytes.mjs';
import { SCENARIOS, makeFixture } from '/fixture/data.mjs';

const $ = id => document.getElementById(id);
const body = document.body, panel = $('panel'), rail = $('rail'), pbody = $('panel-body');
const ALLOW = new Set(['wide-select', 'wide-close', 'home', 'holding-go', 'me-retry']);
const PHONE = matchMedia('(max-width: 759px)');
let season = null, FS = null, scenario = SCENARIOS[0]?.id ?? 'captured';
let view = 'rest'; // 'rest' (closed sheet / desktop rail) | 'village' (holding drawer open)
let sheet = 'peek';

const lang = () => (document.documentElement.lang || 'ja').slice(0, 2);
const T = (ja, en) => (lang() === 'en' ? en : ja);
const status = msg => { $('fx-status').textContent = msg; };
const fail = (where, e) => { console.error(where, e); status(`FIXTURE ERROR (${where}): ${e?.message ?? e}`); };
window.addEventListener('error', e => fail('window', e.error ?? e.message));
window.addEventListener('unhandledrejection', e => fail('promise', e.reason));

function rebaseArt(root) {
  for (const el of root.querySelectorAll('[src^="art/"], [href^="art/"]')) {
    for (const a of ['src', 'href']) { const v = el.getAttribute(a); if (v && v.startsWith('art/')) el.setAttribute(a, '/web/frontier/' + v); }
  }
}
function markBlocked(root) {
  for (const el of root.querySelectorAll('button, a[href], input, select, textarea, form')) {
    const act = el.dataset.act;
    if (act && ALLOW.has(act)) continue;
    if (el.tagName === 'FORM') { el.dataset.fixtureBlocked = 'submit'; continue; }
    el.dataset.fixtureBlocked = 'true'; el.setAttribute('aria-disabled', 'true');
    el.title = T('フィクスチャ：この操作は無効です（読み取り専用）', 'Fixture: this control is inert (read only)');
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') el.disabled = true;
  }
}

function paint() {
  if (!FS) return;
  const open = view === 'village', wide = !!FS.wideSelect;
  // Real hud/drawer.mjs WIDE covers practice/report only; a wide holding keeps data-doc='' (normal holding geometry).
  const doc = '';
  const sh = open ? (sheet === 'peek' ? 'full' : sheet) : sheet;
  for (const el of [body, panel]) { el.dataset.drawer = open ? 'open' : 'closed'; el.dataset.doc = doc; el.dataset.sheet = sh; }
  panel.dataset.kind = open ? 'holding' : 'rest';
  body.dataset.fixtureView = view; body.dataset.fixtureWide = String(wide); body.dataset.fixtureScenario = scenario;
  $('panel-title').textContent = open ? (wide ? T('飛び地の村（フィクスチャ）', 'Wide village (fixture)') : T('村（フィクスチャ）', 'Village (fixture)')) : '';
  setHtml(rail, renderRail(FS));
  setHtml(pbody, open ? renderHolding(FS) : renderRest(FS, { next: '' }));
  for (const root of [rail, pbody]) { rebaseArt(root); markBlocked(root); }
  for (const b of document.querySelectorAll('[data-fx="sheet"]')) b.setAttribute('aria-pressed', String(b.dataset.sheet === sh));
  for (const b of document.querySelectorAll('[data-fx="lang"]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang()));
  $('fx-state').textContent = `viewport ${innerWidth}×${innerHeight} (${PHONE.matches ? 'phone sheet' : 'desktop rail'}) · scenario=${scenario} · lang=${lang()}`
    + ` · view=${view} · wide-selected=${wide}${wide ? ` slot=${FS.wideSelect?.inventorySlot ?? FS.wideSelect}` : ''} · sheet=${sh} · synthetic data, no wallet/chain`;
}

function build(sc) {
  scenario = sc; view = 'rest'; sheet = 'peek';
  $('fx-scenario').value = sc;
  try { FS = makeFixture(sc, season); if (FS.wideSelect) clearWideSelect(FS); status(''); }
  catch (e) { FS = null; fail(`makeFixture(${sc})`, e); }
  paint();
}

const acts = {
  'wide-select': d => { const ok = selectWide(FS, Number(d.slot)); if (ok === false) return status(T('選べない村です（フィクスチャ）', 'Fixture: that village cannot be selected')); view = 'village'; },
  'wide-close': () => { clearWideSelect(FS); view = 'village'; },
  home: () => { if (FS) clearWideSelect(FS); view = 'rest'; },
  'holding-go': () => { view = 'rest'; status(T('フィクスチャ：地図は表示されません（プレースホルダー）', 'Fixture: no map here, placeholder only')); },
  'me-retry': () => { build('captured'); status(T('フィクスチャ復旧：固定の captured データに戻しました', 'Fixture recovery: restored the fixed captured data')); },
};

function onGameClick(e) {
  const el = e.target.closest('button, a, [data-act], input, label');
  if (!el || $('fx-bar').contains(el)) return;
  const act = el.dataset.act;
  if (act && ALLOW.has(act)) { e.preventDefault(); e.stopPropagation(); try { acts[act](el.dataset); paint(); } catch (err) { fail(act, err); } return; }
  if (el.classList.contains('sheet-handle')) { e.preventDefault(); return status(T('フィクスチャ：シートはツールバーのボタンで動かします', 'Fixture: move the sheet with the toolbar buttons')); }
  e.preventDefault(); e.stopPropagation();
  status(T(`フィクスチャ：実行できません（${act || el.tagName.toLowerCase()}）— 読み取り専用、ウォレット/チェーンなし`,
    `Fixture refusal: "${act || el.tagName.toLowerCase()}" is not runnable here — read only, no wallet/chain`));
}
for (const root of [panel, rail]) root.addEventListener('click', onGameClick, true);
document.addEventListener('submit', e => { e.preventDefault(); e.stopPropagation(); status(T('フィクスチャ：送信は無効', 'Fixture: form submit blocked')); }, true);
document.addEventListener('change', e => { if (!$('fx-bar').contains(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true);

$('fx-bar').addEventListener('click', e => {
  const b = e.target.closest('[data-fx]'); if (!b) return;
  try {
    if (b.dataset.fx === 'reset') build(scenario);
    else if (b.dataset.fx === 'lang') { setLang(b.dataset.lang); document.documentElement.lang = b.dataset.lang; }
    else if (b.dataset.fx === 'village') { clearWideSelect(FS); view = 'village'; }
    else if (b.dataset.fx === 'map') { if (FS) clearWideSelect(FS); view = 'rest'; sheet = 'peek'; }
    else if (b.dataset.fx === 'sheet') sheet = b.dataset.sheet;
    paint();
  } catch (err) { fail(`fixture:${b.dataset.fx}`, err); }
});
$('fx-scenario').addEventListener('change', e => build(e.target.value));
addEventListener('resize', paint); PHONE.addEventListener('change', paint);

(async () => {
  const sel = $('fx-scenario');
  for (const s of SCENARIOS) sel.append(Object.assign(document.createElement('option'), { value: s.id, textContent: s.label }));
  try {
    const r = await fetch('/fixture/season.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`season.json HTTP ${r.status}`);
    const j = await r.json();
    season = decode('Season', fromBase64(j.bytes_b64));
  } catch (e) { fail('season.json', e); return; }
  build(scenario);
})();
