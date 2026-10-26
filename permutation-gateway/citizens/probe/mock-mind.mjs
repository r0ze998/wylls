// A stand-in for the citizens' mind service (AI contract §4.1, §8.1: POST /v1/decide, POST /v1/outcome) for checking
// the brain's side of an S1 season on a local test chain WITHOUT a language model.
//
// It is NOT an AI citizen and its runs are not AI runs: no model is called, nothing is remembered, nothing is said.
// A fixed rule picks one of the candidates the brain (frontier-bots, bots/src/ai/brain.rs and ai/s1.rs) offers, so
// that the brain's observations, its S1 candidates (caravan, ambush, escort, the workshop), its re-planning at the
// choice (V6) and its sends can be watched end to end. Every request and answer is one line of the JSONL log
// (observation summary, the offered candidates, the choice and why, then the outcome of the sends).
//
//   node permutation-gateway/citizens/probe/mock-mind.mjs --port 41780 --token-file .local/x/mind.token --log .local/x/mock-mind.jsonl
//
// The rule, in order (the brain checks every choice again and may drop it):
//   1. an S1 caravan the brain offers (a store over 80 % of its cap), at most once every CARAVAN_EVERY turns per citizen;
//   2. an S1 march: an escort of the citizen's own caravan, else an ambush of another nation's caravan;
//   3. a march to a barbarian camp the brain calls favourable, when the citizen has no march on the road;
//   4. the workshop, then any other build, train or muster the brain offers;
//   5. otherwise the routine (autopilot, the brain's own economy and duties).
// A parameter takes the first value the brain allows. Loopback only; one bearer token; bodies at most 1 MiB.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const CARAVAN_EVERY = 12;
const BODY_MAX = 1 << 20;

/** The choice for one /v1/decide request: `{id, why}` (pure; tested). `last` maps a citizen's tag to its last caravan bell. */
export function choose(req, last = new Map()) {
  const cs = Array.isArray(req?.candidates) ? req.candidates : [];
  const kind = c => String(c?.kind ?? '');
  const tag = String(req?.ai?.tag ?? '');
  const bell = Number(req?.bell ?? 0);
  const byKind = k => cs.find(c => kind(c) === k || kind(c).startsWith(`${k}:`));
  const caravan = byKind('caravan');
  if (caravan && bell - (last.get(tag) ?? -Infinity) >= CARAVAN_EVERY) return { id: caravan.id, why: 's1-caravan' };
  const march = t => cs.find(c => kind(c) === 'march' && c?.facts?.target_kind === t);
  const s1march = march('escort') ?? march('ambush');
  if (s1march) return { id: s1march.id, why: `s1-${s1march.facts.target_kind}` };
  const onRoad = Array.isArray(req?.own_marches) && req.own_marches.some(m => m && m.opened === null);
  const camp = cs.find(c => kind(c) === 'march' && c?.facts?.target_kind === 'camp' && c?.facts?.ratio === 'favourable');
  if (camp && !onRoad) return { id: camp.id, why: 'camp' };
  const workshop = byKind('build:workshop');
  if (workshop) return { id: workshop.id, why: 'workshop' };
  const econ = cs.find(c => /^(build|walls|train|muster)/.test(kind(c)));
  if (econ) return { id: econ.id, why: 'economy' };
  const auto = cs.find(c => kind(c) === 'autopilot');
  return { id: auto?.id ?? cs[0]?.id ?? 'c1', why: 'routine' };
}

/** The first allowed value of every parameter of the chosen candidate. */
export function paramsOf(c) {
  const out = {};
  for (const [k, vs] of Object.entries(c?.params ?? {})) if (Array.isArray(vs) && vs.length) out[k] = vs[0];
  return out;
}

/** The /v1/decide answer (wire v1, as bots/src/ai/mindport.rs reads it). */
export function answerOf(req, pick, n) {
  const c = (req.candidates ?? []).find(x => x.id === pick.id);
  const auto = !c || c.kind === 'autopilot';
  return {
    v: 1, decision_id: `mock-${n}`, mode: auto ? 'autopilot' : 'model', reason: `mock:${pick.why}`,
    choice: { ids: [pick.id], mem: [], params: auto ? {} : { [pick.id]: paramsOf(c) } },
    caps: { home_floor: null, march_troops_left: null }, standing: { declined_calls: [], reserved: [] },
    social: { ballot: null, motion: null, say: [] },
  };
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}

function main() {
  const port = Number(arg('--port', '41780'));
  const token = readFileSync(arg('--token-file'), 'utf8').trim();
  const log = arg('--log');
  const write = o => appendFileSync(log, `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);
  const last = new Map();
  let n = 0;
  const server = createServer((rq, rs) => {
    const send = (code, body) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(body)); };
    if (rq.method !== 'POST' || rq.headers.authorization !== `Bearer ${token}`) return send(rq.method !== 'POST' ? 405 : 401, { ok: false });
    let size = 0;
    const parts = [];
    rq.on('data', b => { size += b.length; if (size > BODY_MAX) rq.destroy(); else parts.push(b); });
    rq.on('end', () => {
      let req;
      try { req = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return send(400, { ok: false }); }
      if (rq.url === '/v1/decide') {
        const pick = choose(req, last);
        const a = answerOf(req, pick, ++n);
        const c = (req.candidates ?? []).find(x => x.id === pick.id);
        if (pick.why === 's1-caravan') last.set(String(req.ai?.tag ?? ''), Number(req.bell ?? 0));
        write({ kind: 'decide', mock: true, decision_id: a.decision_id, ai: req.ai?.tag, index: req.ai?.index, bell: req.bell, obs_digest: req.obs_digest,
          offered: (req.candidates ?? []).map(x => `${x.id}:${x.kind}${x.facts?.target_kind ? `/${x.facts.target_kind}` : ''}`),
          chose: { id: pick.id, kind: c?.kind ?? null, label: c?.label ?? null, why: pick.why, params: a.choice.params[pick.id] ?? {} } });
        return send(200, a);
      }
      if (rq.url === '/v1/outcome') {
        write({ kind: 'outcome', mock: true, decision_id: req.decision_id, actions: req.actions ?? [] });
        return send(200, { ok: true });
      }
      return send(404, { ok: false });
    });
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`mock-mind: listening on 127.0.0.1:${port} (no model; a fixed rule)\n`));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
