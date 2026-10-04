// Test doubles for the AC1a (mind core) tests. Nothing here is shipped code: it stands in for the units
// built in parallel (AC2 memory stores and renderers, AC4 social, AC6a feed, AC6 watcher, AC1b speech) with
// exactly the shapes AC1a assumes of them (listed in docs/frontier/ai-citizens/AC1a-NOTES.md). The integrator
// swaps the real modules in at merge. A fake llama-server (loopback, port 0) replaces Gemma in every test.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRoster } from '../../citizens/mind/views.mjs';

const HERE = new URL('.', import.meta.url);
export const sha = (s) => createHash('sha256').update(s).digest('hex');

/** The golden wire fixture of AC3a if it is in this tree, else the copy this unit keeps (and says which). */
export function loadWireFixture() {
  const real = new URL('ai-decide-v1.json', HERE);
  const copy = new URL('ai-mind-wire-copy.json', HERE);
  if (existsSync(real)) return { json: JSON.parse(readFileSync(real, 'utf8')), source: 'ai-decide-v1.json' };
  return { json: JSON.parse(readFileSync(copy, 'utf8')), source: 'ai-mind-wire-copy.json (copied from AC3a 55644a9)' };
}

export const TAGS = ['1885b43b654f032b', 'aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2', 'bbbbbbbbbbbbbbb1'];
export const WALLETS = ['3o5WUkVnvhBWMTpFJy8kbQUfNgAiAbuCBfHVppSugxAb', 'W2', 'W3', 'W4'];

export function makeRosterJson({ n = 3 } = {}) {
  const ai = [];
  for (let i = 0; i < n; i++) {
    ai.push({
      index: 3 + i,
      wallet: WALLETS[i],
      tag: TAGS[i],
      faction: i === 2 ? 1 : 0,
      persona: i === 0 ? 'conqueror' : 'avenger',
      ambition: { en: 'Conqueror', ja: '征服者' },
      creed_variant: 0,
      temperament: { aggression: 80, loyalty: 50, ambition: 85, honesty: 55, risk: 70, sociability: 40, grudge: 60 },
      name: { en: `Ai${i}`, ja: `エーアイ${i}` },
      kind: 'ai',
      label: 'AI citizen, Gemma 4 local',
    });
  }
  return { v: 1, ai, script: { first_index: 0, count: 5, wallets: ['S1', 'S2'], kind: 'script' }, seat: { index: 99, wallet: 'SEAT', kind: 'seat' } };
}
export const makeRoster = (opts) => createRoster(makeRosterJson(opts));

// ---- AC2 double: Ledger object, Episodes, stores, renderMemory, renderPersona -------------------------------------
export class LedgerDouble {
  constructor(tag, goals = []) {
    this.s = {
      v: 2, tag, day: 0,
      goals: goals.map((g) => ({ id: g.id, progress: 0, status: 'active', since_bell: 0, memory: !!g.memory })),
      trust: { citizens: {}, nations: {} }, commitments: [], grievances: [], standing: { reserved: [], declined_calls: [] },
      day_start: { bell: 0, home_troops: 0, march_troops_model: 0 }, seq: { talk: 0, ballot: 0 }, cursor: { event_seq: '0', bell: 0 },
      counters: { day: 0, sessions: 0, reactions: 0, messages: 0, marches: 0 },
    };
    this.modelDeltas = [];
  }
  snapshot() { return JSON.parse(JSON.stringify(this.s)); }
  nextSeq(type, bell) {
    const last = this.s.seq[type] ?? 0;
    const base = bell * 16;
    const next = last >= base ? last + 1 : base;
    this.s.seq[type] = next;
    return next;
  }
  applyModelDeltas(list, { bell = 0 } = {}) {
    for (const d of list) {
      this.modelDeltas.push({ ...d, bell });
      const key = String(d.who);
      const e = key.startsWith('nation:') ? (this.s.trust.nations[key.slice(7)] ??= { t_code: 0, t_model: 0 }) : (this.s.trust.citizens[key] ??= { t_code: 0, t_model: 0, episodes: [] });
      e.t_model += d.delta;
    }
    return [];
  }
}
export class EpisodesDouble {
  constructor(list = []) { this.byId = new Map(list.map((e) => [e.id, e])); }
  get(id) { return this.byId.get(id) ?? null; }
  list() { return [...this.byId.values()]; }
  add(e) { this.byId.set(e.id, e); }
}
export function makeEpisode(i, over = {}) {
  return { v: 1, id: `ep${String(i).padStart(14, '0')}`, bell: 10 * i, created_bell: 10 * i + 1, kind: 'camp_taken_by', entities: ['pq:1,1', 'nation:3'], text: { en: `At bell ${10 * i} nation 3 cleared the camp at (1,1) first.`, ja: `鐘${10 * i}で、国3が(1,1)の野営地を先に倒した。` }, importance: 5, src: [], ...over };
}
export function makeStores({ episodes = [], goals = [] } = {}) {
  const ledgers = new Map();
  const eps = new Map();
  const saved = [];
  return {
    saved,
    ledger(tag, init) {
      if (!ledgers.has(tag)) ledgers.set(tag, new LedgerDouble(tag, init?.goals ?? goals));
      return ledgers.get(tag);
    },
    episodes(tag) {
      if (!eps.has(tag)) eps.set(tag, new EpisodesDouble(episodes));
      return eps.get(tag);
    },
    summary: { latest: () => null },
    save(tag) { saved.push(tag); },
  };
}
/** renderMemory double: the 8 newest episodes whose entities meet the focus (or the 3 newest), oldest first, with handles M1..Mk. */
export function renderMemoryDouble(ownState, focus, budget = {}) {
  const f = new Set(focus);
  const all = ownState.episodes.list().filter((e) => e.created_bell < ownState.bell);
  let hit = all.filter((e) => e.entities.some((x) => f.has(x)));
  const newest = [...all].sort((a, b) => b.bell - a.bell).slice(0, 3);
  hit = [...new Map([...hit, ...newest].map((e) => [e.id, e])).values()].sort((a, b) => a.bell - b.bell).slice(-8);
  const limit = budget.tokens ?? 750;
  while (hit.length > 3 && Math.ceil(hit.map((e) => e.text.en).join('\n').length / 3) > limit) hit = hit.slice(1);
  const handles = {};
  const lines = ['MEMORY', 'Remembered:'];
  hit.forEach((e, i) => {
    handles[`M${i + 1}`] = e.id;
    lines.push(`M${i + 1} [bell ${e.bell}] <memory kind="episode" id="M${i + 1}">${e.text.en}</memory>`);
  });
  if (!hit.length) lines.push('(nothing remembered yet)');
  return { block: lines.join('\n'), handles, ids: hit.map((e) => e.id), tokens: Math.ceil(lines.join('\n').length / 3) };
}
export const renderPersonaDouble = (persona) => `You are an AI citizen. Ambition: ${persona?.ambition?.en ?? 'none'}. Goals: G1 keep two armies.`;
export const personaOfDouble = (entry) => ({ id: entry.persona, ambition: entry.ambition, temperament: entry.temperament, creed: { en: 'c', ja: 'c' }, goals: [{ id: 'G1', text: { en: 'a', ja: 'a' }, memory: false }, { id: 'G2', text: { en: 'b', ja: 'b' }, memory: true }] });
export const nameOfDouble = (tag) => ({ en: `Citizen${String(tag).slice(0, 4)}`, ja: `市民${String(tag).slice(0, 4)}` });

// ---- AC4 social double ---------------------------------------------------------------------------------------------
export function makeSocial({ council = null, inbox = [], hall = [], call = null } = {}) {
  const closed = [];
  const s = {
    read: { council: () => council, inbox: () => inbox, hall: () => hall },
    memberCall: () => call,
    closed,
    async closeBell(b) { closed.push(b); return { root: '0'.repeat(64), file: `talk/${b}.json` }; },
    set(patch) { Object.assign(s, patch); },
  };
  return s;
}

// ---- AC1b speech double: permissive unless told otherwise -------------------------------------------------------------
export function makeSpeech({ refuse = () => null } = {}) {
  return {
    stub: false,
    sanitize: (t) => String(t),
    checkSay: (text, ctx) => { const r = refuse('say', text, ctx); return r ? { ok: false, reason: r } : { ok: true, text }; },
    checkWhy: (text, ctx) => { const r = refuse('why', text, ctx); return r ? { ok: false, reason: r } : { ok: true, text }; },
  };
}

// ---- fake llama-server -------------------------------------------------------------------------------------------------
/**
 * Loopback server on port 0 speaking the slice of llama-server the mind uses. `respond(body, n)` returns the JSON
 * object the model "writes" (or {raw: string, finish_reason?}). Records every request body in `bodies`.
 */
export async function startFakeLlama({ respond, delayMs = 0, tokens = (t) => Math.ceil(t.length / 3) } = {}) {
  const bodies = [];
  let n = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = req.url;
      const text = Buffer.concat(chunks).toString('utf8');
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url === '/health') return send(200, { status: 'ok' });
      if (url === '/props') return send(200, { model_alias: 'gemma-4-26b-a4b-it' });
      if (url === '/tokenize') {
        const c = JSON.parse(text).content;
        return send(200, { tokens: Array.from({ length: tokens(c) }, (_, i) => i) });
      }
      if (url === '/v1/chat/completions') {
        const body = JSON.parse(text);
        bodies.push(body);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const out = respond(body, n++);
        if (out === 'http500') return send(500, { error: 'boom' });
        const content = out.raw ?? JSON.stringify(out);
        return send(200, { choices: [{ index: 0, finish_reason: out.finish_reason ?? 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: Math.ceil(text.length / 3), completion_tokens: Math.ceil(content.length / 3) }, timings: { prompt_ms: 10, predicted_per_second: 80 }, system_fingerprint: 'fake' });
      }
      send(404, { error: 'nf' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, port, bodies, close: () => new Promise((r) => server.close(() => r())) };
}

/** Build a model answer for a session request body: pick candidate ids by kind, empty social, one memory handle if offered. */
export function sessionAnswer(body, { kinds = ['march'], mem = true, why = 'To meet goal G1 I send the army.', say = [] } = {}) {
  const schema = body.response_format.json_schema.schema;
  const ids = schema.properties.choose.items?.enum ?? [];
  const user = body.messages[1].content;
  const lines = user.split('\n').filter((l) => /^c\d+ \[/.test(l));
  const chosen = [];
  for (const k of kinds) {
    const l = lines.find((x) => new RegExp(`^c\\d+ \\[${k}`).test(x));
    if (l) chosen.push(l.split(' ')[0]);
  }
  const choose = chosen.length ? chosen : [ids[0]];
  const params = {};
  for (const id of choose) {
    const p = schema.properties.params.properties[id];
    if (p) params[id] = Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, v.enum[0]]));
  }
  const handles = schema.properties.mem.items?.enum ?? [];
  return { goal_id: 'G1', choose, params, say, council: null, trust: [], mem: mem && handles.length ? [handles[0]] : [], why };
}

// ---- the whole mind on doubles -----------------------------------------------------------------------------------------
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlm } from '../../citizens/mind/llm.mjs';
import { createScheduler } from '../../citizens/mind/scheduler.mjs';
import { createGate } from '../../citizens/mind/gate.mjs';
import { createRecords } from '../../citizens/mind/records.mjs';
import { createMetrics } from '../../citizens/mind/metrics.mjs';
import { createSealedSets } from '../../citizens/mind/sealed.mjs';
import { createMemoryAttach } from '../../citizens/mind/memory.mjs';
import { createPromptRenderer } from '../../citizens/mind/prompt.mjs';
import { createViews } from '../../citizens/mind/views.mjs';
import { createMind } from '../../citizens/mind/api.mjs';
import { createClock } from '../../citizens/mind/closer.mjs';

export const CONFIG = JSON.parse(readFileSync(new URL('../../citizens/config/ab.json', import.meta.url), 'utf8'));

/** Build a mind over the doubles. Returns everything a test wants to poke. `respond(body, n)` is the fake model. */
export async function makeMindHarness({ respond, social = makeSocial(), stores = null, speech = makeSpeech(), watcher = null, feed = null, config = CONFIG, rosterN = 3, seeds = null, delayMs = 0, episodes = null } = {}) {
  const llama = await startFakeLlama({ respond, delayMs });
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-mind-'));
  const roster = makeRoster({ n: rosterN });
  const st = stores ?? makeStores({ episodes: episodes ?? [makeEpisode(1), makeEpisode(2), makeEpisode(3)] });
  const metrics = createMetrics();
  const records = createRecords({ aiDir, runId: 't', season: 31 });
  const llm = createLlm({ url: llama.url });
  const scheduler = createScheduler({ seedMs: seeds ?? { session: { p50: 5, p90: 10 }, reaction: { p50: 5, p90: 10 }, motion: { p50: 5, p90: 10 }, ballot: { p50: 5, p90: 10 }, reflection: { p50: 5, p90: 10 } } });
  const gate = createGate({ gate: config.gate, budgets: config.budgets });
  const sealed = createSealedSets({ stateDir: `${aiDir}/state` });
  const clock = createClock({ genesisTs: 1800000000, scale: 1 });
  const memoryAttach = createMemoryAttach({ renderMemory: renderMemoryDouble, blockTokens: 750 });
  const prompt = createPromptRenderer({ templatesDir: new URL('../../citizens/prompts', import.meta.url).pathname, countTokens: (t) => llm.countTokens(t), speech, renderPersona: renderPersonaDouble, nameOf: nameOfDouble, config: { memory_block_tokens: 750 } });
  const views = createViews({ social, feed, stores: st, roster, nameOf: nameOfDouble, clock, sealed, personaOf: personaOfDouble });
  const mind = createMind({ config: { ...config, channel_lang: 'en' }, llm, scheduler, gate, records, views, sealed, memoryAttach, prompt, speech, clock, metrics, roster, stores: st, watcher, feed, season: 31, stateDir: `${aiDir}/state`, nameOf: nameOfDouble, nationName: (f) => `Nation${f}` });
  return { mind, llama, aiDir, roster, stores: st, records, metrics, scheduler, gate, sealed, clock, social, llm, views, async close() { await llama.close(); } };
}
