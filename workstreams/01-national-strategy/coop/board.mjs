#!/usr/bin/env node
// 依頼の板：署名付きの記録を受け取り、確かめて、追記で保存する。ゲームと同じ入口（オリジン）で画面を出すため、
// それ以外の要求はヘラルドへそのまま転送する（127.0.0.1 だけ）。
//
//   node workstreams/01-national-strategy/coop/board.mjs --herald http://127.0.0.1:41940 \
//        --program <program id> --season <id> --rpc http://127.0.0.1:41910 [--port 41873] [--data <dir>] [--judge arrivals]
//        [--previous <program>:<season> …] [--legacy-data <旧い板のフォルダ> …] [--segment-mb 64]
//
// 中継（relay）へは、ゲームと同じく同じ入口の /gw を通す（板 → ヘラルドの /gw → 中継）。
// 中継は CORS の見出しを返さず、OPTIONS にも答えない（permutation-gateway src/frontier/app.mjs：Access-Control-Allow-Origin なし、
// OPTIONS は NotFound）。だから、別の入口の画面から中継の住所へ直接送ると、ブラウザが止める。ヘラルドは --relay で中継へ転送する
// （frontier-node/crates/herald/src/server.rs の gw）。
//
//   http://127.0.0.1:41873/frontier/frontier/   … ゲーム（ヘラルドの画面を転送。Dev Wallet はこの入口のもの）
//   http://127.0.0.1:41873/ws01/                 … 依頼の画面（同じ入口なので、同じ Dev Wallet で署名する）
//
// 板がしないこと：資源を動かす・隊商を送る・誰かの代わりに署名する。板は記録を並べて確かめるだけ。
// 板は記録を消せない（追記だけ）。ただし板が記録を出さない（隠す）ことは、署名では防げない（docs 17章）。

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFolder, recordId, shapeProblem, verifySig, ownerTagOf, CLOCK_SKEW, RESOURCES, ctxKey } from './record.mjs';
import { linkProblem } from './arrival.mjs';
import { GOALS, JUDGES, coopView, timingOf } from './goal.mjs';
import { citizenOf, holdingNow, rpcReader, caravanAccount, caravanHistory, sendOutcome, seasonRules } from './chain.mjs';
import { caravanKeyOf } from './arrival.mjs';
import { pendingSendOf } from './pending.mjs';
import { openStore, loadStore, readLines, DEFAULT_SEGMENT_BYTES } from './store.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const SERVE = [path.join(repo, 'workstreams/01-national-strategy/coop'), path.join(repo, 'permutation-server/web')];
/** 画面の場所（相対 import が repo の permutation-server/web に届くよう、repo の並びのまま出す）。 */
export const PAGE = '/ws01/repo/workstreams/01-national-strategy/coop/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * 記録の追記ファイルを読む。壊れた行（書きかけで止まった最後の行など）は飛ばして数える。
 * 飛ばした行は記録の欠落なので、`damaged` として表示に出す（黙って消さない。ファイルも書き換えない）。
 */
export function loadRecords(file) {
  const r = readLines(file);
  return { records: r.entries.map(e => e.rec), damaged: r.damaged, received: r.entries.map(e => e.receivedAt) };
}

/**
 * 板を作る（テストからも使う）。`fetchHerald(path) → {status, json}` と、チェーンを読む `reader`（chain.mjs の rpcReader の形）を差し替えられる。
 * 再起動：記録（records.jsonl）を最初から畳み込み直すので、依頼・応答・結び付け・重複防止（同じ記録・同じ隊商）は戻る。
 * 観測の時刻（observed.json）が失われると、再起動の後に初めて見た時刻になる（仮B は「到着より後」を確かめられず、達成にならない側に倒れる）。
 */
export function createBoard({ herald, programId, seasonId, dataDir, judge = 'arrivals', now = () => Math.floor(Date.now() / 1000), fetchHerald = null, reader = null, relay = '/gw', rpc = null,
  previous = [], legacyDirs = [], segmentBytes = DEFAULT_SEGMENT_BYTES }) {
  // 今の文脈（新しい依頼・ヘラルド・見ている人の国）と、前の文脈（読み続ける）。文脈を世界の正本として決めるのは④⑧。①は渡された一覧を使う。
  const season = { programId, seasonId: String(seasonId) };
  const contexts = [season, ...previous.map(c => ({ programId: c.programId, seasonId: String(c.seasonId) }))];
  fs.mkdirSync(dataDir, { recursive: true });
  const obsFile = path.join(dataDir, 'observed.json');
  // 記録は区間に分けて保存する（store.mjs）。閉じた区間は読むだけ（名前を変えるだけで中身は変えない）。
  const store = openStore(dataDir, { segmentBytes });
  // 旧い板の記録（シーズンごとのフォルダ）は読むだけ。書き換えず、こちらへ写しもしない（再起動のたびに読み直す）
  const loaded = [...legacyDirs.map(d => ({ ...loadStore(d), legacy: d })), { ...store.load(), legacy: null }];
  const records = [], damaged = [], receivedAt = new Map(), segments = [], storeProblems = [];
  const folder = createFolder({ goals: GOALS, contexts, current: season });
  for (const L of loaded) {
    for (const e of L.entries) { records.push(e.rec); receivedAt.set(recordId(e.rec), e.receivedAt); folder.add(e.rec); }
    damaged.push(...L.damaged.map(d => ({ ...d, file: L.legacy ? path.join(L.legacy, d.file) : d.file })));
    segments.push(...L.segments.map(x => ({ ...x, legacy: L.legacy })));
    storeProblems.push(...L.problems.map(x => (L.legacy ? `${L.legacy}：${x}` : x)));
  }
  const sendCache = new Map();      // 送信の結果（終わったものは変わらないので覚える）
  let obs = { ended: {}, vaults: {} };
  try { if (fs.existsSync(obsFile)) obs = JSON.parse(fs.readFileSync(obsFile, 'utf8')); } catch { obs = { ended: {}, vaults: {} }; }
  const citizenCache = new Map();   // 確かめられた結果だけを覚える（未検証は毎回やり直す）。鍵は「文脈|ウォレット」
  const endCache = new Map();       // 隊商の確定・襲撃（チェーンの記録。終わったものは変わらないので覚える）
  const rulesCache = new Map();     // 文脈ごとの規則の版
  const getHerald = fetchHerald ?? (async p => {
    const r = await fetch(new URL(p, herald));
    return { status: r.status, json: r.ok ? await r.json() : null };
  });

  /** ヘラルド（今の文脈）の隊商の一覧を読み、初めて見た確定の記録と貯蔵庫の時刻を残す（施設の観測に使う）。 */
  async function caravans() {
    let file = null;
    try { const r = await getHerald('/h/caravans.json'); file = r.status === 200 ? r.json : null; } catch { file = null; }
    if (file) {
      const t = now();
      let changed = false;
      for (const e of file.ended ?? []) { const k = caravanKeyOf({ ctx: ctxKey(season), ownerTag: e.ownerTag, seq: e.seq }); if (!(k in obs.ended)) { obs.ended[k] = t; changed = true; } }
      for (const v of file.vaults ?? []) { const k = `${v.p},${v.q},${v.tile}`; if (!(k in obs.vaults)) { obs.vaults[k] = t; changed = true; } }
      if (changed) fs.writeFileSync(obsFile, JSON.stringify(obs));
    }
    return file;
  }

  const state = () => folder.state;

  // 受け取りは一つずつ、受け取った順に。
  let queue = Promise.resolve();
  const submit = rec => { const r = queue.then(() => submitOne(rec)); queue = r.catch(() => {}); return r; };

  /** 記録を一つ受け取る。{ok, id} か {ok:false, why}。依頼に続く記録は、依頼の文脈の口座で確かめる。 */
  async function submitOne(rec) {
    const shape = shapeProblem(rec, GOALS);
    if (shape) return { ok: false, why: shape };
    if (!(await verifySig(rec))) return { ok: false, why: '署名が合わない' };
    if (Math.abs(rec.at - now()) > CLOCK_SKEW) return { ok: false, why: `時刻が板の時計と ${CLOCK_SKEW} 秒より離れている` };
    const q = rec.request ? state().requests[rec.request] : null;
    const ctx = q?.ctx ?? rec.season;
    if (rec.kind === 'sending' && q) {
      // 結果の分からない送信が同じ依頼・同じ人に残っていれば、次の署名・送付を受けない（二重送付を防ぐ）
      // 着地したのに結び付けていない送信も止める（再起動・画面を閉じた後に同じ物を二度送らない。pending.mjs）
      const outs = new Map();
      for (const z of q.sendings ?? []) if (z.responder === rec.signer) outs.set(z.walletSig, await sendingStatus(q, z));
      const p = pendingSendOf(q, rec.signer, z => outs.get(z.walletSig));
      if (p) return { ok: false, why: p.why, pending: p.sending.caravan, pendingKind: p.kind };
    }
    if (rec.kind === 'link') {
      if (!q) return { ok: false, why: '依頼が見つからない' };
      if (reader) {
        // 元の送り主：隊商の鍵（OWNER_TAG）は送った人の印。奪われると OWNER_CITIZEN は奪った人になるが鍵は変わらない
        if (String(rec.caravan.ownerTag) !== ownerTagOf(ctx, rec.signer)) return { ok: false, why: 'この隊商を送った人（隊商の鍵の持ち主の印）ではない' };
        const me = seasonAddresses(ctx.programId, ctx.seasonId).of('Citizen', { wallet: rec.signer });
        // 正本：チェーンの隊商の口座（輸送中なら口座がある）
        const c = await caravanAccount(reader, ctx, rec.caravan);
        if (c.status === 'found') {
          if (c.ownerCitizen !== me) return { ok: false, why: 'この隊商の今の持ち主（OWNER_CITIZEN）ではない（奪われた）' };
          if (c.state !== 'moving') return { ok: false, why: `隊商は輸送中ではない（${c.state}）` };
          const why = linkProblem(q, rec.caravan, c.ownerTag, { moving: [{ ownerTag: c.ownerTag, seq: c.seq, dst: c.dst, cargo: c.cargo, raided: false }] });
          if (why) return { ok: false, why };
        } else if (c.status === 'absent') {
          // 結び付ける前に着いた隊商（口座は確定で閉じる）：チェーンの元の送信（CARAVAN_SENT）で確かめる。応じる前の送信は断る
          const h = await caravanHistory(reader, ctx, rec.caravan);
          if (h.status !== 'ok') return { ok: false, why: `隊商の記録を読めない：${h.why}` };
          if (!h.sent) return { ok: false, why: '隊商の口座も、送信の記録もない（まだ載っていない）' };
          if (h.raided) return { ok: false, why: '襲われた隊商は結び付けない' };
          const resp = q.responses[rec.signer];
          if (timingOf(h.sent.blockTime, receivedAt.get(resp?.id) ?? null).status === 'before') return { ok: false, why: '応じる前に送った隊商は結び付けない' };
          const why = linkProblem(q, rec.caravan, rec.caravan.ownerTag, { moving: [{ ownerTag: String(rec.caravan.ownerTag), seq: rec.caravan.seq, dst: h.sent.dst, cargo: h.sent.cargo, raided: false }] });
          if (why) return { ok: false, why };
        } else return { ok: false, why: `隊商をチェーンで確かめられない：${c.why}` };
      } else {
        if (q.ctx && ctxKey(q.ctx) !== ctxKey(season)) return { ok: false, why: '前の文脈の隊商は、チェーンを読む板（--rpc）でしか確かめられない' };
        const file = await caravans();
        if (!file) return { ok: false, why: 'ヘラルドの隊商の一覧が読めないので、隊商を確かめられない' };
        const why = linkProblem(q, rec.caravan, ownerTagOf(ctx, rec.signer), file);
        if (why) return { ok: false, why };
      }
    }
    const r = folder.add(rec, { quiet: true, live: true });
    if (!r.ok) return { ok: false, why: r.why };
    const id = r.id;
    const at = now();
    const sealed = store.append(rec, at);   // 書きかけの最後の行には続けない。大きくなったら区間を閉じる
    if (sealed) segments.push({ ...sealed, status: 'ok', legacy: null });
    records.push(rec);
    receivedAt.set(id, at);
    return { ok: true, id };
  }

  async function citizen(wallet, ctx) {
    const k = `${ctxKey(ctx)}|${wallet}`;
    if (citizenCache.has(k)) return citizenCache.get(k);
    const c = await citizenOf(reader, ctx, wallet);
    if (c.status === 'verified') citizenCache.set(k, c);
    return c;
  }

  async function rulesOf(ctx) {
    const k = ctxKey(ctx);
    if (rulesCache.has(k)) return rulesCache.get(k);
    const r = await seasonRules(reader, ctx);
    if (r.status === 'verified') rulesCache.set(k, r);
    return r;
  }

  /**
   * チェーンで確かめる（依頼ごとに、その依頼の文脈で）：関わった人の国（Citizen）、確定した隊商の届け先の村の今の口座、
   * 隊商の終わり方、送信の結果、規則の版。終わったもの（確定・送信の結果・確かめた国・規則）は覚えるので、長く続いても読む量は増えにくい。
   */
  async function checks(st, viewer) {
    const want = new Map([...(viewer ? [[`${ctxKey(season)}|${viewer}`, [viewer, season]]] : [])]);
    const holdings = {}, ends = {}, sendings = {}, rules = {};
    const placeNow = new Map();   // 同じ村を一回の表示で何度も読まない
    for (const q of Object.values(st.requests)) {
      const ctx = q.ctx ?? season;
      want.set(`${ctxKey(ctx)}|${q.requester}`, [q.requester, ctx]);
      for (const l of q.links) want.set(`${ctxKey(ctx)}|${l.responder}`, [l.responder, ctx]);
      if (!reader) continue;
      let settledHere = false;
      for (const l of q.links) {
        const k = caravanKeyOf(l.caravan);
        let e = endCache.get(k);
        if (!e) {
          const h = await caravanHistory(reader, ctx, l.caravan);
          e = h.status !== 'ok' ? h : { ...h, status: h.raided ? 'raided' : h.settled ? 'settled' : 'none' };
          if (e.status === 'settled' || (e.status === 'raided' && e.settled)) endCache.set(k, e);
          else if (e.status === 'none') e = { ...e, account: await caravanAccount(reader, ctx, l.caravan) };   // 輸送中か（前の文脈はヘラルドに出ない）
        }
        ends[k] = e;
        if (e.settled) settledHere = true;
      }
      if (settledHere) {
        const pk = `${ctxKey(ctx)}|${q.to.p},${q.to.q},${q.to.site}`;
        if (!placeNow.has(pk)) placeNow.set(pk, await holdingNow(reader, ctx, q.to));   // 今の口座。到着時の受取人は goal.mjs で世代と合わせて決める
        holdings[q.id] = placeNow.get(pk);
      }
      for (const z of q.sendings ?? []) sendings[z.walletSig] = await sendingStatus(q, z);
      if (!rules[ctxKey(ctx)]) rules[ctxKey(ctx)] = await rulesOf(ctx);
    }
    const citizens = {};
    for (const [k, [w, ctx]] of want) citizens[k] = await citizen(w, ctx);
    const times = Object.fromEntries(receivedAt);
    if (!reader) return { citizens, holdings, caravans: undefined, times, rules: { status: 'unverified', why: 'チェーンを読めない（板に --rpc がない）' }, sendings: {} };
    if (!rules[ctxKey(season)]) rules[ctxKey(season)] = await rulesOf(season);
    return { citizens, holdings, caravans: ends, times, rules, sendings };
  }

  /** sending の記録の送信が、いまどうなったか（chain.mjs sendOutcome、依頼の文脈で）。終わったものは覚える。 */
  async function sendingStatus(q, z) {
    if (sendCache.has(z.walletSig)) return sendCache.get(z.walletSig);
    if (!reader) return { status: 'unknown', why: 'チェーンを読めない' };
    const plan = { wallet: z.responder, caravan: z.caravan, src: z.src, dst: q.to, cargo: RESOURCES.map(r => z.cargo[r] ?? 0) };
    const o = await sendOutcome(reader, q.ctx ?? season, plan, { walletSig: z.walletSig, blockhash: z.blockhash });
    if (o.status !== 'unknown') sendCache.set(z.walletSig, o);
    return o;
  }

  async function view({ viewer = null, judgeId = judge } = {}) {
    const file = await caravans();
    const st = state();
    const v = coopView({ state: st, file, obs, checks: await checks(st, viewer), viewer, now: now(), judgeId, season });
    return { ...v, heraldFeed: file ? { moving: (file.moving ?? []).length, ended: Array.isArray(file.ended) ? file.ended.length : null } : null, chain: !!reader, damaged, contexts, store: { segments: segments.length, problems: storeProblems } };
  }

  const config = () => ({ season, contexts, goals: GOALS, judges: Object.values(JUDGES).map(j => ({ id: j.id, label: j.label, means: j.means })), judge, herald, chain: !!reader, damaged, relay, rpcProxy: !!rpc, store: { segments, problems: storeProblems } });
  return { submit, view, config, records, caravans, season, contexts, rpc, state };
}

// ------------------------------------------------------------------ HTTP

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body));
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res, rel) {
  let p;
  try { p = path.resolve(repo, decodeURIComponent(rel)); } catch { return send(res, 400, { error: 'bad path' }); }
  if (!SERVE.some(d => p === d || p.startsWith(d + path.sep))) return send(res, 404, { error: 'not here' });
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) return send(res, 404, { error: 'not found' });
  send(res, 200, fs.readFileSync(p), TYPES[path.extname(p)] ?? 'application/octet-stream');
}

/** 画面から読ませる RPC（読むだけ）。 */
export const READ_METHODS = Object.freeze(['getAccountInfo', 'getSignaturesForAddress', 'getTransaction', 'isBlockhashValid']);

/** 板の HTTP サーバー。`/coop/*` は板、`/ws01/*` は画面、それ以外はヘラルドへ転送。 */
export function createServer(board, { herald }) {
  const up = herald ? new URL(herald) : null;
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'bad url' }); }
    try {
      if (url.pathname === '/coop/config') return send(res, 200, board.config());
      if (url.pathname === '/coop/records' && req.method === 'GET') return send(res, 200, board.records);
      if (url.pathname === '/coop/records' && req.method === 'POST') {
        let rec;
        try { rec = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { ok: false, why: '記録が読めない' }); }
        const r = await board.submit(rec);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (url.pathname === '/coop/rpc' && req.method === 'POST') {
        // 画面がチェーンを読むための入口（読むだけ）。送る取引は /gw（ヘラルド → 中継）で、ここは通らない。
        if (!board.rpc) return send(res, 404, { error: 'この板は --rpc なし' });
        let body;
        try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
        if (!READ_METHODS.includes(body?.method)) return send(res, 403, { error: `読むだけ：${READ_METHODS.join('・')}` });
        const r = await fetch(board.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params }) });
        return send(res, r.status, await r.text());
      }
      if (url.pathname === '/coop/view') {
        return send(res, 200, await board.view({ viewer: url.searchParams.get('viewer') || null, judgeId: url.searchParams.get('judge') || undefined }));
      }
      if (url.pathname === '/ws01' || url.pathname === '/ws01/') { res.writeHead(302, { location: PAGE }); return res.end(); }
      if (url.pathname.startsWith('/ws01/repo/')) return serveStatic(res, url.pathname.slice('/ws01/repo/'.length));
      if (!up) return send(res, 404, { error: 'no herald' });
      // ヘラルドへ転送（ゲームの画面と h/*.json）
      const body = ['GET', 'HEAD'].includes(req.method) ? null : await readBody(req, 1 << 20);
      const pr = http.request({ host: up.hostname, port: up.port, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: up.host } }, r => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      pr.on('error', () => send(res, 502, { error: 'herald unreachable' }));
      pr.end(body ?? undefined);
    } catch (e) {
      send(res, 500, { error: String(e?.message ?? e) });
    }
  });
  // WebSocket などの upgrade もヘラルドへそのまま
  server.on('upgrade', (req, sock, head) => {
    if (!up) return sock.destroy();
    const t = net.connect(Number(up.port), up.hostname, () => {
      t.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, host: up.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head?.length) t.write(head);
      sock.pipe(t).pipe(sock);
    });
    t.on('error', () => sock.destroy());
    sock.on('error', () => t.destroy());
  });
  return server;
}

// ------------------------------------------------------------------ 起動

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const herald = arg('herald', 'http://127.0.0.1:41940');
  const programId = arg('program'), seasonId = arg('season');
  if (!programId || !seasonId) { console.error('--program と --season が要る（frontier-stack の state.json の program id とシーズン番号）'); process.exit(2); }
  const port = Number(arg('port', '41873'));
  // 記録のフォルダはシーズンで分けない（世界は続く。文脈が変わっても同じ板）。旧い形のシーズンごとのフォルダは --legacy-data で読むだけ
  const dataDir = arg('data', path.join(repo, '.local/ws01-coop', programId.slice(0, 8)));
  const all = k => process.argv.flatMap((x, i) => (x === `--${k}` ? [process.argv[i + 1]] : []));
  const previous = all('previous').map(x => { const [p, s] = x.split(':'); return { programId: p, seasonId: s }; });   // --previous <program>:<season>（読み続ける前の文脈）
  const legacyDirs = all('legacy-data');
  const segmentBytes = Math.round(Number(arg('segment-mb', String(DEFAULT_SEGMENT_BYTES / 1048576))) * 1048576);   // 記録の区間の大きさ（MB）
  const rpc = arg('rpc');   // 例：http://127.0.0.1:41910（国と届け先の村をチェーンで確かめる。ないと国籍未検証）
  const board = createBoard({ herald, programId, seasonId, dataDir, judge: arg('judge', 'arrivals'), reader: rpc ? rpcReader(rpc) : null, rpc, previous, legacyDirs, segmentBytes });   // 中継は同じ入口の /gw（ヘラルドの --relay が要る）
  createServer(board, { herald }).listen(port, '127.0.0.1', () => {
    console.log(`依頼の板：http://127.0.0.1:${port}/ws01/  ゲーム：http://127.0.0.1:${port}/frontier/frontier/  （ヘラルド ${herald}、記録 ${dataDir}）`);
  });
}
