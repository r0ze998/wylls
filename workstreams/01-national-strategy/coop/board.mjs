#!/usr/bin/env node
// 依頼の板：署名付きの記録を受け取り、確かめて、追記で保存する。ゲームと同じ入口（オリジン）で画面を出すため、
// それ以外の要求はヘラルドへそのまま転送する（127.0.0.1 だけ）。
//
//   node workstreams/01-national-strategy/coop/board.mjs --herald http://127.0.0.1:41940 \
//        --program <program id> --season <id> [--port 41873] [--data <dir>] [--judge arrivals]
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const SERVE = [path.join(repo, 'workstreams/01-national-strategy/coop'), path.join(repo, 'permutation-server/web')];
/** 画面の場所（相対 import が repo の permutation-server/web に届くよう、repo の並びのまま出す）。 */
export const PAGE = '/ws01/repo/workstreams/01-national-strategy/coop/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** 板を作る（テストからも使う）。`fetchHerald(path) → {status, json}` を差し替えられる。 */
export function createBoard({ herald, programId, seasonId, dataDir, judge = 'arrivals', now = () => Math.floor(Date.now() / 1000), fetchHerald = null }) {
  const season = { programId, seasonId: String(seasonId) };
  fs.mkdirSync(dataDir, { recursive: true });
  const recFile = path.join(dataDir, 'records.jsonl');
  const obsFile = path.join(dataDir, 'observed.json');
  const records = fs.existsSync(recFile) ? fs.readFileSync(recFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const obs = fs.existsSync(obsFile) ? JSON.parse(fs.readFileSync(obsFile, 'utf8')) : { ended: {}, vaults: {} };
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

  /** 記録を一つ受け取る。{ok, id} か {ok:false, why}。 */
  async function submit(rec) {
    const shape = shapeProblem(rec, GOALS);
    if (shape) return { ok: false, why: shape };
    if (!(await verifySig(rec))) return { ok: false, why: '署名が合わない' };
    if (Math.abs(rec.at - now()) > CLOCK_SKEW) return { ok: false, why: `時刻が板の時計と ${CLOCK_SKEW} 秒より離れている` };
    if (rec.kind === 'link') {
      const q = state().requests[rec.request];
      if (!q) return { ok: false, why: '依頼が見つからない' };
      const file = await caravans();
      if (!file) return { ok: false, why: 'ヘラルドの隊商の一覧が読めないので、隊商を確かめられない' };
      const why = linkProblem(q, rec.caravan, ownerTagOf(season, rec.signer), file);
      if (why) return { ok: false, why };
    }
    const after = fold([...records, rec], { goals: GOALS, season });
    const id = recordId(rec);
    const bad = after.rejected.find(x => x.id === id);
    if (bad) return { ok: false, why: bad.why };
    records.push(rec);
    fs.appendFileSync(recFile, `${JSON.stringify(rec)}\n`);
    return { ok: true, id };
  }

  async function view({ viewer = null, nation = null, judgeId = judge } = {}) {
    const file = await caravans();
    const v = coopView({ state: state(), file, obs, viewer, viewerNation: nation, now: now(), judgeId, season });
    return { ...v, heraldFeed: file ? { moving: (file.moving ?? []).length, ended: Array.isArray(file.ended) ? file.ended.length : null } : null };
  }

  const config = () => ({ season, goals: GOALS, judges: Object.values(JUDGES).map(j => ({ id: j.id, label: j.label })), judge, herald });
  return { submit, view, config, records, caravans, season };
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
      if (url.pathname === '/coop/view') {
        const nation = url.searchParams.get('nation');
        return send(res, 200, await board.view({ viewer: url.searchParams.get('viewer') || null, nation: nation === null || nation === '' ? null : Number(nation), judgeId: url.searchParams.get('judge') || undefined }));
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
  const board = createBoard({ herald, programId, seasonId, dataDir, judge: arg('judge', 'arrivals') });
  createServer(board, { herald }).listen(port, '127.0.0.1', () => {
    console.log(`依頼の板：http://127.0.0.1:${port}/ws01/  ゲーム：http://127.0.0.1:${port}/frontier/frontier/  （ヘラルド ${herald}、記録 ${dataDir}）`);
  });
}
