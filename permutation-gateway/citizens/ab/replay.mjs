// Arm B replays arm A's AI council answers (contract 9.3). Unit AC9. Local test chain only.
//
// The contract: "for arm B, ab.json carries replay_council_from: <arm A's PUB>, and the mind answers the AI's council-motion
// and council-ballot jobs of that period with arm A's stored answer (option and speech) when options_hash is equal (no model
// call for those jobs; counted council_replayed and disclosed in the A/B table), so the AI's council inputs are equal by
// construction and the seat's ballot is the only varied input; if options_hash differs the jobs run normally and the pair is
// invalid."
//
// DEVIATION (written in AC9-NOTES.md): the mind (mind/api.mjs, AC1a) has no such hook and is not in this unit's row. This file
// does it one layer down, where nothing of the mind changes: a loopback reverse proxy for llama-server. The arm B config
// (`makeArmBConfig`) points `llm.url` at this proxy and names `replay_council_from`. The mind then runs its WHOLE pipeline on a
// replayed council job (prompt, schema, V1-V3, V5, record, signed-ready output, provenance), only the model's JSON text comes
// from arm A: `{council: {motion|ballot: <A's option>}, say: [<A's speech>]}`. Everything else (sessions, reactions,
// reflections, /health, /props, /tokenize) is forwarded unchanged. A council job that arm A has no answer for is forwarded to the
// model and counted `miss`.
//
// What a replayed answer is NOT: model output of arm B. Its record is a `model` record whose request body was never sent to
// llama, so an M9 replay of that one record cannot reproduce it (it is an arm B record, the A/B arms are not audit claims).
//
// Matching: the system prompt names the AI ("You are <name>, a citizen of nation <f>"), the schema name says motion or ballot,
// and the user prompt lists the council options; options_hash is computed over {option, kind, p, q} exactly as the social
// service does (social/council.mjs optionsHash). arm A's answers are read from its PUB: council/<k>-<f>.json (motions: wallet,
// option, text; after the open: the ballots' bytes, decoded with aisocial.mjs) and roster.json (wallet -> name).
//
//   node citizens/ab/replay.mjs --from <arm A AI_DIR/pub> --upstream http://127.0.0.1:41901 [--port 41990] [--factions 0]
//        [--log AI_DIR/ab/replay-B-1.json]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBallot, toBase58, fromBase64 } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { optionsHash } from '../social/council.mjs';
import { assertLoopbackUrl, assertAiPort } from '../mind/guards.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** arm A's council answers: Map(`${name}|motion|${options_hash}` -> {option, text, wallet}), `${name}|ballot|...` -> {option, wallet}. */
export function loadReplayTable(pubDir, { factions = [0] } = {}) {
  const roster = readJson(path.join(pubDir, 'roster.json'));
  const nameOf = new Map((roster?.ai ?? []).map((a) => [a.wallet, a.name?.en ?? null]));
  const factionOf = new Map((roster?.ai ?? []).map((a) => [a.wallet, a.faction]));
  const table = new Map();
  const periods = [];
  const dir = path.join(pubDir, 'council');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /^(\d+)-(\d+)\.json$/.exec(f);
    if (!m || !factions.includes(Number(m[2]))) continue;
    const j = readJson(path.join(dir, f));
    if (!j?.options_hash) continue;
    periods.push({ period: j.period, faction: j.faction, options_hash: j.options_hash });
    for (const mo of j.motions ?? []) {
      const name = nameOf.get(mo.wallet);
      if (!name || !(mo.ai_roster ?? true)) continue;
      table.set(`${name}|motion|${j.options_hash}`, { option: mo.option, text: mo.text ?? '', wallet: mo.wallet, period: j.period });
    }
    for (const b of j.open?.ballots ?? []) {
      if (!b.bytes_b64) continue;
      let d;
      try { d = decodeBallot(fromBase64(b.bytes_b64)); } catch { continue; }
      const w = toBase58(d.wallet);
      const name = nameOf.get(w);
      if (!name || factionOf.get(w) !== j.faction) continue;
      table.set(`${name}|ballot|${j.options_hash}`, { option: d.option, wallet: w, period: j.period });
    }
  }
  return { table, periods };
}

const OPTION_LINE = /^ {2}option (\d+): (\w+) at \((-?\d+),(-?\d+)\), /;
/** {name, kind, options_hash} of a chat/completions body the mind built for a council job, or null when it is not one. */
export function identifyCouncilJob(body) {
  const kind = body?.response_format?.json_schema?.name ?? null;
  if (kind !== 'motion' && kind !== 'ballot') return null;
  const sys = body.messages?.[0]?.content ?? '';
  const user = body.messages?.at(-1)?.content ?? '';
  const nm = /^You are (.+?), a citizen of nation \d+ in "Wylls"/m.exec(sys);
  if (!nm) return null;
  const options = [];
  for (const l of user.split('\n')) {
    const m = OPTION_LINE.exec(l);
    if (m) options.push({ option: Number(m[1]), kind: m[2], p: Number(m[3]), q: Number(m[4]) });
  }
  if (!options.length) return null;
  return { name: nm[1], kind, options, options_hash: optionsHash(options), schema: body.response_format.json_schema.schema };
}

/** The model's JSON text for a replayed answer; null when it does not fit this request's schema (then the job runs normally). */
export function replayedContent(job, ans) {
  const props = job.schema?.properties ?? {};
  const goal = props.goal_id?.enum?.[0] ?? 'G1';
  const council = job.kind === 'motion' ? { motion: ans.option } : { ballot: ans.option };
  const allowed = job.kind === 'motion' ? props.council?.properties?.motion?.enum : props.council?.properties?.ballot?.enum;
  if (allowed && !allowed.includes(ans.option)) return null;
  const say = [];
  if (job.kind === 'motion' && ans.text && (props.say?.maxItems ?? 0) > 0) say.push({ channel: 'nation', text: ans.text });
  return JSON.stringify({ goal_id: goal, choose: [], params: {}, say, council, trust: [], mem: [], why: 'Answer replayed from arm A of this A/B pair.' });
}

/**
 * createReplayProxy({from (arm A's PUB), upstream (llama base URL), factions, log}) -> {listen(port), close(), stats()}
 * Binds 127.0.0.1 only, a port in 41901-41999 (0 in tests).
 */
export function createReplayProxy({ from, upstream, factions = [0], log = null, fetchImpl = globalThis.fetch } = {}) {
  assertLoopbackUrl(upstream, 'upstream');
  const { table, periods } = loadReplayTable(from, { factions });
  const stats = { table_size: table.size, periods: periods.length, council_replayed: 0, replayed: [], miss: [], passed_through: 0, errors: 0 };
  const save = () => {
    if (!log) return;
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, JSON.stringify({ v: 1, kind: 'council-replay', from_pub: path.basename(path.dirname(from)), ...stats }, null, 1));
  };
  const handler = async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const send = (code, text, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(text); };
    try {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = null;
        try { body = JSON.parse(raw.toString('utf8')); } catch { /* forwarded as is */ }
        const job = body ? identifyCouncilJob(body) : null;
        if (job) {
          const key = `${job.name}|${job.kind}|${job.options_hash}`;
          const ans = table.get(key);
          const content = ans ? replayedContent(job, ans) : null;
          if (content) {
            stats.council_replayed += 1;
            stats.replayed.push({ name: job.name, kind: job.kind, options_hash: job.options_hash, option: ans.option, from_period: ans.period });
            save();
            return send(200, JSON.stringify({ id: 'replay', object: 'chat.completion', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 0, completion_tokens: 0 }, timings: { predicted_per_second: 0 }, system_fingerprint: 'ab-replay' }));
          }
          stats.miss.push({ name: job.name, kind: job.kind, options_hash: job.options_hash, reason: ans ? 'answer does not fit the schema' : 'arm A has no answer for this AI, kind and options_hash' });
          save();
        }
      }
      stats.passed_through += 1;
      const r = await fetchImpl(upstream.replace(/\/+$/, '') + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json' }, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw });
      send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') ?? 'application/json');
    } catch (e) {
      stats.errors += 1;
      send(502, JSON.stringify({ error: String(e?.message ?? e).slice(0, 120) }));
    }
  };
  let server = null;
  return {
    stats: () => ({ ...stats }),
    listen(port = 41990, { test = false } = {}) {
      assertAiPort(port, 'replay proxy port', { test });
      return new Promise((resolve, reject) => {
        server = http.createServer(handler);
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port }));
      });
    },
    close: () => new Promise((r) => (server ? server.close(() => r()) : r())),
  };
}

/**
 * The arm B citizens config: arm A's config plus `replay_council_from` and `llm.url` pointing at the proxy. It is a different
 * file from arm A's, so its sha256 (citizens_config_sha256 in the commitments) differs: that and the routing through the proxy
 * are the only changes besides the seat's ballot, and the A/B table says so.
 */
export function makeArmBConfig({ baseConfigPath, armAPub, shimUrl, outPath }) {
  assertLoopbackUrl(shimUrl, 'replay proxy url');
  const cfg = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));
  cfg.replay_council_from = armAPub;
  cfg.llm = { ...(cfg.llm ?? {}), url: shimUrl };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const text = JSON.stringify(cfg, null, 1) + '\n';
  fs.writeFileSync(outPath, text);
  return { path: outPath, replay_council_from: armAPub, llm_url: shimUrl };
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  if (!a.from || !a.upstream) { console.error('replay: --from <arm A pub dir> and --upstream <llama url> are required'); process.exit(2); }
  const p = createReplayProxy({ from: path.resolve(a.from), upstream: a.upstream, factions: (a.factions ?? '0').split(',').map(Number), log: a.log ? path.resolve(a.log) : null });
  const { port } = await p.listen(Number(a.port ?? 41990));
  console.log(JSON.stringify({ ok: true, port, table_size: p.stats().table_size }));
  const stop = async () => { await p.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
