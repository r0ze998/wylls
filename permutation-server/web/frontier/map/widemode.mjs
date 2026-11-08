// The recorded-world mode of the Frontier page (read-only; map growth,
// docs/frontier/map-growth/WIDE-WORLD-INDEX.md): a button beside the map
// tools opens a sheet over the ordinary map that draws the Provinces the
// herald's fold CAPTURED, as `/h/world/wide` pages them (map/wide.mjs),
// relative to a BigInt camera origin. The ordinary map underneath is not
// touched: this module adds a button and a sheet, and removes them when
// the mode closes.
//
// What it says of itself, always on screen: read-only; captured records,
// not completeness (a place not listed is unknown, not open); the world
// namespace and snapshot it shows; and, when the herald has no such world,
// that it is unavailable (never a dense map dressed as one). A sample
// world is refused before any request.
//
// Nothing here signs or sends anything.
import { L, fmtNum, onLangChange } from '../../lang.mjs';
import { provinceCorners, provincePixel } from './layers.mjs';
import { loadWide, WideWalk, originAt, ORIGIN_CONCORD, layoutWide, nearestTo, formatCoord, describeWalk, ringOfWide, parseWideInt, WideError, sourcePins } from './wide.mjs';

/** Seconds between manifest polls while the mode is open (a new snapshot reloads the walk). */
export const WIDE_POLL_S = 30;
/** Rows the sheet's list shows at once. */
export const LIST_ROWS = 48;
const ZOOM_MIN = 0.02, ZOOM_MAX = 6;

const TEXT = {
  title: () => L`記録された世界（読み取り専用・実験中）`,
  button: () => L`記録`,
  open: () => L`記録された世界を開く（読み取り専用）`,
  close: () => L`記録された世界を閉じる`,
  loading: () => L`記録を読み込んでいます…`,
  sample: () => L`見本の世界には記録された世界はありません。`,
  unavailable: () => L`この配信元は記録された世界を出していません（WideWorldUnavailable）。`,
  facts: () => L`捕捉された州だけを示します。載っていない場所は「不明」で、開いている証拠でも閉じている証拠でもありません。送信も署名もしません。`,
  truncated: () => L`ページ数の上限で打ち切りました。これより先の記録は読んでいません。`,
  recentre: () => L`ここを原点にする`,
  concord: () => L`大協約を原点にする`,
  zoomIn: () => L`拡大`,
  zoomOut: () => L`縮小`,
  reload: () => L`読み直す`,
  unknown: () => L`不明（記録なし）`,
  list: () => L`記録された州`,
  origin: () => L`原点`,
  pointer: () => L`ポインタ`,
  selected: () => L`選択`,
  none: () => L`（なし）`,
};

const CODE_TEXT = {
  WideWorldUnavailable: TEXT.unavailable,
  SampleWorld: TEXT.sample,
  WorldChanged: () => L`読み込み中に世界が変わりました。読み直します。`,
  StaleSnapshot: () => L`読み込み中に記録が更新されました。読み直します。`,
  WrongSeason: () => L`別のシーズンの記録でした。表示しません。`,
  WorldMismatch: () => L`世界の名前がシーズンと合いません。表示しません。`,
  Aborted: () => L`読み込みを中止しました。`,
  network: () => L`記録の配信元に届きません。`,
};
const codeText = code => (CODE_TEXT[code] ?? (() => L`記録を読めませんでした（${code}）`))();

/** The state the sheet renders (pure data; exported for tests). */
export function modeState() {
  return { open: false, phase: 'closed', code: null, walk: null, origin: ORIGIN_CONCORD, zoom: 1, pan: { x: 0, y: 0 }, selected: null, pointer: null };
}

/**
 * Mounts the mode on the page: `{herald}` (herald.mjs's client with wideWorld/wideWorldPage), `canvas` (the map's,
 * for where the button and the sheet go), `isSample()` (the page's reading of its season record: a sample world is
 * refused before any request), `recordOf()` (the season record, for the pins: season, seasonAddress, programId).
 * Returns `{open, close, toggle, state, unmount}`.
 */
export function mountWideMode({ herald, canvas, doc = canvas?.ownerDocument ?? globalThis.document, isSample = () => false, recordOf = () => null, now = () => Date.now() } = {}) {
  if (!doc || !canvas?.parentElement) return null;
  const S = modeState();
  let controller = null, pollTimer = null, raf = null, unlang = null;

  // ---- DOM
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'map-btn wide-btn';
  button.dataset.map = 'wide';
  button.setAttribute('aria-pressed', 'false');
  const bw = doc.createElement('span'); bw.className = 'map-btn-text'; button.append(bw);
  button.dataset.worded = '';
  const tools = canvas.parentElement.querySelector?.('.map-tools');
  if (tools) tools.append(button); else canvas.after(button);

  const sheet = doc.createElement('section');
  sheet.className = 'wide-world';
  sheet.id = 'wide-world';
  sheet.hidden = true;
  sheet.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } });
  sheet.setAttribute('aria-labelledby', 'wide-title');
  sheet.innerHTML = `
    <div class="wide-head"><h2 id="wide-title"></h2><span class="wide-flag" id="wide-flag"></span><button type="button" class="hud-btn wide-close" id="wide-close"><svg class="ic" aria-hidden="true" focusable="false"><use href="art/ui/icons.svg#close"/></svg></button></div>
    <p class="wide-status" id="wide-status" role="status"></p>
    <p class="wide-facts" id="wide-facts"></p>
    <div class="wide-body">
      <div class="wide-stage"><canvas id="wide-canvas" tabindex="0"></canvas>
        <div class="wide-tools">
          <button type="button" class="map-btn" id="wide-in">+</button>
          <button type="button" class="map-btn" id="wide-out">−</button>
          <button type="button" class="btn small" id="wide-recentre"></button>
          <button type="button" class="btn small" id="wide-concord"></button>
          <button type="button" class="btn small" id="wide-reload"></button>
        </div>
      </div>
      <aside class="wide-side">
        <dl class="wide-coords"><dt id="wide-k-origin"></dt><dd id="wide-origin"></dd><dt id="wide-k-pointer"></dt><dd id="wide-pointer"></dd><dt id="wide-k-selected"></dt><dd id="wide-selected"></dd></dl>
        <h3 id="wide-list-title"></h3>
        <ol class="wide-list" id="wide-list"></ol>
        <p class="wide-more" id="wide-more"></p><div><button type="button" id="wide-prev">←</button><button type="button" id="wide-next">→</button></div>
      </aside>
    </div>`;
  canvas.after(sheet);
  const $ = id => sheet.querySelector(`#${id}`);
  const wc = $('wide-canvas');

  // ---- labels (in the page's language, re-read when it changes)
  const label = () => {
    const open = S.open;
    const x = open ? TEXT.close() : TEXT.open();
    button.setAttribute('aria-label', x); button.title = x; bw.textContent = TEXT.button();
    button.setAttribute('aria-pressed', open ? 'true' : 'false');
    $('wide-title').textContent = TEXT.title();
    $('wide-flag').textContent = L`読み取り専用`;
    $('wide-close').setAttribute('aria-label', TEXT.close()); $('wide-close').title = TEXT.close();
    $('wide-facts').textContent = TEXT.facts();
    $('wide-in').setAttribute('aria-label', TEXT.zoomIn()); $('wide-out').setAttribute('aria-label', TEXT.zoomOut());
    $('wide-recentre').textContent = TEXT.recentre(); $('wide-concord').textContent = TEXT.concord(); $('wide-reload').textContent = TEXT.reload();
    $('wide-k-origin').textContent = TEXT.origin(); $('wide-k-pointer').textContent = TEXT.pointer(); $('wide-k-selected').textContent = TEXT.selected();
    $('wide-list-title').textContent = TEXT.list();
    $('wide-prev').setAttribute('aria-label', L`前の記録`); $('wide-next').setAttribute('aria-label', L`次の記録`);
    wc.setAttribute('aria-label', L`記録された世界の地図：ドラッグで移動、ホイールと＋－で拡大縮小、矢印キーで移動、クリックで州を選択`);
    renderText();
  };

  // ---- text of the state
  function statusText() {
    if (S.phase === 'sample') return TEXT.sample();
    if (S.phase === 'loading') return TEXT.loading();
    if (S.phase === 'error') return codeText(S.code);
    const d = describeWalk(S.walk);
    if (!S.walk?.manifest) return '';
    const m = S.walk.manifest;
    const parts = [L`接続先 ${S.source?.cluster ?? 'unknown'}（配信元の申告）`, L`世界 ${m.world.slice(0, 8)}… シーズン ${m.season}`, L`スナップショット ${String(d.snapshot?.epoch ?? '')}／${d.snapshot?.stamp?.slice(0, 8) ?? ''}…`,
      L`記録 ${fmtNum(d.recorded)} 州（表示 ${fmtNum(d.shown)}：開 ${fmtNum(d.open)}・閉 ${fmtNum(d.closed)}）`];
    if (m.refused > 0) parts.push(L`索引が拒んだ報告 ${fmtNum(m.refused)}`);
    if (d.truncated) parts.push(TEXT.truncated());
    if (S.phase === 'reloading') parts.push(TEXT.loading());
    return parts.join(' ');
  }
  function renderText() {
    $('wide-status').textContent = statusText();
    $('wide-origin').textContent = formatCoord(S.origin.p, S.origin.q);
    $('wide-pointer').textContent = S.pointer ? `${formatCoord(S.pointer.p, S.pointer.q)}${S.pointer.entry ? '' : ` ${TEXT.unknown()}`}` : TEXT.none();
    $('wide-selected').textContent = S.selected ? `${formatCoord(S.selected.p, S.selected.q)} ${entryLine(S.selected)}` : TEXT.none();
    renderList();
  }
  const entryLine = e => {
    const st = e.state === 'open' ? L`開` : L`閉`;
    const ring = L`第${String(e.ring)}輪`;
    const leg = e.legacy ? L`捕捉スロット ${e.legacy.slot === null ? '?' : fmtNum(e.legacy.slot)}・開始ターン ${e.legacy.openedBell === null ? '?' : fmtNum(e.legacy.openedBell)}` : L`捕捉なし`;
    return `${st} / ${ring} / ${leg}`;
  };
  let listKey = '', listPage = 0;
  function renderList() {
    const ol = $('wide-list');
    const entries = S.walk ? S.walk.list() : [];
    listPage = Math.min(listPage, Math.max(0, Math.ceil(entries.length / LIST_ROWS) - 1));
    const key = `${listPage}:${entries.length}:${S.selected?.key ?? ''}:${S.walk?.snapshot?.stamp ?? ''}`;
    if (key === listKey) return;
    listKey = key;
    ol.textContent = '';
    for (const e of entries.slice(listPage * LIST_ROWS, (listPage + 1) * LIST_ROWS)) {
      const li = doc.createElement('li');
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'wide-row';
      b.dataset.p = String(e.p); b.dataset.q = String(e.q);
      b.setAttribute('aria-pressed', S.selected?.key === e.key ? 'true' : 'false');
      b.textContent = `${formatCoord(e.p, e.q)} ${entryLine(e)}`;
      li.append(b);
      ol.append(li);
    }
    $('wide-prev').disabled = listPage === 0;
    $('wide-next').disabled = (listPage + 1) * LIST_ROWS >= entries.length;
    $('wide-more').textContent = entries.length > LIST_ROWS ? L`ほか ${fmtNum(entries.length - LIST_ROWS)} 州（地図で選べます）` : '';
  }

  // ---- drawing (relative to the BigInt origin: provinceCorners takes the small integer offset only)
  function draw() {
    raf = null;
    if (!S.open) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = wc.clientWidth || 640, h = wc.clientHeight || 400;
    if (wc.width !== Math.round(w * dpr) || wc.height !== Math.round(h * dpr)) { wc.width = Math.round(w * dpr); wc.height = Math.round(h * dpr); }
    const ctx = wc.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#10221f';
    ctx.fillRect(0, 0, w, h);
    const entries = S.walk ? [...S.walk.entries.values()] : [];
    const { near, far } = layoutWide(entries, S.origin);
    ctx.save();
    ctx.translate(w / 2 + S.pan.x, h / 2 + S.pan.y);
    ctx.scale(S.zoom, S.zoom);
    // the origin's own cell, dashed: a place with no record is unknown, so it is drawn as a mark, not as land
    const o = provinceCorners(0, 0, 0);
    ctx.beginPath(); o.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    ctx.setLineDash([6 / S.zoom, 6 / S.zoom]); ctx.strokeStyle = 'rgba(244,239,224,.45)'; ctx.lineWidth = 1 / S.zoom; ctx.stroke(); ctx.setLineDash([]);
    for (const { entry, dp, dq } of near) {
      const pts = provinceCorners(dp, dq, 2);
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.fillStyle = entry.state === 'open' ? 'rgba(201,162,74,.55)' : 'rgba(120,120,120,.35)';
      ctx.fill();
      ctx.strokeStyle = S.selected?.key === entry.key ? '#f0d48a' : 'rgba(244,239,224,.6)';
      ctx.lineWidth = (S.selected?.key === entry.key ? 3 : 1) / S.zoom;
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(244,239,224,.85)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${TEXT.title()} ${L`原点`} ${formatCoord(S.origin.p, S.origin.q)}${far ? ` ${L`画面外（原点から遠い）${fmtNum(far)} 州`}` : ''}`, 10, h - 10);
  }
  const invalidate = () => { if (raf === null && S.open) raf = (globalThis.requestAnimationFrame ?? (fn => setTimeout(fn, 16)))(draw); };

  // ---- picking (screen → lattice offset → BigInt coordinate)
  function provinceAtScreen(x, y) {
    const w = wc.clientWidth || 640, h = wc.clientHeight || 400;
    const wx = (x - w / 2 - S.pan.x) / S.zoom, wy = (y - h / 2 - S.pan.y) / S.zoom;
    // the nearest drawn centre within one cell (the entries are bounded: a walk holds ≤ 16,384)
    const entries = S.walk ? [...S.walk.entries.values()] : [];
    const { near } = layoutWide(entries, S.origin);
    let best = null, bd = Infinity;
    for (const n of near) {
      const c = provincePixel(n.dp, n.dq);
      const d = Math.hypot(c.x - wx, c.y - wy);
      if (d < bd) { bd = d; best = n; }
    }
    const cell = provincePixel(1, 0), unit = Math.hypot(cell.x, cell.y) / 2;
    if (best && bd <= unit) return { p: best.entry.p, q: best.entry.q, entry: best.entry };
    return null;
  }

  // ---- state changes
  function setPhase(phase, code = null) { S.phase = phase; S.code = code; renderText(); invalidate(); }
  async function load() {
    controller?.abort();
    const c = new AbortController();
    controller = c;
    if (isSample()) { S.walk = null; setPhase('sample', 'SampleWorld'); return; }
    const rec = recordOf();
    let pins;
    try { pins = sourcePins(rec); } catch (e) { S.walk = null; setPhase('error', e.code ?? 'NoSeasonYet'); return; }
    if (S.source?.key !== pins.key) { S.walk = null; S.selected = null; }
    S.source = pins;
    setPhase(S.walk ? 'reloading' : 'loading');
    const r = await loadWide(herald, { walk: new WideWalk(), signal: c.signal, pins, onPage: () => { if (controller === c) invalidate(); } });
    if (controller !== c || !S.open) return;
    try { if (isSample() || sourcePins(recordOf()).key !== pins.key) { S.walk = null; setPhase('error', 'WorldChanged'); return; } }
    catch (e) { S.walk = null; setPhase('error', e.code ?? 'NoSeasonYet'); return; }
    if (r.ok) {
      S.walk = r.walk;
      S.retries = 0;
      if (S.selected) S.selected = S.walk.entries.get(S.selected.key) ?? null;
      setPhase('ready');
    } else if ((r.code === 'WorldChanged' || r.code === 'StaleSnapshot') && (S.retries = (S.retries ?? 0) + 1) <= 3) {
      // the index moved under the walk: nothing of that walk is kept; start over (at most three times in a row)
      S.walk = null;
      setPhase('error', r.code);
      load();
    } else if (r.code !== 'Aborted') {
      S.walk = null;
      setPhase('error', r.code);
    }
  }
  async function poll() {
    if (!S.open || S.phase !== 'ready' || !S.walk) return;
    const current = controller;
    let pins;
    try { pins = sourcePins(recordOf()); } catch (e) { S.walk = null; setPhase('error', e.code ?? 'NoSeasonYet'); return; }
    if (isSample() || pins.key !== S.source?.key) { S.walk = null; load(); return; }
    const m = await herald.wideWorld({ signal: current?.signal, pins });
    if (!S.open || controller !== current) return;
    try { if (isSample() || sourcePins(recordOf()).key !== pins.key) { S.walk = null; load(); return; } }
    catch { S.walk = null; setPhase('error', 'NoSeasonYet'); return; }
    if (!m.ok) { if (m.code !== 'Aborted' && m.code !== 'network') { S.walk = null; setPhase('error', m.code); } return; }
    const s = m.manifest.snapshot;
    if (m.manifest.world !== S.walk.world || s.epoch !== S.walk.snapshot.epoch || s.stamp !== S.walk.snapshot.stamp) load();
  }
  function open() {
    if (S.open) return;
    S.open = true;
    sheet.hidden = false;
    label();
    load();
    pollTimer = setInterval(poll, WIDE_POLL_S * 1000);
    invalidate();
    wc.focus?.();
  }
  function close() {
    if (!S.open) return;
    S.open = false;
    controller?.abort();
    controller = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    sheet.hidden = true;
    label();
    canvas.focus?.();
  }
  const toggle = () => (S.open ? close() : open());

  function select(entry) { S.selected = entry; renderText(); invalidate(); }
  function recentre(p, q) {
    try { S.origin = originAt(p, q); } catch (e) { if (!(e instanceof WideError)) throw e; return; }
    S.pan = { x: 0, y: 0 };
    renderText(); invalidate();
  }

  // ---- events
  button.addEventListener('click', toggle);
  $('wide-prev').addEventListener('click', () => { listPage = Math.max(0, listPage - 1); renderList(); });
  $('wide-next').addEventListener('click', () => { listPage++; renderList(); });
  $('wide-close').addEventListener('click', close);
  $('wide-in').addEventListener('click', () => { S.zoom = Math.min(ZOOM_MAX, S.zoom * 1.25); invalidate(); });
  $('wide-out').addEventListener('click', () => { S.zoom = Math.max(ZOOM_MIN, S.zoom * 0.8); invalidate(); });
  $('wide-concord').addEventListener('click', () => recentre(0n, 0n));
  $('wide-recentre').addEventListener('click', () => {
    const at = S.selected ?? (S.walk ? nearestTo([...S.walk.entries.values()], S.origin) : null);
    if (at) recentre(at.p, at.q);
  });
  $('wide-reload').addEventListener('click', () => load());
  $('wide-list').addEventListener('click', e => {
    const b = e.target?.closest?.('button.wide-row');
    if (!b || !S.walk) return;
    const entry = S.walk.entries.get(`${parseWideInt(b.dataset.p)},${parseWideInt(b.dataset.q)}`) ?? null;
    if (entry) { select(entry); recentre(entry.p, entry.q); }
  });
  let drag = null;
  wc.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, px: S.pan.x, py: S.pan.y, moved: false }; wc.setPointerCapture?.(e.pointerId); });
  wc.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      S.pan = { x: drag.px + dx, y: drag.py + dy };
      invalidate();
    }
    const r = wc.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    S.pointer = provinceAtScreen(e.clientX - r.left, e.clientY - r.top);
    $('wide-pointer').textContent = S.pointer ? `${formatCoord(S.pointer.p, S.pointer.q)}` : TEXT.none();
  });
  wc.addEventListener('pointerup', e => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) return;
    const r = wc.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const hit = provinceAtScreen(e.clientX - r.left, e.clientY - r.top);
    select(hit?.entry ?? null);
  });
  wc.addEventListener('pointercancel', () => { drag = null; });
  wc.addEventListener('wheel', e => { e.preventDefault(); S.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, S.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); invalidate(); }, { passive: false });
  wc.addEventListener('keydown', e => {
    const step = 40;
    if (e.key === 'ArrowLeft') S.pan.x += step; else if (e.key === 'ArrowRight') S.pan.x -= step; else if (e.key === 'ArrowUp') S.pan.y += step; else if (e.key === 'ArrowDown') S.pan.y -= step;
    else if (e.key === '+' || e.key === '=') S.zoom = Math.min(ZOOM_MAX, S.zoom * 1.25); else if (e.key === '-') S.zoom = Math.max(ZOOM_MIN, S.zoom * 0.8);
    else if (e.key === 'Escape') { close(); return; }
    else return;
    e.preventDefault();
    invalidate();
  });
  unlang = onLangChange?.(label) ?? null;
  label();

  return {
    open, close, toggle,
    state: () => S,
    /** For the page's own tests: the sheet, the button and a forced redraw. */
    elements: () => ({ button, sheet, canvas: wc }),
    unmount() { close(); unlang?.(); button.remove(); sheet.remove(); },
  };
}
