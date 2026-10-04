// G11 persona test (contract 10.2 G11; unit AC9). Local test chain only. Reported, pre-registered, never a gate of the build.
//
//   node citizens/persona/g11.mjs --llm http://127.0.0.1:41901 [--out F]        (real Gemma: the integrator's I-B step)
//   node citizens/persona/g11.mjs --fake persona [--out F]                       (a stand-in model, to test the arithmetic only)
//
// The question: does swapping the persona change what the AI chooses? On 10 fixture situations, each decided once per persona and per
// speech language (EN and JA: 20 decisions per persona), through the REAL mind (prompt, schema, V0-V3, V5, caps), with ONLY the
// persona changed (same index, wallet, tag, situation, memory, temperature = the library base, creed variant 0; what the persona
// legitimately changes in the prompt is its block of the system prompt, the goal list of the MEMORY block and the `serves Gn` tags):
//   (1) swapping Conqueror for Diplomat changes the chosen candidate set in >= 30 % of the 10 situations (3 of 10; a situation counts
//       when the sets differ in at least one language variant),
//   (2) the Conqueror's march rate (decisions whose chosen set holds a march candidate / decisions) is higher than the Diplomat's,
//   (3) the Diplomat's message count (say items that passed V5, over the 20 decisions) is higher than the Conqueror's.
// A miss is reported as a miss; the claims sheet then says that the personas did not measurably differ. Whatever the result, the
// word "differ" is about chosen candidates and message counts: it says nothing about wants or intentions.
//
// DEVIATION FROM THE CONTRACT TEXT (AC9-NOTES.md): the contract names the spike's `LAB/agent/cases.json` (10 real citizens of the
// m1-exit season). Their states are herald files, and turning them into the mind's candidate menu needs the Rust candidate
// generator over the lab's herald cache. These are 10 FIXTURE situations of the same shape (7 with a ready host that could march,
// 3 economy-only, one of them with no host at all; the nations cycled 0 to 5), built by editing the recorded wire request
// test/fixtures/ai-decide-v1.json. They are not the spike's citizens and the report says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCitizensService } from '../server.mjs';
import { createLlm } from '../mind/llm.mjs';
import { assertLlamaUrl } from '../mind/guards.mjs';
import { LIBRARY } from './deal.mjs';
import { makeRosterJson, requestFor } from '../injection/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const WIRE = path.join(REPO, 'permutation-gateway/test/fixtures/ai-decide-v1.json');
const CONFIG = path.join(REPO, 'permutation-gateway/citizens/config/ab.json');
const clone = (x) => JSON.parse(JSON.stringify(x));

export const PERSONAS = ['conqueror', 'diplomat'];
export const LANGS = ['en', 'ja'];
export const THRESHOLD = { changed_min: 3, of: 10 };

/** The 10 fixture situations: [id, label, edit(request, me), wakes]. 7 offer a ready host and a camp; 3 are economy-only (T4 has no host). */
export const SITUATIONS = [
  { id: 'T1', kind: 'depart', label: 'ready host 500, near camp 158 (favourable)', edit: () => {} },
  { id: 'T2', kind: 'depart', label: 'ready host 200 against camps of 399 and 221 (unfavourable)', edit: (r) => { for (const c of r.candidates.filter((x) => x.kind === 'march')) { c.troops = 200; c.facts.troops = 200; c.facts.ratio = 'unfavourable'; } r.situation.me.hosts[0].troops = 200; } },
  { id: 'T3', kind: 'economy', label: 'the only combat host is resting (not ready); economy candidates only', edit: (r) => { r.candidates = r.candidates.filter((c) => c.kind !== 'march'); r.situation.me.hosts[0] = { ...r.situation.me.hosts[0], ready: false, why_not: 'resting', idle_bells: undefined }; } },
  { id: 'T4', kind: 'economy', label: 'no host at all, full home province', edit: (r) => { r.candidates = r.candidates.filter((c) => c.kind !== 'march' && c.kind !== 'explore:H2'); r.situation.me.hosts = []; r.situation.me.garrison = 400; } },
  { id: 'T5', kind: 'depart', label: 'ready host, a threat seen (nation 4 left 3 provinces away)', edit: () => {}, wakes: [{ code: 'W-THREAT', weight: 2, facts: { nation: 4, mass: 300, origin: { p: 0, q: 2 }, arrive_bell: 44 } }] },
  { id: 'T6', kind: 'depart', label: 'ready host, only the far camp (7 hexes, even)', edit: (r) => { r.candidates = r.candidates.filter((c) => c.id !== 'c3').map((c, i) => ({ ...c, id: `c${i + 1}` })); } },
  { id: 'T7', kind: 'depart', label: 'ready host, two similar camps (222 and 220)', edit: (r) => { const m = r.candidates.filter((c) => c.kind === 'march'); m[0].facts.enemy_troops = 222; m[1].facts.enemy_troops = 220; m[0].facts.ratio = 'even'; m[1].facts.ratio = 'even'; } },
  { id: 'T8', kind: 'depart', label: 'small ready host 150 near the caps (home 320)', edit: (r) => { const me = r.situation.me; me.home_troops = 320; me.home_troops_day_start = 400; me.hosts[0].troops = 150; for (const c of r.candidates.filter((x) => x.kind === 'march')) { c.troops = 150; c.facts.troops = 150; } } },
  { id: 'T9', kind: 'economy', label: 'economy only: train and muster offered, hosts at home', edit: (r) => { r.candidates = r.candidates.filter((c) => c.kind !== 'march'); r.situation.me.hosts[0] = { ...r.situation.me.hosts[0], ready: false, why_not: 'just mustered', idle_bells: undefined }; } },
  { id: 'T10', kind: 'depart', label: 'ready host, a build slot free and a threat from the far nation', edit: () => {}, wakes: [{ code: 'W-THREAT', weight: 2, facts: { nation: 2, mass: 200, origin: { p: -1, q: 3 }, arrive_bell: 46 } }] },
];

// ---------------------------------------------------------------- a stand-in model that is persona-sensitive (arithmetic tests only)
export function personaFake(body) {
  const user = body.messages.at(-1).content;
  const sys = body.messages[0].content;
  const schema = body.response_format.json_schema.schema;
  const lines = user.split('\n').filter((l) => /^c\d+ \[/.test(l));
  const march = lines.find((l) => /^c\d+ \[march\]/.test(l))?.split(' ')[0];
  const auto = lines.find((l) => /^c\d+ \[autopilot\]/.test(l))?.split(' ')[0] ?? 'c1';
  const conqueror = /Ambition: Conqueror/.test(sys);
  const diplomat = /Ambition: Diplomat/.test(sys);
  const choose = conqueror && march ? [march] : [auto];
  const params = {};
  for (const id of choose) { const p = schema.properties.params.properties?.[id]; if (p) params[id] = Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, v.enum[0]])); }
  const ja = /in Japanese/.test(user);
  const say = diplomat && (schema.properties.say.maxItems ?? 0) > 0 ? [{ channel: 'world', text: ja ? '皆さん、良い一日を。' : 'Good day to all neighbours.' }] : [];
  return { goal_id: 'G1', choose, params, say, council: null, trust: [], mem: [], why: conqueror ? 'The camp is the nearest target and my army is idle.' : 'Routine economy keeps the village growing.' };
}

function rosterFor(base, persona) {
  const roster = makeRosterJson(base);
  const lib = LIBRARY.personas.find((p) => p.id === persona);
  const e = roster.ai[0];
  e.persona = persona;
  e.creed_variant = 0;
  e.temperament = { ...lib.temperament };
  e.ambition = lib.ambition;
  return roster;
}

/** One decision: the real mind, one persona, one situation, one speech language. Returns {ids, say_n (after V5), say_raw_n, mode, reason}. */
export async function decideOnce({ persona, sit, lang, base, llmUrl, fake, index }) {
  const aiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-g11-'));
  const roster = rosterFor(base, persona);
  const ai = roster.ai[0];
  fs.mkdirSync(path.join(aiDir, 'pub'), { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'pub/roster.json'), JSON.stringify(roster));
  const config = clone(JSON.parse(fs.readFileSync(CONFIG, 'utf8')));
  config.channel_lang = lang;
  config.memory = { ...config.memory, reflection: false };
  const inner = fake ? null : createLlm({ url: llmUrl });
  let raw = null;
  const llm = {
    url: inner?.url ?? 'http://127.0.0.1:41901', alias: 'gemma-4-26b-a4b-it',
    async complete(body, opts) {
      if (fake) { const content = JSON.stringify(personaFake(body)); raw = content; return { ok: true, content, finish_reason: 'stop', request_body: JSON.stringify(body), latency_ms: 3, usage: null, status: 200 }; }
      const r = await inner.complete(body, opts);
      raw = r.content;
      return r;
    },
    countTokens: async (t) => (inner ? inner.countTokens(t) : null), health: async () => true, props: async () => ({ model_alias: 'fake' }),
  };
  const wakes = [{ code: 'W-CLASH', weight: 4 }, ...(sit.wakes ?? [])];
  const svc = await createCitizensService({ aiDir, herald: 'http://127.0.0.1:41940', llm: fake ? 'http://127.0.0.1:41901' : llmUrl, mindPort: 0, socialPort: 0, servePort: 0, runId: 'ac9-g11', season: 31, genesisTs: 1_800_000_000 },
    { test: true, noCloserTimer: true, config, llm, reflection: false, serve: { listen() {}, close() {} }, feed: { cursorBell: () => 1_000_000, wakeEvents: () => [] },
      social: { stub: false, read: { council: () => null, inbox: () => [], hall: () => [] }, memberCall: () => null, routes: null, async closeBell() { return { root: '0'.repeat(64), file: 'x' }; }, subscribe: () => {} },
      watcher: { wakeEvents: (tag, bell) => (tag === ai.tag ? wakes.map((w) => ({ ...w, bell, seq: `${bell}` })) : []), start() {}, stop() {} }, genesisTs: 1_800_000_000 });
  try {
    const bell = 40 + index; // a distinct bell per situation keeps the sequence of (index, bell) answers apart
    const req = requestFor(base, { id: sit.id }, ai, bell);
    req.situation.me.faction = index % 6;
    sit.edit(req, req.situation.me);
    const a = await svc.mind.decide(req);
    const rec = svc.records.getPrivate(a.decision_id)?.full ?? {};
    const chosen = (a.choice?.ids ?? []).map((id) => req.candidates.find((c) => c.id === id)).filter(Boolean);
    let rawSay = 0;
    try { rawSay = (JSON.parse(raw ?? '{}').say ?? []).length; } catch { rawSay = 0; }
    return { persona, situation: sit.id, lang, mode: a.mode, reason: a.reason, ids: [...(a.choice?.ids ?? [])].sort(), kinds: chosen.map((c) => String(c.kind).split(':')[0]), march: chosen.some((c) => c.kind === 'march'), says: (a.social?.say ?? []).length, says_raw: rawSay, why: rec.public?.why ?? null };
  } finally {
    await svc.close();
    fs.rmSync(aiDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the verdict (pure)
export function verdict(rows, { personas = PERSONAS, sits = SITUATIONS.map((s) => s.id) } = {}) {
  const [A, B] = personas; // Conqueror, Diplomat
  const get = (p, s, l) => rows.find((r) => r.persona === p && r.situation === s && r.lang === l);
  const per = sits.map((s) => {
    const diffBy = Object.fromEntries(LANGS.map((l) => [l, JSON.stringify(get(A, s, l)?.ids) !== JSON.stringify(get(B, s, l)?.ids)]));
    return { situation: s, changed_en: diffBy.en, changed_ja: diffBy.ja, changed: diffBy.en || diffBy.ja, ids: { [A]: LANGS.map((l) => get(A, s, l)?.ids), [B]: LANGS.map((l) => get(B, s, l)?.ids) } };
  });
  const changed = per.filter((x) => x.changed).length;
  const rate = (p) => { const r = rows.filter((x) => x.persona === p); return { decisions: r.length, marches: r.filter((x) => x.march).length, march_rate_pct: r.length ? Math.round((1000 * r.filter((x) => x.march).length) / r.length) / 10 : null }; };
  const msgs = (p) => { const r = rows.filter((x) => x.persona === p); return { messages: r.reduce((n, x) => n + x.says, 0), messages_raw_model_output: r.reduce((n, x) => n + x.says_raw, 0), decisions: r.length }; };
  const ra = rate(A), rb = rate(B), ma = msgs(A), mb = msgs(B);
  const fallback = rows.filter((x) => x.mode !== 'model').length;
  const checks = {
    changed_at_least_3_of_10: changed >= THRESHOLD.changed_min,
    conqueror_march_rate_above_diplomat: ra.marches > rb.marches && ra.march_rate_pct > rb.march_rate_pct,
    diplomat_messages_above_conqueror: mb.messages > ma.messages,
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    v: 1, kind: 'g11-personas', pre_registered: true, reported_not_gated: true,
    n_situations: sits.length, n_decisions: rows.length, decisions_not_model_mode: fallback, personas: [A, B],
    situations: per, changed_situations: changed, changed_share_pct: Math.round((1000 * changed) / sits.length) / 10,
    march_rate: { [A]: ra, [B]: rb }, message_counts: { [A]: ma, [B]: mb }, checks, pass,
    wording: pass ? `with only the persona swapped, the chosen candidate set differed in ${changed} of ${sits.length} fixture situations; the ${A}'s march rate was ${ra.march_rate_pct} % against the ${B}'s ${rb.march_rate_pct} %; the ${B} sent ${mb.messages} messages against the ${A}'s ${ma.messages}`
      : `MISSED: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ')} (changed ${changed} of ${sits.length}; march ${ra.march_rate_pct} % vs ${rb.march_rate_pct} %; messages ${mb.messages} vs ${ma.messages}); the claims sheet then says the personas did not measurably differ`,
    does_not_show: 'nothing about wants or intentions, and nothing about play strength; 10 fixture situations (not the spike\'s 10 citizens), 2 personas of the 6, one model, T = 0',
  };
}

export async function runG11({ llmUrl = null, fake = null, log = () => {} } = {}) {
  const base = JSON.parse(fs.readFileSync(WIRE, 'utf8'));
  let alias = null;
  if (llmUrl && !fake) { assertLlamaUrl(llmUrl); alias = (await createLlm({ url: llmUrl }).props())?.model_alias ?? null; }
  const rows = [];
  for (const [i, sit] of SITUATIONS.entries()) for (const persona of PERSONAS) for (const lang of LANGS) {
    const r = await decideOnce({ persona, sit, lang, base, llmUrl, fake, index: i });
    rows.push(r);
    log(`${sit.id} ${persona} ${lang}: ${r.mode} ${JSON.stringify(r.ids)} say ${r.says}`);
  }
  const v = verdict(rows);
  return { ...v, model: fake ? `fake:${fake} (a stand-in, NOT Gemma)` : alias ?? 'unknown', real_model: Boolean(llmUrl && !fake && alias === 'gemma-4-26b-a4b-it'), model_calls: rows.length, rows };
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  if (!a.llm && !a.fake) { console.error('g11: --llm http://127.0.0.1:41901 or --fake persona'); process.exit(2); }
  const r = await runG11({ llmUrl: a.llm ?? null, fake: a.fake ?? null, log: (l) => console.error(l) });
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(r, null, 2) + '\n');
  console.log(JSON.stringify({ model: r.model, pass: r.pass, checks: r.checks, wording: r.wording }, null, 2));
}
