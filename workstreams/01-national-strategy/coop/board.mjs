#!/usr/bin/env node
// 依頼の板：署名付きの記録を受け取り、確かめて、追記で保存する。ゲームと同じ入口（オリジン）で画面を出すため、
// それ以外の要求はヘラルドへそのまま転送する（127.0.0.1 だけ）。
//
//   node workstreams/01-national-strategy/coop/board.mjs --herald http://127.0.0.1:41940 \
//        --program <program id> --season <id> --rpc http://127.0.0.1:41910 [--port 41873] [--data <dir>] [--judge arrivals]
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
import { fold, recordId, shapeProblem, verifySig, ownerTagOf, CLOCK_SKEW } from './record.mjs';
import { linkProblem } from './arrival.mjs';
import { GOALS, JUDGES, coopView } from './goal.mjs';
import { citizenOf, holdingNow, rpcReader, caravanAccount, caravanEndFromChain, caravanHistory } from './chain.mjs';
import { caravanKeyOf } from './arrival.mjs';
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
  if (!fs.existsSync(file)) return { records: [], damaged: [] };
  const records = [], damaged = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    try { records.push(JSON.parse(l)); } catch { damaged.push({ line: i + 1, head: l.slice(0, 40) }); }
  });
  return { records, damaged };
}

/**
 * 板を作る（テストからも使う）。`fetchHerald(path) → {status, json}` と、チェーンを読む `reader`（chain.mjs の rpcReader の形）を差し替えられる。
 * 再起動：記録（records.jsonl）を最初から畳み込み直すので、依頼・応答・結び付け・重複防止（同じ記録・同じ隊商）は戻る。
 * 観測の時刻（observed.json）が失われると、再起動の後に初めて見た時刻になる（仮B は「到着より後」を確かめられず、達成にならない側に倒れる）。
 */
export function createBoard({ herald, programId, seasonId, dataDir, judge = 'arrivals', now = () => Math.floor(Date.now() / 1000), fetchHerald = null, reader = null, relay = '/gw', rpc = null }) {
  const season = { programId, seasonId: String(seasonId) };
  fs.mkdirSync(dataDir, { recursive: true });
  const recFile = path.join(dataDir, 'records.jsonl');
  const obsFile = path.join(dataDir, 'observed.json');
  const { records, damaged } = loadRecords(recFile);
  let obs = { ended: {}, vaults: {} };
  try { if (fs.existsSync(obsFile)) obs = JSON.parse(fs.readFileSync(obsFile, 'utf8')); } catch { obs = { ended: {}, vaults: {} }; }
  const citizenCache = new Map();   // 確かめられた結果だけを覚える（未検証は毎回やり直す）
  const endCache = new Map();       // 隊商の確定・襲撃（チェーンの記録。終わったものは変わらないので覚える）
  const getHerald = fetchHerald ?? (async p => {
    const r = await fetch(new URL(p, herald));
    return { status: r.status, json: r.ok ? await r.json() : null };
  });

  /** ヘラルドの隊商の一覧を読み、初めて見た確定の記録と貯蔵庫の時刻を残す（施設の観測に使う）。 */
  async function caravans() {
    let file = null;
    try { const r = await getHerald('/h/caravans.json'); file = r.status === 200 ? r.json : null; } catch { file = null; }
    if (file) {
      const t = now();
      let changed = false;
      for (const e of file.ended ?? []) { const k = `${e.ownerTag}:${e.seq}`; if (!(k in obs.ended)) { obs.ended[k] = t; changed = true; } }
      for (const v of file.vaults ?? []) { const k = `${v.p},${v.q},${v.tile}`; if (!(k in obs.vaults)) { obs.vaults[k] = t; changed = true; } }
      if (changed) fs.writeFileSync(obsFile, JSON.stringify(obs));
    }
    return file;
  }

  const state = () => fold(records, { goals: GOALS, season });

  // 受け取りは一つずつ、受け取った順に。今は「状態の確かめ → 追記」の間に待ち（await）がないので同時の送信でも二重にはならないが
  // （テスト「同時の送信」）、確かめに待ちが入っても順番が崩れないように並べておく。
  let queue = Promise.resolve();
  const submit = rec => { const r = queue.then(() => submitOne(rec)); queue = r.catch(() => {}); return r; };

  /** 記録を一つ受け取る。{ok, id} か {ok:false, why}。 */
  async function submitOne(rec) {
    const shape = shapeProblem(rec, GOALS);
    if (shape) return { ok: false, why: shape };
    if (!(await verifySig(rec))) return { ok: false, why: '署名が合わない' };
    if (Math.abs(rec.at - now()) > CLOCK_SKEW) return { ok: false, why: `時刻が板の時計と ${CLOCK_SKEW} 秒より離れている` };
    if (rec.kind === 'link') {
      const q = state().requests[rec.request];
      if (!q) return { ok: false, why: '依頼が見つからない' };
      if (reader) {
        // 元の送り主：隊商の鍵（OWNER_TAG）は送った人の印。奪われると OWNER_CITIZEN は奪った人になるが鍵は変わらない
        if (String(rec.caravan.ownerTag) !== ownerTagOf(season, rec.signer)) return { ok: false, why: 'この隊商を送った人（隊商の鍵の持ち主の印）ではない' };
        const me = seasonAddresses(programId, season.seasonId).of('Citizen', { wallet: rec.signer });
        // 正本：チェーンの隊商の口座（輸送中なら口座がある）
        const c = await caravanAccount(reader, season, rec.caravan);
        if (c.status === 'found') {
          if (c.ownerCitizen !== me) return { ok: false, why: 'この隊商の今の持ち主（OWNER_CITIZEN）ではない（奪われた）' };
          if (c.state !== 'moving') return { ok: false, why: `隊商は輸送中ではない（${c.state}）` };
          const why = linkProblem(q, rec.caravan, c.ownerTag, { moving: [{ ownerTag: c.ownerTag, seq: c.seq, dst: c.dst, cargo: c.cargo, raided: false }] });
          if (why) return { ok: false, why };
        } else if (c.status === 'absent') {
          // 結び付ける前に着いた隊商（口座は確定で閉じる）：チェーンの取引の記録の、元の送信（CARAVAN_SENT）で確かめる。
          // 応じる前に送った隊商を後から結び付けないよう、送信の時刻が応答より後であること。
          const h = await caravanHistory(reader, season, rec.caravan);
          if (h.status !== 'ok') return { ok: false, why: `隊商の記録を読めない：${h.why}` };
          if (!h.sent) return { ok: false, why: '隊商の口座も、送信の記録もない（まだ載っていない）' };
          if (h.raided) return { ok: false, why: '襲われた隊商は結び付けない' };
          const resp = q.responses[rec.signer];
          if (h.sent.blockTime === null || h.sent.blockTime === undefined) return { ok: false, why: '送信の時刻が分からないので、応じた後の送信か確かめられない' };
          if (!resp || h.sent.blockTime < resp.at - CLOCK_SKEW) return { ok: false, why: '応じる前に送った隊商は結び付けない' };
          const why = linkProblem(q, rec.caravan, rec.caravan.ownerTag, { moving: [{ ownerTag: String(rec.caravan.ownerTag), seq: rec.caravan.seq, dst: h.sent.dst, cargo: h.sent.cargo, raided: false }] });
          if (why) return { ok: false, why };
        } else return { ok: false, why: `隊商をチェーンで確かめられない：${c.why}` };
      } else {
        const file = await caravans();
        if (!file) return { ok: false, why: 'ヘラルドの隊商の一覧が読めないので、隊商を確かめられない' };
        const why = linkProblem(q, rec.caravan, ownerTagOf(season, rec.signer), file);
        if (why) return { ok: false, why };
      }
    }
    const after = fold([...records, rec], { goals: GOALS, season });
    const id = recordId(rec);
    const bad = after.rejected.find(x => x.id === id);
    if (bad) return { ok: false, why: bad.why };
    // 書きかけで止まった最後の行に続けて書かない
    if (fs.existsSync(recFile)) { const st = fs.statSync(recFile); if (st.size > 0) { const fd = fs.openSync(recFile, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd); if (b[0] !== 10) fs.appendFileSync(recFile, '\n'); } }
    fs.appendFileSync(recFile, `${JSON.stringify(rec)}\n`);
    records.push(rec);
    return { ok: true, id };
  }

  async function citizen(wallet) {
    if (citizenCache.has(wallet)) return citizenCache.get(wallet);
    const c = await citizenOf(reader, season, wallet);
    if (c.status === 'verified') citizenCache.set(wallet, c);
    return c;
  }

  /** チェーンで確かめる：関わった人の国（Citizen）と、到着のある依頼の届け先の村の持ち主。 */
  async function checks(st, viewer) {
    const wallets = new Set(viewer ? [viewer] : []);
    const holdings = {};
    for (const q of Object.values(st.requests)) {
      wallets.add(q.requester);
      for (const l of q.links) wallets.add(l.responder);
      if (q.links.length) holdings[q.id] = await holdingNow(reader, season, q.to);   // 今の口座。到着時の受取人は goal.mjs で世代と合わせて決める
    }
    const citizens = {};
    for (const w of wallets) citizens[w] = await citizen(w);
    if (!reader) return { citizens, holdings, caravans: undefined };
    const ends = {};
    for (const q of Object.values(st.requests)) for (const l of q.links) {
      const k = caravanKeyOf(l.caravan);
      if (endCache.has(k)) { ends[k] = endCache.get(k); continue; }
      const e = await caravanEndFromChain(reader, season, l.caravan);
      if (e.status === 'settled' || (e.status === 'raided' && e.settled)) endCache.set(k, e);
      ends[k] = e;
    }
    return { citizens, holdings, caravans: ends };
  }

  async function view({ viewer = null, judgeId = judge } = {}) {
    const file = await caravans();
    const st = state();
    const v = coopView({ state: st, file, obs, checks: await checks(st, viewer), viewer, now: now(), judgeId, season });
    return { ...v, heraldFeed: file ? { moving: (file.moving ?? []).length, ended: Array.isArray(file.ended) ? file.ended.length : null } : null, chain: !!reader, damaged };
  }

  const config = () => ({ season, goals: GOALS, judges: Object.values(JUDGES).map(j => ({ id: j.id, label: j.label, means: j.means })), judge, herald, chain: !!reader, damaged, relay, rpcProxy: !!rpc });
  return { submit, view, config, records, caravans, season, rpc };
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
export const READ_METHODS = Object.freeze(['getAccountInfo', 'getSignaturesForAddress', 'getTransaction']);

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
  const dataDir = arg('data', path.join(repo, '.local/ws01-coop', `${programId.slice(0, 8)}-${seasonId}`));
  const rpc = arg('rpc');   // 例：http://127.0.0.1:41910（国と届け先の村をチェーンで確かめる。ないと国籍未検証）
  const board = createBoard({ herald, programId, seasonId, dataDir, judge: arg('judge', 'arrivals'), reader: rpc ? rpcReader(rpc) : null, rpc });   // 中継は同じ入口の /gw（ヘラルドの --relay が要る）
  createServer(board, { herald }).listen(port, '127.0.0.1', () => {
    console.log(`依頼の板：http://127.0.0.1:${port}/ws01/  ゲーム：http://127.0.0.1:${port}/frontier/frontier/  （ヘラルド ${herald}、記録 ${dataDir}）`);
  });
}
