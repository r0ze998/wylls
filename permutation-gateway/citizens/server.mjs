#!/usr/bin/env node
// frontier-citizens: the keyless mind service (contract sections 1.1 P3, 1.3 C1, 8.4, 11.6). Run as
//   node --experimental-permission <flags from --print-permission-flags> permutation-gateway/citizens/server.mjs \
//        --herald http://127.0.0.1:41940 --llm http://127.0.0.1:41901 --mind-port 41980 --social-port 41981 \
//        --serve-port 41902 --ai-dir DIR --config permutation-gateway/citizens/config/main.json --run-id R
// It binds only 41901-41999 on loopback (mind API 41980, social API 41981, static server 41902) and holds
// no key: STATE/mind.token is the only secret it writes (a bearer token for the brain, mode 0600).
//
// Construction order (section 11.6): AC2 stores -> AC1a records -> AC6a feed -> AC4 social -> AC6 watcher
// -> AC1a views -> mind -> closer -> AC5 serve. The other units' modules are imported dynamically and a
// missing one is replaced by a loud stub (reported by GET /v1/health `stubs`), because the units are
// built in parallel and merged later. A run that is meant to be audited must report no stubs.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertServiceConfig, assertAiPort, configHash, GuardError } from './mind/guards.mjs';
import { createLlm } from './mind/llm.mjs';
import { createScheduler } from './mind/scheduler.mjs';
import { createGate } from './mind/gate.mjs';
import { createRecords } from './mind/records.mjs';
import { createMetrics } from './mind/metrics.mjs';
import { createSealedSets } from './mind/sealed.mjs';
import { createMemoryAttach } from './mind/memory.mjs';
import { createPromptRenderer } from './mind/prompt.mjs';
import { createViews, createRoster } from './mind/views.mjs';
import { createMind, createMindHttp } from './mind/api.mjs';
import { createClock, createCloser } from './mind/closer.mjs';
import { createSpeechStub } from './mind/speech-stub.mjs';
import { permissionFlags } from './mind/permissions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZERO32 = '0'.repeat(64);

async function tryImport(rel) {
  const p = join(HERE, rel);
  if (!existsSync(p)) return null;
  return import(pathToFileURL(p).href);
}

function atomicJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, path);
}

/** Stub social store for units built in parallel: no messages, no council, empty per-bell files. */
function stubSocial(pub) {
  return {
    stub: true,
    read: { council: () => null, inbox: () => [], hall: () => [] },
    memberCall: () => null,
    routes: null,
    async closeBell(b) {
      atomicJson(`${pub}/talk/${b}.json`, { bell: b, root: ZERO32, records: [] });
      return { root: ZERO32, file: `${pub}/talk/${b}.json` };
    },
    subscribe: () => {},
  };
}

/** Learn genesis_ts from the herald's SEASON_CREATED event (decoded payload), loopback only. */
async function discoverGenesis(heraldUrl, fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl(`${heraldUrl.replace(/\/+$/, '')}/h/events?limit=20`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json();
    const ev = (j.events ?? []).find((e) => e.decoded?.name === 'SEASON_CREATED');
    const ts = ev?.decoded?.payload?.genesis_ts;
    return ts != null ? Number(ts) : null;
  } catch {
    return null;
  }
}

/**
 * Build and start the service. `overrides` replaces any collaborator (tests, and the integrator's wiring):
 * {config, speech, stores, renderMemory, renderPersona, personaOf, nameOf, nationName, feed, social, watcher, serve,
 *  llm, clock, test: true (allows port 0 and any loopback llama port), genesisTs, fetch}.
 */
export async function createCitizensService(opts, overrides = {}) {
  const { aiDir, herald, llm: llmUrl, mindPort, socialPort, servePort, configPath, runId = 'run', season = 0 } = opts;
  const test = Boolean(overrides.test);
  const raw = overrides.config ? JSON.stringify(overrides.config) : readFileSync(configPath);
  const config = overrides.config ?? JSON.parse(raw);
  assertServiceConfig({ herald, llm: llmUrl, mindPort, socialPort, servePort, test });
  const STATE = `${aiDir}/state`;
  const PUB = `${aiDir}/pub`;
  for (const d of [STATE, PUB, `${PUB}/minds`, `${PUB}/talk`, `${PUB}/metrics`]) mkdirSync(d, { recursive: true });
  const stubs = [];
  const configSha = createHash('sha256').update(raw).digest('hex');

  // the committed config hash (section 7.1): refuse to run when the commitments name another config
  const commitPath = `${PUB}/commitments.json`;
  if (existsSync(commitPath)) {
    try {
      const c = JSON.parse(readFileSync(commitPath, 'utf8'));
      const want = c?.configs?.citizens_config_sha256;
      if (want && want !== configSha) throw new GuardError('ConfigMismatch', `config sha256 ${configSha} differs from the committed ${want}`);
    } catch (e) {
      if (e instanceof GuardError) throw e;
    }
  }

  // ---- collaborators ------------------------------------------------------------------------------
  let speech = overrides.speech ?? null;
  let speechStub = false;
  if (!speech) {
    const mod = await tryImport('mind/speech.mjs');
    if (mod?.createSpeech) speech = mod.createSpeech({ config });
    else if (config.allow_speech_stub || test) {
      speech = createSpeechStub();
      speechStub = true;
      stubs.push('speech');
    } else throw new GuardError('NoSpeech', 'mind/speech.mjs (AC1b) is missing: the service refuses to run without V5/V5b (set allow_speech_stub only for tests)');
  }
  const namesMod = overrides.nameOf ? null : await tryImport('persona/names.mjs');
  const nameOf = overrides.nameOf ?? namesMod?.nameOf ?? null;
  const nationName = overrides.nationName ?? ((f, lang) => namesMod?.nationName?.(f)?.[lang] ?? null);
  const renderMod = overrides.renderMemory ? null : await tryImport('memory/render.mjs');
  const renderMemory = overrides.renderMemory ?? renderMod?.renderMemory;
  if (!renderMemory) throw new GuardError('NoMemory', 'memory/render.mjs (AC2) is missing');
  const personaRender = overrides.renderPersona ? null : await tryImport('persona/render.mjs');
  const renderPersona = overrides.renderPersona ?? personaRender?.renderPersona ?? null;
  const dealMod = overrides.personaOf ? null : await tryImport('persona/deal.mjs');
  const personaOf = overrides.personaOf ?? dealMod?.personaOf ?? null;
  let stores = overrides.stores ?? null;
  if (!stores) {
    const mod = await tryImport('memory/store.mjs');
    if (!mod?.createMemoryStore) throw new GuardError('NoMemory', 'memory/store.mjs (AC2) is missing');
    stores = mod.createMemoryStore({ stateDir: STATE, pubDir: PUB });
  }

  const llm = overrides.llm ?? createLlm({ url: llmUrl, alias: config.llm?.alias });
  const clock = overrides.clock ?? createClock({ genesisTs: overrides.genesisTs ?? opts.genesisTs ?? null, scale: config.time?.scale ?? 10, bellSecs: config.time?.bell_secs ?? 600 });
  const metrics = createMetrics();
  const records = createRecords({ aiDir, runId, season });

  // roster: the registrar writes PUB/roster.json after genesis; the service starts before it
  let rosterCur = createRoster(null);
  const rosterPath = `${PUB}/roster.json`;
  const reloadRoster = () => {
    if (!existsSync(rosterPath)) return false;
    try {
      const j = JSON.parse(readFileSync(rosterPath, 'utf8'));
      if (j?.ai?.length && (!rosterCur.ready || rosterCur.ai.length !== j.ai.length)) {
        rosterCur = createRoster(j);
        return true;
      }
    } catch {
      /* half-written file: try again at the next poll */
    }
    return false;
  };
  reloadRoster();
  const roster = {
    get ready() { return rosterCur.ready; },
    get ai() { return rosterCur.ai; },
    byTag: (t) => rosterCur.byTag(t),
    byWallet: (w) => rosterCur.byWallet(w),
    byIndex: (i) => rosterCur.byIndex(i),
    isAi: (t) => rosterCur.isAi(t),
    isScript: (w) => rosterCur.isScript(w),
    get seat() { return rosterCur.seat; },
  };

  let feed = overrides.feed ?? null;
  if (!feed) {
    const mod = await tryImport('watcher/feed.mjs');
    if (mod?.createFeed) feed = mod.createFeed({ herald, roster, clock });
    else stubs.push('feed');
  }
  let social = overrides.social ?? null;
  if (!social) {
    for (const rel of ['social/index.mjs', 'social/routes.mjs']) {
      const mod = await tryImport(rel);
      if (mod?.createSocial) {
        social = mod.createSocial({ herald, aiDir: PUB, roster, clock, provenance: (id, item, type) => records.provenance(id, item, type), consume: (id, item, type) => records.consume(id, item, type) });
        break;
      }
    }
    if (!social) {
      social = stubSocial(PUB);
      stubs.push('social');
    }
  }
  let watcher = overrides.watcher ?? null;
  if (!watcher) {
    for (const rel of ['watcher/index.mjs', 'watcher/watcher.mjs']) {
      const mod = await tryImport(rel);
      if (mod?.createWatcher) {
        watcher = mod.createWatcher({ feed, social, ledgers: stores, records, aiDir: PUB, config });
        break;
      }
    }
    if (!watcher) {
      watcher = { stub: true, wakeEvents: () => [] };
      stubs.push('watcher');
    }
  }

  const sealed = createSealedSets({ stateDir: STATE });
  const scheduler = createScheduler({ seedMs: config.scheduler?.seed_ms ?? {}, window: config.scheduler?.window });
  const gate = createGate({ gate: config.gate, budgets: config.budgets });
  const memoryAttach = createMemoryAttach({ renderMemory, blockTokens: config.memory?.block_tokens ?? 750 });
  const prompt = createPromptRenderer({
    templatesDir: join(HERE, 'prompts'),
    countTokens: (t) => llm.countTokens(t),
    speech,
    renderPersona,
    nameOf,
    config: { memory_block_tokens: config.memory?.block_tokens ?? 750 },
  });
  const views = createViews({ social, feed, stores, roster, nameOf, clock, sealed, personaOf });
  const mind = createMind({ config, llm, scheduler, gate, records, views, sealed, memoryAttach, prompt, speech, clock, metrics, roster, stores, watcher, feed, season, stateDir: STATE, nameOf, nationName, speechStub });
  const closer = createCloser({
    clock, social, records, metrics,
    onClosed: (b) => {
      atomicJson(`${PUB}/metrics/latest.json`, mind.metrics());
    },
  });
  // restart: begin after the last bell whose minds file exists
  try {
    const { readdirSync } = await import('node:fs');
    const have = readdirSync(`${PUB}/minds`).map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
    if (have.length) closer.setNext(Math.max(...have) + 1);
  } catch {
    /* fresh run */
  }

  // ---- the bearer token and the HTTP servers -------------------------------------------------------
  const tokenPath = `${STATE}/mind.token`;
  let token;
  if (existsSync(tokenPath)) token = readFileSync(tokenPath, 'utf8').trim();
  else {
    token = randomBytes(32).toString('hex');
    writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      /* best effort */
    }
  }
  const mindHttp = createServer(createMindHttp(mind, { token }));
  const servers = [mindHttp];
  await new Promise((res, rej) => {
    mindHttp.once('error', rej);
    mindHttp.listen(mindPort, '127.0.0.1', res);
  });
  let socialHttp = null;
  const handler = typeof social.routes === 'function' ? social.routes : social.routes?.handle;
  if (handler) {
    socialHttp = createServer(handler);
    servers.push(socialHttp);
    await new Promise((res, rej) => {
      socialHttp.once('error', rej);
      socialHttp.listen(socialPort, '127.0.0.1', res);
    });
  }
  let serve = overrides.serve ?? null;
  if (!serve) {
    const mod = await tryImport('serve.mjs');
    if (mod?.createServe) serve = mod.createServe({ aiDir: PUB, herald, social: `http://127.0.0.1:${socialPort}`, port: servePort, pageDir: resolve(HERE, '../../permutation-server/web/frontier') });
    else stubs.push('serve');
  }
  if (serve?.listen) await serve.listen();
  if (feed?.start) await feed.start();
  watcher?.start?.();

  // ---- timers: roster poll, genesis discovery, bell closer --------------------------------------------------
  const timers = [];
  const poll = setInterval(() => {
    reloadRoster();
  }, 2000);
  poll.unref?.();
  timers.push(poll);
  const genesisTimer = setInterval(async () => {
    if (clock.genesis() != null) return;
    const ts = await discoverGenesis(herald, overrides.fetch);
    if (ts != null) clock.setGenesis(ts);
  }, 2000);
  genesisTimer.unref?.();
  timers.push(genesisTimer);
  if (!overrides.noCloserTimer) closer.startTimer(1000);

  return {
    mind, closer, records, roster, clock, stores, social, watcher, feed, metrics, scheduler, gate, token, tokenPath, stubs, configSha, speechStub,
    ports: { mind: mindHttp.address().port, social: socialHttp?.address()?.port ?? null },
    reloadRoster,
    async close() {
      closer.stopTimer();
      for (const t of timers) clearInterval(t);
      watcher?.stop?.();
      feed?.stop?.();
      await serve?.close?.();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
    },
  };
}

// ---- CLI ---------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (['print-permission-flags', 'probe-access'].includes(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(HERE, '../..');
  if (a['print-permission-flags']) {
    console.log(permissionFlags({ repoRoot, aiDir: resolve(a['ai-dir'] ?? '.local/frontier/ai/run') }).join(' '));
    process.exit(0);
  }
  const need = (k) => {
    if (!a[k]) {
      console.error(`frontier-citizens: --${k} is required`);
      process.exit(2);
    }
    return a[k];
  };
  try {
    const aiDir = resolve(need('ai-dir'));
    const svc = await createCitizensService({
      aiDir,
      herald: need('herald'),
      llm: a.llm ?? 'http://127.0.0.1:41901',
      mindPort: Number(a['mind-port'] ?? 41980),
      socialPort: Number(a['social-port'] ?? 41981),
      servePort: Number(a['serve-port'] ?? 41902),
      configPath: resolve(need('config')),
      runId: a['run-id'] ?? 'run',
      season: Number(a.season ?? 0),
      genesisTs: a['genesis-ts'] ? Number(a['genesis-ts']) : null,
    });
    console.log(JSON.stringify({ ok: true, ports: svc.ports, stubs: svc.stubs, config_sha256: svc.configSha, token_file: svc.tokenPath }));
    if (a['probe-access']) {
      // T-K2: under the permission flags, reading these must throw ERR_ACCESS_DENIED
      const targets = (a['probe-paths'] ?? '').split(',').filter(Boolean);
      const out = {};
      for (const p of targets) {
        try {
          readFileSync(p);
          out[p] = 'READ';
        } catch (e) {
          out[p] = e.code ?? 'ERR';
        }
      }
      console.log(JSON.stringify({ probe: out }));
      await svc.close();
      process.exit(0);
    }
    const stop = async () => {
      await svc.close();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (e) {
    console.error(`frontier-citizens: ${e.message}`);
    process.exit(e instanceof GuardError ? 3 : 1);
  }
}
