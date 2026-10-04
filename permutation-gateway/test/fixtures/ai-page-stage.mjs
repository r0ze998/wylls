// A stage for the council page (unit AC7): serves council.html the way a run does, without a stack or a model, so the page
// can be opened, screenshotted and driven in a browser.
//
//   node permutation-gateway/test/fixtures/ai-page-stage.mjs --pub-src <a PUB directory> --work <scratch dir> \
//        [--scenario motions|ballots|closed|opened] [--port 41902] [--herald-port 41993] [--social-port 41997]
//
// What runs: the REAL serve.mjs (41902), the REAL social service of AC4 (createSocial, over the work directory, with
// council windows, the human-present rule, ballots, call reads and the opening at S + 2), and a small fake herald that
// answers /h/season and serves permutation-server/web under /frontier/ the way the real herald's static handler does.
// What is real and what is not (nothing here is a run):
//   * from the source PUB, untouched (copied): roster names, tags and personas; the per-bell decision records
//     (`minds/*.json`, sealed commitments included); the episode files; the metrics counters.
//   * SYNTHETIC overlay, written by this file: the wallets and session keys of the roster's AIs and seat (fresh local test
//     keys, so the page's signatures can be verified by the real social service), the Wyll cards (goal progress, one
//     relationship and grievance, one self-summary), the opened records of two sealed march decisions (candidates, words,
//     destination), the chronicle, the departures panel, the council options and the AI motions, ballots and messages.
// Ports: 41901-41999 only (tests pass 0). Everything binds 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSocial } from '../../citizens/social/routes.mjs';
import { createServe } from '../../citizens/serve.mjs';
import { makeCitizen, fakeHerald, builders } from './ai-social-kit.mjs';
import { testKey } from '../../citizens/social/vectors.mjs';
import { sha256, toBase58, toHex } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { citizenTag, withSeed, seedOf } from '../../../permutation-server/web/frontier/faddr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '../../../permutation-server/web');
const library = JSON.parse(fs.readFileSync(path.join(here, '../../citizens/persona/library.json'), 'utf8'));

export const GENESIS = 1_790_000_000;
const NULL_GOALS = new Set(['talk_neighbours', 'move_option', 'build_three', 'move_grievance_option', 'tier_up_three_builds', 'explore_daily', 'strike_the_mover', 'raid_weak_stacks']);
const OPTIONS = [
  { option: 1, kind: 'camp', p: 2, q: 1, value: 120, own: 400, ratio: 'favourable' },
  { option: 2, kind: 'strike', p: 1, q: 3, value: 500, own: 640, ratio: 'even' },
  { option: 3, kind: 'raid', p: 4, q: -2, value: 800, own: 700, ratio: 'unfavourable' },
];

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
const assertPort = (n, what) => { if (n !== 0 && !(Number.isInteger(n) && n >= 41901 && n <= 41999)) throw new Error(`${what}: port ${n} is outside 41901-41999`); };

function listenHttp(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); });
}

export async function startStage({ pubSrc, work, scenario = 'ballots', port = 41902, heraldPort = 41993, socialPort = 41997 } = {}) {
  for (const [p, w] of [[port, 'serve'], [heraldPort, 'herald'], [socialPort, 'social']]) assertPort(p, w);
  if (!pubSrc || !work) throw new Error('pubSrc and work are required');
  fs.rmSync(work, { recursive: true, force: true });
  const pub = path.join(work, 'pub');
  fs.mkdirSync(pub, { recursive: true });
  fs.cpSync(pubSrc, pub, { recursive: true });

  // ---------------------------------------------------------------- the roster with local test keys (SYNTHETIC wallets)
  const roster = readJson(path.join(pub, 'roster.json'));
  const citizens = new Map();
  for (const a of roster.ai) {
    const c = makeCitizen(`ai-${a.index}`, { faction: a.faction, tag: BigInt(`0x${a.tag}`) });
    citizens.set(a.tag, c);
    a.wallet = c.b58;
  }
  const seat = makeCitizen('seat', { faction: roster.seat.faction, tag: BigInt(`0x${roster.seat.tag}`) });
  roster.seat.wallet = seat.b58;
  citizens.set('seat', seat);
  writeJson(path.join(pub, 'roster.json'), roster);

  // ---------------------------------------------------------------- season, clock, herald
  const bells = { motions: 73, ballots: 76, closed: 79, opened: 86 };
  if (!(scenario in bells)) throw new Error(`scenario: one of ${Object.keys(bells)}`);
  const state = { b: 72 };
  const unixOf = b => GENESIS + b * 600 + 60;
  const clock = { bell: () => state.b, unix: () => unixOf(state.b) };
  const seasonAddress = toBase58(sha256('ai-page-stage/season'));
  const seasonJson = () => ({ v: 1, programId: roster.program_id, cluster: 'localnet', season: String(roster.season), seasonAddress, genesisTs: GENESIS, bellSecs: 600, latestUnix: unixOf(state.b) });
  const heraldServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/h/season') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(seasonJson())); }
    if (u.pathname.startsWith('/frontier/')) {
      const rel = u.pathname.slice('/frontier/'.length);
      const safe = /^[A-Za-z0-9/._-]+$/.test(rel) && rel.split('/').every(s => s && !s.startsWith('.'));
      const p = path.join(webDir, rel);
      if (safe && fs.existsSync(p) && fs.statSync(p).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : p.endsWith('.css') ? 'text/css' : 'application/octet-stream', 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(p)); }
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false,"code":"NotFound"}');
  });
  const heraldBound = await listenHttp(heraldServer, heraldPort);

  // ---------------------------------------------------------------- the social service (real) with a provenance table for the AIs' records
  const outputs = new Map();
  const herald = fakeHerald([...citizens.values()]);
  const social = createSocial({
    herald, aiDir: work, roster, clock, season: roster.season,
    provenance: { provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, consume: () => true },
    config: { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } },
  });
  const socialListener = await social.routes.listen({ port: socialPort });
  const socialBound = socialListener.port;
  const B = builders({ bell: () => state.b, unix: () => unixOf(state.b) }, roster.season);
  let decisionSeq = 0;
  const post = async (path_, body) => social.routes.dispatch({ method: 'POST', path: path_, body: JSON.stringify(body), headers: {}, peer: '127.0.0.1' });
  async function aiTalk(tag, fields, expected) {
    const c = citizens.get(tag);
    const id = `stage-${++decisionSeq}`;
    const m = B.talk(c, { origin: 1, ...fields }, { decision_id: id, item: 0 });
    outputs.set(`${id}|0|talk`, { bell: state.b, text: fields.text, channel: m.fields.channel, kind: m.fields.kind, ref: m.fields.ref, ...expected });
    const r = await post('/f/ai/talk', m.body);
    if (r.status !== 200) throw new Error(`stage: AI talk refused ${JSON.stringify(r.body)}`);
  }
  async function aiBallot(tag, option) {
    const c = citizens.get(tag);
    const council = social.council.publicOf(c.faction, 3);
    const id = `stage-${++decisionSeq}`;
    const m = B.ballot(c, { period: 3, faction: c.faction, option, candidates_hash: council.candidates_hash, origin: 1 }, { decision_id: id, item: 0 });
    outputs.set(`${id}|0|ballot`, { bell: state.b, option });
    const r = await post('/f/ai/ballot', m.body);
    if (r.status !== 200) throw new Error(`stage: AI ballot refused ${JSON.stringify(r.body)}`);
  }
  async function seatBallot(option) {
    const council = social.council.publicOf(seat.faction, 3);
    const m = B.ballot(seat, { period: 3, faction: seat.faction, option, candidates_hash: council.candidates_hash, origin: 0 });
    const r = await post('/f/ai/ballot', m.body);
    if (r.status !== 200) throw new Error(`stage: seat ballot refused ${JSON.stringify(r.body)}`);
  }

  // ---------------------------------------------------------------- the story, in the real council store
  const ai0 = roster.ai.find(a => a.faction === 0);
  const ai1 = roster.ai.find(a => a.faction === 1);
  const sendSeat = async (fields) => post('/f/ai/talk', B.talk(seat, fields).body);
  state.b = 72;
  social.council.open({ faction: 0, period: 3, c0: 72, candidates: OPTIONS });
  state.b = 73;
  await aiTalk(ai0.tag, { channel: 1, target: 0, kind: 1, ref: (3n << 8n) | 1n, text: 'The camp at (2,1) is close and lightly held. I move option 1.', lang: 'en' }, {});
  await aiTalk(ai1.tag, { channel: 0, text: 'Borealis watches the camps near our border.', lang: 'en' }, {});
  await aiTalk(ai1.tag, { channel: 3, target: ai0.wallet, text: 'We do not seek a fight with Aster this season.', lang: 'en' }, {});
  await sendSeat({ channel: 1, target: 0, text: 'Presenter here: reading the motions before I vote.', lang: 'en' });
  if (scenario !== 'motions') {
    state.b = 76;
    await aiBallot(ai0.tag, 1);
  }
  if (scenario === 'closed' || scenario === 'opened') {
    await seatBallot(1);
    state.b = 79;
    await social.tick();
    social.council.seal(0, 3, { tile: 5, invited: ['2001', '2002', '2003'] });
  }
  if (scenario === 'opened') {
    state.b = 86;
    await social.tick();
    social.council.setResult(0, 3, { present: 2, bounced: 0, clash: { engagements: 1, lost: { 0: 80, 3: 140 } } });
  }
  state.b = bells[scenario];

  // ---------------------------------------------------------------- overlays on PUB (SYNTHETIC; see the header)
  const metrics = fs.existsSync(path.join(pub, 'metrics', 'latest.json')) ? readJson(path.join(pub, 'metrics', 'latest.json')) : { groups: {} };
  const mindsFiles = fs.existsSync(path.join(pub, 'minds')) ? fs.readdirSync(path.join(pub, 'minds')).filter(f => /^\d+\.json$/.test(f)) : [];
  const sealed = mindsFiles.flatMap(f => readJson(path.join(pub, 'minds', f)).records).filter(r => r.sealed);
  const episodesOf = tag => (fs.existsSync(path.join(pub, 'memory', tag, 'episodes.json')) ? readJson(path.join(pub, 'memory', tag, 'episodes.json')).episodes : []);
  const nameOf = tag => roster.ai.find(a => a.tag === tag)?.name ?? { en: tag.slice(0, 6), ja: tag.slice(0, 6) };

  // opened records: the sealed march of ai1 at bell 70 (cites a real episode) and of ai0 at bell 52 (cites nothing)
  const open = {};
  const make = (rec, { why, mem, camp, arrive }) => {
    const eps = episodesOf(rec.ai);
    const cited = mem.map(id => eps.find(e => e.id === id)).filter(Boolean);
    const candidates = [
      { id: 'c1', kind: 'autopilot', label: 'routine: economy and duties only', facts: { summary: 'build; train (economy and duties only, no march)' }, entities: [], refs: [] },
      { id: 'c2', kind: 'hold', label: 'hold: keep armies home', facts: { note: 'duties only' }, entities: [], refs: [] },
      { id: 'c3', kind: 'march', label: `march 300 troops at the camp at (${camp.p},${camp.q})`, facts: { distance_hexes: 7, target_troops: 190, ratio: 'favourable (estimate)', idle_bells: 12, reward: '10 Works (points, no use yet)' }, entities: [`pq:${camp.p},${camp.q}`], refs: cited.map((_, i) => `M${i + 1}`), troops: 300 },
      { id: 'c4', kind: 'march', label: 'march 300 troops at the enemy stack at (0,3)', facts: { distance_hexes: 9, visible_troops: 480, ratio: 'unfavourable (estimate)', reward: 'troops lost only; no land can be taken' }, entities: ['pq:0,3', 'nation:1'], refs: [], troops: 300 },
    ];
    return {
      id: rec.id, nonce: '00'.repeat(16), ai: rec.ai, bell: rec.bell, index: rec.index, mode: 'model', release_bell: rec.release_bell,
      choice: { ids: ['c3'], params: { c3: { stance: 'assault', retreat: 5000, timing: 'earliest' } }, council: null, goal_id: 'G2', mem: cited.map(e => e.id) },
      retrieved: eps.filter(e => e.created_bell < rec.bell).slice(-6).map(e => e.id),
      public: { say: [], why, why_withheld: null },
      candidates, remembered: cited.map(e => ({ id: e.id, bell: e.bell, text: e.text })),
      destinations: [{ host_id: '9001', p: camp.p, q: camp.q, tile: 5, planned_arrive_bell: rec.release_bell, arrive_bell: arrive }],
    };
  };
  const s70 = sealed.find(r => r.ai === ai1.tag && r.bell === 70);
  const s52 = sealed.find(r => r.ai === ai0.tag && r.bell === 52);
  const openAt = {};
  if (s70) {
    const eps = episodesOf(ai1.tag);
    const mem = eps.filter(e => e.kind === 'clash_own_win').map(e => e.id).slice(0, 1);
    (openAt[75] ??= []).push(make(s70, { why: 'The camp is close, my army has been idle for twelve bells and the last camp fight went well.', mem, camp: { p: -1, q: 2 }, arrive: 74 }));
  }
  if (s52) (openAt[57] ??= []).push(make(s52, { why: 'An idle army is wasted; the camp is close and weakly held.', mem: [], camp: { p: 3, q: -1 }, arrive: 56 }));
  for (const [b, recs] of Object.entries(openAt)) writeJson(path.join(pub, 'open', `${b}.json`), { bell: Number(b), records: recs });
  // one more sealed march, not opened yet (synthetic record in the shape of a sealed one)
  const fresh = { v: 2, sealed: true, release_bell: state.b + 4, commit: toHex(sha256('ai-page-stage/commit')), tx: [{ intent: 'depart', sig: 's'.repeat(64), status: 'sent', code: null }], ai: ai0.tag, index: ai0.index, bell: state.b - 1, kind: 'session', mode: 'model', reason: 'ok', wake: ['W-PULSE'], gate_score: 3, id: toHex(sha256('ai-page-stage/fresh')) };
  writeJson(path.join(pub, 'minds', `${state.b - 1}.json`), { bell: state.b - 1, root: '00'.repeat(32), records: [fresh] });

  // cards
  const personas = new Map(library.personas.map(p => [p.id, p]));
  for (const a of roster.ai) {
    const p = personas.get(a.persona);
    const eps = episodesOf(a.tag);
    const grp = metrics.groups?.[`ai:${a.tag}`] ?? {};
    const isAi0 = a.tag === ai0.tag;
    const reasons = Object.values(openAt).flat().filter(o => o.ai === a.tag).map(o => ({ bell: o.bell, decision_id: o.id, by: 'model', why: o.public.why, remembered: o.remembered.map(m => ({ id: m.id, bell: m.bell, age_bells: o.bell - m.bell, text: m.text })) }));
    writeJson(path.join(pub, 'cards', `${a.tag}.json`), {
      v: 1, ai: true,
      label: { en: 'AI citizen — run by the operator with Gemma 4 (local). Same rules and quotas as people.', ja: 'AI市民（運営がローカルのGemma 4で動かしています）。人と同じルールと回数制限で遊びます。' },
      tag: a.tag, wallet: a.wallet, faction: a.faction, index: a.index, name: a.name,
      persona: { id: a.persona, ambition: a.ambition.en, creed: p.creeds[a.creed_variant % p.creeds.length], temperament: a.temperament },
      goals: p.goals.map((g, i) => ({ id: g.id, text: g.text, progress: NULL_GOALS.has(g.key) ? null : [66, 100, 33, 0][i % 4], status: 'active', memory: !!g.memory })),
      relationships: isAi0 ? [{ who: ai1.tag, name: ai1.name, kind: 'citizen', trust: -20, trust_code: -15, trust_model: -5, last_event_bell: 68 }, { who: 'nation:1', name: { en: 'Borealis', ja: 'ボレアリス' }, kind: 'nation', trust: -5, trust_code: -5, trust_model: 0, last_event_bell: 68 }] : [],
      memory: {
        summary: isAi0 ? { bell: 72, text: 'Borealis sent two armies near my border. I cleared a camp at bell 55 and kept my home troops steady.', sha256: toHex(sha256('summary')), label: { en: "Written by the AI's model; not verified, not replayed.", ja: 'AIのモデルが書いた文章です。確認も再現もされていません。' } } : null,
        recent: eps.slice(-5).map(e => ({ id: e.id, bell: e.bell, kind: e.kind, text: e.text })),
        grievances: isAi0 ? [{ against: ai1.tag, name: ai1.name, episode: (eps.find(e => e.kind === 'threat') ?? eps[0] ?? { id: '0'.repeat(16) }).id, bell: 56, weight: 8, answered: false }] : [],
      },
      revealed_reasons: reasons,
      budget: { messages_left: 3, reactions_left: 2, resting: false },
      stats: { decisions: grp.decisions ?? 0, valid: grp.valid ?? 0, actions_by_model: grp.actions_by_model ?? 0, actions_by_autopilot: grp.actions_by_autopilot ?? 0, model_marches: grp.model_marches ?? 0, model_marches_opened: reasons.length, messages: grp.messages ?? 0, strikes_declined: 0, decisions_citing_memory: grp.decisions_citing_memory ?? 0, mem_dropped: 0 },
      updated_bell: state.b,
    });
  }

  // departures and clashes, chronicle (SYNTHETIC rows in the shape the page reads)
  const tagOfWallet = w => BigInt.asUintN(64, citizenTag(withSeed(seasonAddress, seedOf('Citizen', { wallet: w }), roster.program_id))).toString(16).padStart(16, '0');
  const sTags = roster.script.wallets.slice(0, 2).map(tagOfWallet);
  writeJson(path.join(pub, 'events', 'latest.json'), { v: 1, bell: state.b, events: [
    { kind: 'depart', bell: 72, actor: ai1.tag, faction: 1, troops: 300, from: { p: -1, q: 3 }, arrive_bell: 74 },
    { kind: 'depart', bell: 71, actor: sTags[0], faction: 2, troops: 220, from: { p: 3, q: 0 }, arrive_bell: 73 },
    { kind: 'depart', bell: 70, actor: 'abcdef0123456789', faction: 3, troops: 180, from: { p: 0, q: -2 }, arrive_bell: 72 },
    { kind: 'clash', bell: 74, p: -1, q: 2, engagements: 1, lost: { 1: 36 }, actors: [ai1.tag, sTags[1]] },
  ] });
  writeJson(path.join(pub, 'chronicle', 'latest.json'), { lines: [
    { kind: 'ai_march_opened', bell: 75, actors: [ai1.tag], ai: [true], by: 'model', refs: [], text: { en: `${ai1.name.en} marched at (-1,2); its reason is published.`, ja: `${ai1.name.ja}が(-1,2)へ進軍した。理由は公開されている。` } },
    { kind: 'motion', bell: 73, actors: [ai0.tag], ai: [true], by: 'model', refs: [], text: { en: `${ai0.name.en} moved option 1 in nation Aster's council.`, ja: `${ai0.name.ja}が国アステルの評議会で選択肢1を動議した。` } },
    { kind: 'ai_joined', bell: 2, actors: [ai0.tag], ai: [true], refs: [], text: { en: `${ai0.name.en} joined (AI citizen).`, ja: `${ai0.name.ja}が参加した（AI市民）。` } },
  ] });

  // keys the page can import (a seat key file in the shape of --export-seat-key; the wallet key in it is a dummy)
  const seatKeyFile = path.join(work, 'keys', 'seat-key.json');
  const k = testKey('session/seat');
  writeJson(seatKeyFile, { index: roster.seat.index, wallet: seat.b58, wallet_keypair_b58: toBase58(crypto.randomBytes(64)), session: toBase58(k.pub), session_keypair_b58: toBase58(Buffer.concat([Buffer.from(k.seed), Buffer.from(k.pub)])) });

  const serve = createServe({ aiDir: work, herald: `http://127.0.0.1:${heraldBound}`, social: `http://127.0.0.1:${socialBound}`, port, pageDir: path.join(webDir, 'frontier') });
  await serve.listen();
  return {
    url: serve.url, port: serve.port, bell: state.b, scenario, seatKeyFile, work, pub, roster, social, ai0, ai1, seat, state,
    setBell(b) { state.b = b; },
    async stop() { await serve.close(); await socialListener.close(); await new Promise(r => heraldServer.close(r)); },
  };
}

// ------------------------------------------------------------------ command line
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const a = {};
  for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  const s = await startStage({ pubSrc: a['pub-src'], work: a.work, scenario: a.scenario ?? 'ballots', port: Number(a.port ?? 41902), heraldPort: Number(a["herald-port"] ?? 41993), socialPort: Number(a["social-port"] ?? 41997) });
  console.log(`stage: ${s.url}/council.html (scenario ${s.scenario}, bell ${s.bell}); seat key file ${s.seatKeyFile}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => s.stop().then(() => process.exit(0)));
}
