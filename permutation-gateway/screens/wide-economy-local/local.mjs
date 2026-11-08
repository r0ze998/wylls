// Browser UI of the LOCAL wide-economy demo. A LOCAL SIMULATION with MOCK authorization: no wallet, no chain, no real transaction.
//
// The village card is the production renderer (screens/holding.mjs, a wide village selected) fed the host's bytes through
// the production parser (see local-model.mjs). Its markup is made inert after every render. The LOCAL controls live outside
// it. Nothing here computes an economy: no cost, price, yield, accrual, queue or completion is calculated.
// Imports are pure model/renderer modules only: no controller, app, session or wallet module. Chrome is built with DOM text
// nodes; the only HTML string inserted is the production renderer's own output.
import { createClient } from './local-client.mjs';
import { ADVANCE_SECONDS, BUILD_ITEMS, TRAIN_UNITS, INITIAL_FILES, initialRoute, loadInitial } from './local-model.mjs';
import { render as renderHolding } from '/permutation-server/web/frontier/screens/holding.mjs';
import { selectWide } from '/permutation-server/web/frontier/fwide.mjs';
import { setHtml } from '/permutation-server/web/util.mjs';

const $ = id => document.getElementById(id);
const pbody = $('panel-body');

// Captions only. They name selector entries; they state no cost, effect or rule.
const BUILD_LABEL = ['農場', '伐採場', '石切り場', '鉱山', '造幣所', '書庫', '城壁', '昇格', '工房'];
const UNIT_LABEL = ['槍兵', '弓兵', '騎兵', '長槍兵', '弩兵', '騎士', '斥候'];

let client = null;

const phaseText = {
  init: '読み込み中…', loading: 'ホストと通信中…', ready: 'ローカルシミュレーション稼働中',
  error: '結果不明：表示を消しました。「状態を再取得」だけが復旧手段です（再送なし）',
  uncertain: 'ホストの状態が不確実です。操作を停止しました（自動の再送・再起動はしません）',
};
const utc = s => { const v = BigInt(s); return v > 0n && v < 253402300799n ? `${new Date(Number(v) * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC` : ''; };
const outcomeText = { ok: '成功', refused: '拒否', uncertain: '不確実' };

function lastText(s) {
  const r = s.lastResult;
  const parts = [];
  if (r) parts.push(`${r.command} → ${outcomeText[r.outcome] ?? r.outcome}${r.code ? ` (${r.code})` : ''}${r.revision === null || r.revision === undefined ? '' : ` · rev ${r.revision}`}`);
  const rec = s.state?.record;
  if (rec) {
    const a = rec.receipt.action;
    const name = a.kind === 'Harvest' ? 'Harvest' : a.kind === 'Build' ? `Build #${a.item}` : `Train #${a.unit} × ${a.n}`;
    parts.push(`記録: ${name} @ ${rec.receipt.now}（構造のみ・未検証）`);
  }
  return parts.join(' ／ ') || '—';
}

function noticeOf(s) {
  if (s.phase === 'error') return ['error', `${s.error?.what === 'submit' ? '送信結果が不明です。' : '取得に失敗しました。'}(${s.error?.code ?? 'Error'}) 表示は消去しました。再送はしません。「状態を再取得」を押してください。`];
  if (s.phase === 'uncertain') return ['uncertain', `ホストの状態が不確実です（${s.reason?.stage ?? '?'} / ${s.reason?.code ?? '?'}）。以後の操作は受け付けません。再送も再起動もしません。このサーバーを止めて、もう一度起動してください。`];
  const n = s.notice;
  if (!n) return ['', ''];
  if (n.kind === 'stale') return ['stale', '他の操作で状態が先に更新されていました。最新の状態を表示しました。この操作は実行されていません。もう一度操作してください。'];
  if (n.kind === 'refused') return ['refused', `ホストが拒否しました（${n.code ?? '?'}）。状態は変わっていません。`];
  if (n.kind === 'ok') return ['ok', '実行しました。'];
  if (n.kind === 'not-sent') return ['not-sent', `送信されませんでした（${n.code}）。状態は変わっていません。`];
  if (n.kind === 'input') return ['input', `入力が不正です（${n.code}）。`];
  return ['', ''];
}

// ------------------------------------------------------------------ the production card, made inert
function makeInert(root) {
  for (const el of root.querySelectorAll('a, button, input, select, textarea, form, label[for], [data-act], [data-form], [role="button"]')) {
    el.setAttribute('data-lx-blocked', 'true');
    el.setAttribute('aria-disabled', 'true');
    el.removeAttribute('data-act'); el.removeAttribute('data-form');
    if (el.tagName === 'A') { el.removeAttribute('href'); el.removeAttribute('target'); el.setAttribute('tabindex', '-1'); }
    if (el.tagName === 'FORM') { el.removeAttribute('action'); el.removeAttribute('method'); }
    if ('disabled' in el) el.disabled = true;
    el.title = 'ローカルデモ：この本番カードは表示専用です';
  }
}
const swallow = e => {
  const t = e.target instanceof Element ? e.target : null;
  if (e.type === 'submit' || (t && t.closest('a, button, input, select, textarea, form, label, [role="button"], [data-lx-blocked]'))) { e.preventDefault(); e.stopPropagation(); }
};
for (const type of ['click', 'auxclick', 'submit', 'change', 'input', 'keydown', 'pointerdown']) $('panel').addEventListener(type, swallow, true);
document.addEventListener('submit', e => { e.preventDefault(); e.stopPropagation(); }, true);

// ------------------------------------------------------------------ paint
function paintCard(s) {
  if (!s.state) {
    pbody.__html = undefined;
    const p = document.createElement('p'); p.className = 'lx-hint';
    p.textContent = s.phase === 'ready' ? '' : '表示できる状態がありません。';
    pbody.replaceChildren(p);
    return;
  }
  try {
    const FS = s.state.FS;
    if (selectWide(FS, s.state.holding.inventorySlot) === false) throw new Error('the production parser did not select the slot');
    setHtml(pbody, renderHolding(FS));
    makeInert(pbody);
  } catch (e) {
    console.error('card', e);
    pbody.__html = undefined;
    const p = document.createElement('p'); p.className = 'lx-hint'; p.textContent = '本番カードを描画できませんでした。'; pbody.replaceChildren(p);
  }
}

function paint(s) {
  $('lx-phase').textContent = phaseText[s.phase] ?? s.phase;
  $('lx-clock').textContent = s.state ? `${s.state.now}${utc(s.state.now) ? `（${utc(s.state.now)}）` : ''}` : '—';
  $('lx-rev').textContent = s.state ? String(s.state.revision) : '—';
  $('lx-last').textContent = s.phase === 'ready' || s.phase === 'uncertain' ? lastText(s) : '—';
  const [kind, text] = noticeOf(s);
  const note = $('lx-notice'); note.dataset.kind = kind; note.textContent = text;
  const can = !!client && s.phase === 'ready' && !s.busy;
  for (const el of document.querySelectorAll('.lx-play [data-lx]')) el.disabled = el.dataset.lx === 'refresh' ? s.busy : !can;
  for (const el of document.querySelectorAll('.lx-play select, .lx-play input')) el.disabled = !can;
  $('lx-actions').setAttribute('aria-busy', String(s.busy));
  document.body.dataset.lxPhase = s.phase;
  paintCard(s);
}

// ------------------------------------------------------------------ events
const countOf = () => { const t = $('lx-train-count').value.trim(); return /^[0-9]{1,4}$/.test(t) ? Number(t) : NaN; };
document.querySelector('.lx-play').addEventListener('click', async e => {
  const b = e.target instanceof Element ? e.target.closest('[data-lx]') : null;
  if (!b || b.disabled) return;
  e.preventDefault();
  try {
    const k = b.dataset.lx;
    if (k === 'refresh') return void (await refreshOrInit());
    if (!client) return;
    if (k === 'harvest') await client.submit({ kind: 'harvest' });
    else if (k === 'build') await client.submit({ kind: 'build', item: Number($('lx-build-item').value) });
    else if (k === 'train') await client.submit({ kind: 'train', unit: Number($('lx-train-unit').value), count: countOf() });
    else if (k === 'advance') await client.submit({ kind: 'advance', seconds: Number(b.dataset.seconds) });
    else if (k === 'reset') await client.submit({ kind: 'reset' });
  } catch (err) { console.error('local', err); }
});

// ------------------------------------------------------------------ start (explicit GETs only; never a retry loop)
async function loadInitialFiles() {
  const files = {};
  for (const [k, name] of Object.entries(INITIAL_FILES)) {
    const res = await fetch(initialRoute(name), { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    files[k] = new Uint8Array(await res.arrayBuffer());
  }
  return loadInitial(files);
}
let lastPaint = { phase: 'init', busy: false, state: null, notice: null, error: null, reason: null, lastResult: null };
async function refreshOrInit() {
  if (!client) {
    try {
      const initial = await loadInitialFiles();
      client = createClient({ fetchFn: (u, i) => fetch(u, i), initial, onChange: s => { lastPaint = s; paint(s); } });
    } catch (e) {
      lastPaint = { ...lastPaint, phase: 'error', error: { code: e?.code ?? 'Error', message: String(e?.message ?? e), what: 'init' }, state: null };
      paint(lastPaint);
      return;
    }
  }
  await client.refresh();
}

(function init() {
  const bi = $('lx-build-item'), tu = $('lx-train-unit');
  for (const i of BUILD_ITEMS) { const o = document.createElement('option'); o.value = String(i); o.textContent = `#${i} ${BUILD_LABEL[i]}`.trim(); bi.append(o); }
  for (const i of TRAIN_UNITS) { const o = document.createElement('option'); o.value = String(i); o.textContent = `#${i} ${UNIT_LABEL[i]}`; tu.append(o); }
  for (const b of document.querySelectorAll('[data-lx="advance"]')) if (!ADVANCE_SECONDS.includes(Number(b.dataset.seconds))) b.remove();
  paint(lastPaint);
  refreshOrInit();
})();
window.addEventListener('error', e => { $('lx-notice').dataset.kind = 'error'; $('lx-notice').textContent = `ページエラー: ${e.message}`; });
window.addEventListener('unhandledrejection', e => { $('lx-notice').dataset.kind = 'error'; $('lx-notice').textContent = `ページエラー: ${e.reason?.message ?? e.reason}`; });
