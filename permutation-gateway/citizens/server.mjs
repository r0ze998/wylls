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
import { sanitize as mindSanitize } from './mind/sanitize.mjs';
import { permissionFlags } from './mind/permissions.mjs';
import { createUpkeep } from './mind/upkeep.mjs';
import { feedView, createWaveAWatcher, createEpisodePump, socialReadViews, socialEpisodeSource, socialClock, provenanceOf } from './mind/wiring.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZERO32 = '0'.repeat(64);

async function tryImport(rel) {
  const p = join(HERE, rel);
  // under the permission model existsSync throws (not false) for a path outside the read list: a unit not merged yet
  // has no directory in the list, so a denied probe means "not there"
  try {
    if (!existsSync(p)) return null;
  } catch {
    return null;
  }
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
 *  llm, clock, socialHerald (a `me(wallet)` client for the real social store, tests), speechModule (path under citizens/ of the speech module, for tests), test: true (allows port 0 and any
 *  loopback llama port), noCloserTimer, genesisTs, fetch}.
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
  // integ-A: AC1b's mind/speech.mjs is merged and the labelled stub (mind/speech-stub.mjs) is deleted (A.5 grep): the service
  // refuses to run without V5/V5b
  let speech = overrides.speech ?? null;
  if (!speech) {
    const mod = await tryImport(overrides.speechModule ?? 'mind/speech.mjs');
    if (mod?.createSpeech) speech = mod.createSpeech({ config });
    else throw new GuardError('NoSpeech', 'mind/speech.mjs (AC1b) is missing: the service refuses to run without V5/V5b');
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
  let rosterJsonCur = null;
  const rosterPath = `${PUB}/roster.json`;
  const reloadRoster = () => {
    if (!existsSync(rosterPath)) return false;
    try {
      const j = JSON.parse(readFileSync(rosterPath, 'utf8'));
      if (j?.ai?.length && (!rosterCur.ready || rosterCur.ai.length !== j.ai.length)) {
        rosterCur = createRoster(j);
        rosterJsonCur = j;
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
  let watcher = overrides.watcher ?? null; // AC6: built after the social store; the store's fixCall reaches it through this binding
  const EMPTY_ROSTER = { ai: [], script: { wallets: [] }, seat: null };
  if (!social) {
    // integ-A: AC4's real store (the slice ran on a stub). aiDir is AI_DIR (the store writes pub/talk, pub/council and
    // state/social itself); the roster is the registrar's roster.json as read above (the same object until it changes);
    // provenance is AC1a's records (AC4 asks for the mind's signed-ready output of a decision); the sanitiser is AC1b's
    // (one sanitiser for the mind, the store and the page); the season is the stack's (the run script passes --season)
    const mod = await tryImport('social/routes.mjs');
    if (mod?.createSocial) {
      social = mod.createSocial({
        herald: overrides.socialHerald ?? herald, aiDir, roster: () => rosterJsonCur ?? EMPTY_ROSTER, clock: socialClock(clock), provenance: provenanceOf(records), sanitize: mindSanitize, config: config.council ?? {}, season,
        // AC6 (section 6.5 step 6): the tile and the invited hosts of an adopted Strike Order are the watcher's (it reads the herald files of bell C0 + 5)
        fixCall: (a) => (watcher?.closeCall ? watcher.closeCall(a) : null),
      });
      social.read = socialReadViews({ book: social.book, council: social.council, pubDir: PUB, roster });
    } else {
      social = stubSocial(PUB);
      stubs.push('social');
    }
  }
  if (!watcher) {
    // AC6 (wave B): the real watcher (wakes, councils, Strike Order, release job, chronicle, cards, events). It is built behind the
    // pinned createWatcher interface of 11.6 with a few extra collaborators; `aiDir` is AI_DIR (it writes AI_DIR/pub and AI_DIR/state/watcher).
    // Without a feed there is nothing to watch: the wave-A stub (feed wakes only) stays, reported in `stubs`.
    for (const rel of ['watcher/index.mjs', 'watcher/watcher.mjs']) {
      if (!feed) break;
      const mod = await tryImport(rel);
      if (mod?.createWatcher) {
        watcher = mod.createWatcher({
          feed, social, ledgers: stores, records, aiDir, config, clock, roster, nameOf: nameOf ?? undefined, personaOf: personaOf ?? undefined, // nation names: the watcher reads persona/names.mjs itself ({en, ja}; the mind's nationName here is a two-argument helper)
          onError: (e, where) => console.error(`watcher ${where ?? ''}:`, String(e?.message ?? e)),
        });
        break;
      }
    }
    if (!watcher) {
      watcher = createWaveAWatcher({ feed });
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
  // integ-A: AC1a reads feed.cursorBell() and feed.revealed(); AC6a's feed offers completeThrough() and revealOf(); the
  // episode pump (feed -> episodes_from_events -> AC2 stores) is the 11.6 wiring `server.mjs` owns
  let pump = null;
  const feedForMind = feed && !overrides.feed ? feedView(feed, { throughBell: () => (pump ? pump.throughBell() : -1), tick: () => pump?.tick() }) : feed;
  // AC6: a Strike Order is "live" from the close until S + 2 (sections 5.6, 7.2). AC4's `memberCall` keeps answering after the opening
  // (`opened: true`); the views must not treat it as live then, or every decision (and every `say`) of its nation would stay sealed until the
  // next period replaces it. Only the member view changes; everything else of the social store is passed through.
  const socialForViews = typeof social.memberCall === 'function'
    ? { ...social, memberCall: (f, period) => { const c = social.memberCall(f, period); return c && !c.opened ? c : null; } }
    : social;
  const views = createViews({ social: socialForViews, feed: feedForMind, stores, roster, nameOf, clock, sealed, personaOf });
  pump = feed && !overrides.feed && feed.prepare ? createEpisodePump({ feed, stores, views, roster, clock, config: { redactions: [] }, social: social?.book && social?.council ? socialEpisodeSource({ book: social.book, council: social.council, pubDir: PUB }) : null, onError: (e) => console.error('episode pump:', String(e?.message ?? e)) }) : null;
  const upkeep = createUpkeep({ roster, onError: (e) => console.error('memory upkeep:', String(e?.message ?? e)) });
  const mind = createMind({ config, llm, scheduler, gate, records, views, sealed, memoryAttach, prompt, speech, clock, metrics, roster, stores, watcher, upkeep, feed: feedForMind, season, stateDir: STATE, nameOf, nationName });
  // AC6: the watcher drives the council calls through the mind and reads its events; the output of a council call reaches the brain with
  // the AI's next decide answer (watcher/outbox.mjs, AC6-NOTES.md deviation 2)
  watcher.attachMind?.(mind);
  if (typeof watcher.decorateAnswer === 'function') {
    const decideBase = mind.decide;
    mind.decide = async (body) => watcher.decorateAnswer(body, await decideBase(body));
  }
  // integ-A: AC1b's reflection job (section 5.3, the first memory feature to drop: config.memory.reflection false turns it off).
  // It subscribes to the mind's `reflect_due` event; without this call no reflection runs.
  const reflMod = overrides.reflection === false ? null : await tryImport('mind/reflection.mjs');
  const reflection = reflMod?.createReflection
    ? reflMod.createReflection({ mind, prompt, stores, views, speech, metrics, records, clock, roster, config, renderPersona, nameOf, nationName, sealed, season, stateDir: STATE })
    : null;
  if (!reflection && config.memory?.reflection !== false) stubs.push('reflection');
  // integ-B: AC8's season-end publication. The registrar's `publish` writes STATE/season-end.json; this watcher then writes PUB/full/**
  // (requests, decisions, openings of the records whose release did not happen, social provenance, ledgers) once. `reveals` is the feed's
  // public REVEAL reader (destinations of an opening come from the chain's public rows only); `sanitize` is the mind's (redaction needles).
  const auditMod = overrides.audit === false ? null : await tryImport('audit/season_end.mjs');
  const audit = auditMod?.createAudit
    ? auditMod.createAudit({ aiDir, reveals: feed?.revealOf ? (h, a) => feed.revealOf(h, a) : null, sanitize: mindSanitize, log: (m) => console.error(`audit: ${m}`) })
    : null;
  if (!audit && overrides.audit !== false) stubs.push('audit');
  // diagnostics for the slice gate and the run: what the feed and the episode pump have done (counts only)
  const baseHealth = mind.health;
  mind.health = async () => ({
    ...(await baseHealth()),
    feed: feed?.stats ? { ...feed.stats, head_bell: feed.headBell?.(), complete_through: feed.completeThrough?.(), cursor: feed.cursor?.() } : null,
    pump: pump ? { ...pump.stats, through_bell: pump.throughBell(), published: pump.published().length } : null,
    watcher: watcher?.stats ? watcher.stats() : null,
  });
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
    // integ-A: createServe takes AI_DIR and appends /pub itself (the slice runs passed PUB and served AI_DIR/pub/pub: an empty /h/ai/)
    if (mod?.createServe) {
      serve = mod.createServe({
        aiDir, herald, social: `http://127.0.0.1:${socialHttp?.address()?.port ?? socialPort}`, port: servePort, pageDir: resolve(HERE, '../../permutation-server/web/frontier'),
      });
    } else stubs.push('serve');
  }
  if (serve?.listen) await serve.listen();
  if (feed?.start) await feed.start();
  watcher?.start?.();
  reflection?.start?.();
  const stopAuditWatch = audit?.watch ? audit.watch({ pollMs: config.audit?.poll_ms ?? 2000 }) : null;

  // ---- timers: roster poll, genesis discovery, bell closer --------------------------------------------------
  const timers = [];
  const poll = setInterval(() => {
    reloadRoster();
    if (rosterJsonCur && feed?.setRoster && !overrides.feed) feed.setRoster(rosterJsonCur);
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
  if (pump) {
    const pumpTimer = setInterval(() => { pump.tick(); }, 1000);
    pumpTimer.unref?.();
    timers.push(pumpTimer);
  }
  if (!overrides.noCloserTimer) closer.startTimer(1000);

  return {
    mind, closer, records, roster, clock, stores, social, watcher, feed, pump, reflection, audit, serve, metrics, scheduler, gate, token, tokenPath, stubs, configSha,
    ports: { mind: mindHttp.address().port, social: socialHttp?.address()?.port ?? null },
    reloadRoster,
    async close() {
      closer.stopTimer();
      for (const t of timers) clearInterval(t);
      stopAuditWatch?.();
      reflection?.stop?.();
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
    const eq = a.indexOf('=');
    if (eq > 0) {
      o[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    if (['print-permission-flags', 'probe-access', 'probe-only'].includes(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(HERE, '../..');
  if (a['print-permission-flags']) {
    console.log(permissionFlags({ repoRoot, aiDir: resolve(a['ai-dir'] ?? '.local/frontier/ai/run') }).join('\n'));
    process.exit(0);
  }
  if (a['probe-only']) {
    // T-K2: this process was started under the permission flags and has loaded the whole static import graph of
    // this file; reading the listed paths must now throw ERR_ACCESS_DENIED (a path inside the read list reads fine)
    const out = {};
    for (const p of (a['probe-paths'] ?? '').split(',').filter(Boolean)) {
      try {
        readFileSync(p);
        out[p] = 'READ';
      } catch (e) {
        out[p] = e.code ?? 'ERR';
      }
    }
    console.log(JSON.stringify({ probe: out }));
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
    if (process.env.CITIZENS_DEBUG) console.error(e.stack);
    process.exit(e instanceof GuardError ? 3 : 1);
  }
}
