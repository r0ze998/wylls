// Browser fixture for the wide-economy host recordings. View only: no wallet, no chain, no submit, no simulation.
//
// The village card is the production renderer (screens/holding.mjs, a wide village selected) fed the ORIGINAL recorded
// before / after bytes through the production parser. Nothing here continues, projects, subtracts or completes an economy.
// Imports are the pure renderers/parsers only: no controller, app, session, wallet or worker module. Fixture chrome is
// built with DOM text nodes (never innerHTML); the only HTML strings are the production renderer's own output.
import { loadCase, fetchReader, CASE_NAMES, EXPECTED } from './model.mjs';
import { render as renderHolding } from '/permutation-server/web/frontier/screens/holding.mjs';
import { selectWide, clearWideSelect } from '/permutation-server/web/frontier/fwide.mjs';
import { setLang, lang as currentLang } from '/permutation-server/web/lang.mjs';
import { setHtml } from '/permutation-server/web/util.mjs';

const $ = id => document.getElementById(id);
const body = document.body, panel = $('panel'), pbody = $('panel-body'), notes = $('fx-notes');
const ALLOW = new Set(['wide-close', 'home']); // the only game-markup actions handled: close the card
const PHONE = matchMedia('(max-width: 759px)');
const ART = '/permutation-server/web/frontier/';

let caseName = CASE_NAMES[0];
let phase = 'before';     // 'before' | 'after': which recorded snapshot the production card shows
let view = 'open';        // 'open' | 'closed': the village card
let sheet = 'full';       // phone sheet state (fixture buttons only)
let st = 'loading';       // 'loading' | 'ready' | 'error'
let cur = null;           // the built case, only while st === 'ready'
let err = null;
let token = 0;            // load generation: a result of any older load is dropped
let notesKey = '';

const lang = () => (currentLang() === 'en' ? 'en' : 'ja');
const T = (ja, en) => (lang() === 'en' ? en : ja);
const status = msg => { $('fx-status').textContent = msg; };
const fail = (where, e) => { console.error(where, e); status(`FIXTURE ERROR (${where}): ${e?.message ?? e}`); };
window.addEventListener('error', e => fail('window', e.error ?? e.message));
window.addEventListener('unhandledrejection', e => fail('promise', e.reason));

// ------------------------------------------------------------------ tiny DOM helper (text only)
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}
const code = (s, cls = 'fx-code') => h('code', { class: cls }, s);
const scroll = (label, table) => h('div', { class: 'fx-scroll', tabindex: 0, role: 'region', 'aria-label': label }, table);
const actionText = a => (a.kind === 'Harvest' ? 'Harvest' : a.kind === 'Build' ? `Build item ${a.item}` : `Train unit ${a.unit} × ${a.n}`);
const utc = s => { const v = BigInt(s); return v > 0n && v < 253402300799n ? new Date(Number(v) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : null; };

function table(label, head, rows, cls = '') {
  return scroll(label, h('table', { class: `fx-table ${cls}` },
    h('caption', { class: 'fx-visually-hidden' }, label),
    h('thead', {}, h('tr', {}, head.map(c => h('th', { scope: 'col' }, c)))),
    h('tbody', {}, rows.map(r => h('tr', { class: r.changed ? 'fx-changed' : '' },
      r.cells.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', {}, c))))))));
}
function dl(pairs) {
  return h('dl', { class: 'fx-facts' }, pairs.filter(Boolean).map(([k, v]) => h('div', { class: 'fx-row' }, h('dt', {}, k), h('dd', {}, v))));
}
const section = (title, ...kids) => h('section', { class: 'fx-sec' }, h('h2', {}, title), ...kids);

// ------------------------------------------------------------------ production markup helpers
function rebaseArt(root) {
  for (const el of root.querySelectorAll('[src^="art/"], [href^="art/"]')) {
    for (const a of ['src', 'href']) { const v = el.getAttribute(a); if (v && v.startsWith('art/')) el.setAttribute(a, ART + v); }
  }
}
function markBlocked(root) {
  for (const el of root.querySelectorAll('button, a[href], input, select, textarea, form')) {
    if (el.dataset.act && ALLOW.has(el.dataset.act)) continue;
    if (el.tagName === 'FORM') { el.dataset.fixtureBlocked = 'submit'; continue; }
    el.dataset.fixtureBlocked = 'true'; el.setAttribute('aria-disabled', 'true');
    el.title = T('フィクスチャ：この操作は無効です（表示専用）', 'Fixture: this control is inert (view only)');
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') el.disabled = true;
  }
}

// ------------------------------------------------------------------ inspector (fixture chrome)
function warningBox() {
  return h('section', { class: 'fx-warn', role: 'note' },
    h('p', {}, h('strong', {}, T('これは記録の表示です。実行ではありません。', 'This shows recorded data. Nothing is run.'))),
    h('p', {}, T(
      '各ケースはホストでの1回のディスパッチの記録で、ケース間で在庫は手動でリセットされています。前後の差には、遅延加算（lazy accrual）と、そのディスパッチが決済した「それ以前に積まれていた完了」が含まれます。その行動単体の価格・費用・産出ではありません。',
      'Each case is one recorded host dispatch, with the stock reset by hand between cases. A before/after difference includes lazy accrual and EARLIER queued completions settled by that dispatch. It is not the isolated price, cost or yield of the action.')),
    h('p', {}, T(
      '数値は記録された文字列そのままです。引き算・予測・完了の推定はしていません。「後」に残る建設の列は記録上の列であり、完了したとは言っていません。',
      'Figures are the exact recorded strings. Nothing is subtracted, projected or completed. A queue entry in the After snapshot is a recorded queue entry; this page does not say it finished.')));
}

function receiptSection(c) {
  const r = c.receipt, a = r.receipt;
  const t = utc(a.now);
  return section(T('レシート（構造のみ・未検証）', 'Receipt (structural decode, unverified)'),
    dl([
      [T('行動', 'Action'), `${actionText(a.action)}  (${a.actionHex})`],
      [T('種別', 'Kind'), `${r.kindName} · ${r.size} B`],
      ['bell', String(r.bell)],
      ['now', t ? `${a.now}  (${t})` : a.now],
      [T('最終フラグ', 'final flag'), String(a.final)],
      [T('保有地キー', 'Holding key'), `P ${String(r.key.p)}, Q ${String(r.key.q)} · site ${r.key.site} · generation ${r.key.generation}`],
      [T('世界', 'World'), code(r.key.world)],
      [T('リンク', 'Links'), r.links.map(l => `entity ${l.entity} seq ${l.seq}`).join(' · ')],
    ]),
    h('p', { class: 'fx-muted' }, T('ダイジェスト・認可・リプレイ・チェーン状態は確認していません。', 'Digests, authorization, replay and chain state are not checked.')),
    h('div', { class: 'fx-datablock' },
      h('p', {}, h('span', { class: 'fx-badge' }, 'UNSIGNED · DATA ONLY'), ' ', T('インストラクションのデータ部分のみ', 'instruction data bytes only')),
      code(c.instructionDataHex, 'fx-code fx-datahex'),
      h('p', { class: 'fx-muted' }, T('アカウントなし・署名なし・トランザクションなし。このページは送信できません。', 'No accounts, no signature, no transaction. This page cannot send it.'))));
}

function changesSection(c) {
  const d = c.diff;
  const storeRows = d.stores.map(s => ({
    changed: s.changedFields.length > 0,
    cells: [s.resource, s.before.value, s.after.value,
      s.changedFields.length ? T('変化あり', 'changed') : T('同じ', 'same'),
      s.changedFields.filter(f => f !== 'value').map(f => `${f}: ${s.before[f]} → ${s.after[f]}`).join(' · ') || '—'],
  }));
  const qcell = x => `kind ${x.kind} · arg ${x.arg} · doneAt ${x.doneAt} · delta ${x.delta}${x.inUse === 'true' ? '' : T('（未使用）', ' (unused)')}`;
  const queueRows = d.queue.map(q => ({ changed: q.changedFields.length > 0, cells: [`#${q.index}`, qcell(q.before), qcell(q.after), q.changedFields.length ? T('変化あり', 'changed') : T('同じ', 'same')] }));
  const reserveRows = d.reserve.map(r => ({ changed: r.changed, cells: [`reserve[${r.index}]`, r.before, r.after, r.changed ? T('変化あり', 'changed') : T('同じ', 'same')] }));
  const scalarRows = Object.entries(d.scalars).map(([k, v]) => ({ changed: v.changed, cells: [k, v.before, v.after, v.changed ? T('変化あり', 'changed') : T('同じ', 'same')] }));
  const groups = d.changed;
  const ba = [T('項目', 'Item'), T('前（記録）', 'Before (recorded)'), T('後（記録）', 'After (recorded)'), T('差異', 'Differs')];
  return section(T('変化（記録された文字列そのまま）', 'Changes (exact recorded strings)'),
    h('p', { class: 'fx-muted' }, T('単位は記録上の milli 単位。計算はしていません。', 'Stored milli-units, exactly as recorded. No arithmetic.')),
    h('p', { class: 'fx-muted' }, `${T('変化のあるグループ', 'Groups that differ')}: stores [${groups.stores.join(', ')}] · queue [${groups.queue.join(', ')}] · reserve [${groups.reserve.join(', ')}] · scalars [${groups.scalars.join(', ')}]`),
    h('h3', {}, T('資源', 'Stores')),
    table(T('資源', 'Stores'), [T('品目', 'Resource'), ba[1], ba[2], ba[3], T('その他の変化', 'Other fields')], storeRows),
    h('h3', {}, T('建設の列', 'Queue')),
    table(T('建設の列', 'Queue'), ba, queueRows),
    h('h3', {}, T('控え', 'Reserve')),
    table(T('控え', 'Reserve'), ba, reserveRows),
    h('h3', {}, T('そのほか', 'Other record fields')),
    table(T('そのほか', 'Other record fields'), ba, scalarRows));
}

function provenanceSection(c) {
  const p = c.pins, pb = c.province.before, pa = c.province.after;
  const prov = x => `${x.magic} · ${x.size} B · layout ${x.layoutVersion} · family ${x.familyVersion} · season ${x.season} · ring ${x.ring} wedge ${x.wedge} · P ${x.p}, Q ${x.q}`;
  return section(T('出どころ・限界', 'Provenance and limits'),
    h('p', {}, c.provenance[lang()]),
    h('p', {}, c.synthetic.note[lang()]),
    dl([
      [T('合成スロット', 'Synthetic slot'), `${c.synthetic.slot} · archive ${c.synthetic.archiveSequence}`],
      [T('検証', 'Verification'), c.verification],
      [T('プログラム', 'Program'), code(p.program)],
      [T('ウォレット（公開リテラル）', 'Wallet (public literal)'), h('span', {}, code(p.wallet), ' ', p.literal)],
      [T('シーズン', 'Season'), h('span', {}, `${p.seasonId} · `, code(p.seasonAddress))],
      [T('市民口座', 'Citizen account'), code(p.citizenAddress)],
      [T('世界', 'World'), code(p.world)],
      [T('保有地口座', 'Holding account'), code(p.holdingAddress)],
      [T('州（前）', 'Province (before)'), prov(pb)],
      [T('州（後）', 'Province (after)'), prov(pa)],
    ]),
    h('p', { class: 'fx-muted' }, T('州の欄は識別メタデータのみで、州の状態や履歴の証明ではありません。', 'The province lines are identity metadata only, not proof of province state or history.')),
    h('h3', {}, T('SHA-256 ピン（8ファイル）', 'SHA-256 pins (8 files)')),
    h('ul', { class: 'fx-pins' }, Object.entries(c.hashPins).map(([f, hx]) => h('li', {}, h('span', {}, f), ' ', code(hx)))),
    h('p', { class: 'fx-muted' }, c.pinNote[lang()]));
}

function buildNotes() {
  const root = h('div', { class: 'fx-notes-inner' }, warningBox());
  const want = EXPECTED[caseName];
  root.append(h('p', { class: 'fx-casehead' }, h('strong', {}, `${caseName}`), ` — ${T('記録された行動', 'recorded action')}: ${actionText(want)}`));
  if (st === 'loading') {
    root.append(h('p', { class: 'fx-box', role: 'status' }, T('読み込み中…（固定8ファイル）', 'Loading… (the fixed 8 files)')));
  } else if (st === 'error') {
    root.append(h('div', { class: 'fx-box fx-error', role: 'alert' },
      h('p', {}, h('strong', {}, T('このケースを表示できません', 'This case cannot be shown')), ` (${err?.code ?? 'Error'})`),
      h('p', {}, String(err?.message ?? err)),
      h('p', { class: 'fx-muted' }, T('何も表示せず、推測もしません。', 'Nothing is shown and nothing is guessed.')),
      h('button', { type: 'button', class: 'fx-btn', 'data-fx': 'retry' }, T('このケースを再試行', 'Retry this case'))));
  } else if (cur) {
    root.append(receiptSection(cur), changesSection(cur), provenanceSection(cur));
  }
  return root;
}

// ------------------------------------------------------------------ paint
function setMessage(el, ...kids) { el.__html = undefined; el.replaceChildren(...kids); }

function paint() {
  const ready = st === 'ready' && cur;
  const open = view === 'open';
  const snap = ready ? cur[phase] : null;
  let rendered = false;
  if (snap) {
    try {
      // the production selection follows the card's visibility; selecting is idempotent, so close/reopen/repeats are safe
      if (open) {
        if (selectWide(snap.FS, snap.holding.inventorySlot) === false) throw new Error('the production parser did not select the recorded slot');
      } else clearWideSelect(snap.FS);
    } catch (e) { fail('select', e); }
  }
  for (const el of [body, panel]) { el.dataset.drawer = open ? 'open' : 'closed'; el.dataset.doc = ''; el.dataset.sheet = sheet; }
  panel.dataset.kind = open ? 'holding' : 'rest';
  body.dataset.fixtureCase = caseName; body.dataset.fixturePhase = phase; body.dataset.fixtureState = st; body.dataset.fixtureView = view;
  // the title names the visible recorded state, so it stays legible when the phone sheet covers the inspector
  $('panel-title').textContent = open ? `${caseName} · ${phase === 'after' ? T('後（記録）', 'After (recorded)') : T('前（記録）', 'Before (recorded)')}` : '';

  if (!open) setMessage(pbody);
  else if (snap) {
    try {
      const markup = renderHolding(snap.FS);
      if (markup && String(markup.s ?? markup).length) { setHtml(pbody, markup); rebaseArt(pbody); markBlocked(pbody); rendered = true; }
    } catch (e) { fail('renderHolding', e); }
    if (!rendered) setMessage(pbody, h('p', { class: 'fx-box fx-error' }, T('カードを描画できません。', 'The production card did not render.')));
  } else if (st === 'loading') setMessage(pbody, h('p', { class: 'fx-box', role: 'status' }, T('読み込み中…', 'Loading…')));
  else setMessage(pbody, h('p', { class: 'fx-box fx-error', role: 'alert' }, T('このケースは表示できません（右または上の理由を参照）。', 'This case cannot be shown (see the reason in the inspector).')));

  const key = `${st}|${caseName}|${lang()}|${token}`;
  if (key !== notesKey) { notesKey = key; notes.replaceChildren(buildNotes()); }

  $('fx-banner-text').textContent = T('ホスト・フィクスチャ · ホスト実行の記録 · 表示専用 · ウォレットなし · チェーンなし · 送信なし',
    'HOST FIXTURE · RECORDED HOST DISPATCHES · VIEW ONLY · NO WALLET · NO CHAIN · NO SUBMIT');
  $('fx-card-toggle').textContent = open ? T('カードを閉じる', 'Close card') : T('カードを開く', 'Open card');
  $('fx-retry').disabled = st !== 'error';
  $('fx-case').value = caseName;
  for (const b of document.querySelectorAll('[data-fx="phase"]')) b.setAttribute('aria-pressed', String(b.dataset.phase === phase));
  for (const b of document.querySelectorAll('[data-fx="lang"]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang()));
  for (const b of document.querySelectorAll('[data-fx="sheet"]')) b.setAttribute('aria-pressed', String(b.dataset.sheet === sheet));
  $('fx-state').textContent = `viewport ${innerWidth}×${innerHeight} (${PHONE.matches ? 'phone sheet' : 'desktop drawer'}) · case=${caseName} · snapshot=${phase} (recorded, not run)`
    + ` · lang=${lang()} · card=${view} · state=${st}${PHONE.matches ? ` · sheet=${sheet}` : ''} · host recordings, no wallet/chain/submit`;
}

// ------------------------------------------------------------------ loading (stale results are dropped; a change clears the card at once)
async function selectCase(name) {
  if (!CASE_NAMES.includes(name)) return;
  const mine = ++token;
  caseName = name; cur = null; err = null; st = 'loading';
  status('');
  paint(); // the previous case's card and tables are gone before anything is fetched
  const base = fetchReader();
  const read = async (n, f) => { if (mine !== token) throw new Error('superseded'); return base(n, f); };
  try {
    const c = await loadCase(name, read);
    if (mine !== token) return;
    cur = c; st = 'ready';
  } catch (e) {
    if (mine !== token) return;
    cur = null; err = e; st = 'error';
    console.error('load', name, e);
  }
  paint();
}

// ------------------------------------------------------------------ events
function onGameClick(e) {
  const el = e.target.closest('button, a, [data-act], input, label');
  if (!el) return;
  const act = el.dataset.act;
  if (act && ALLOW.has(act)) { e.preventDefault(); e.stopPropagation(); view = 'closed'; paint(); return; }
  if (el.classList.contains('sheet-handle')) { e.preventDefault(); return status(T('フィクスチャ：シートはボタンで動かします', 'Fixture: move the sheet with the fixture buttons')); }
  e.preventDefault(); e.stopPropagation();
  status(T(`フィクスチャ：実行できません（${act || el.tagName.toLowerCase()}）— 表示専用、ウォレット/チェーンなし`,
    `Fixture refusal: "${act || el.tagName.toLowerCase()}" is not runnable here — view only, no wallet/chain`));
}
panel.addEventListener('click', onGameClick, true);
document.addEventListener('submit', e => { e.preventDefault(); e.stopPropagation(); status(T('フィクスチャ：送信は無効', 'Fixture: form submit blocked')); }, true);
panel.addEventListener('change', e => { e.preventDefault(); e.stopPropagation(); }, true);

document.addEventListener('click', e => {
  const b = e.target.closest('[data-fx]');
  if (!b || panel.contains(b)) return;
  try {
    const fx = b.dataset.fx;
    if (fx === 'phase') phase = b.dataset.phase === 'after' ? 'after' : 'before';
    else if (fx === 'lang') { setLang(b.dataset.lang); document.documentElement.lang = lang(); }
    else if (fx === 'sheet') sheet = b.dataset.sheet === 'half' ? 'half' : 'full';
    else if (fx === 'card') view = view === 'open' ? 'closed' : 'open';
    else if (fx === 'retry') { if (st === 'error') selectCase(caseName); return; } // fixed selection only
    paint();
  } catch (err2) { fail(`fixture:${b.dataset.fx}`, err2); }
});
$('fx-case').addEventListener('change', e => { selectCase(e.target.value); });
addEventListener('resize', paint);
PHONE.addEventListener('change', paint);

(function init() {
  const sel = $('fx-case');
  for (const n of CASE_NAMES) sel.append(h('option', { value: n }, `${n} — ${actionText(EXPECTED[n])}`));
  document.documentElement.lang = lang();
  selectCase(caseName);
})();
