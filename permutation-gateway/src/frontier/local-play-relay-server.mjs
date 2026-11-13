// LOCAL-PLAY ONLY: the loopback HTTP listener of local-play-relay.mjs, meant
// to sit behind the herald's `/gw/*` (`frontier-herald … --relay 127.0.0.1:PORT`).
//
//   node permutation-gateway/src/frontier/local-play-relay-server.mjs --local-play \
//     --listen-port <41000-41999> --rpc http://127.0.0.1:<runner RPC> \
//     --program <[0x45;32] base58> --season <Season PDA> --wallet <player public key> \
//     --ruleset-hash <RULESET_HASH_V3 hex> --prepare-bin <abs path of frontier-experimental-expedition-depart-prepare> \
//     --cu-limit <n> --loaded-limit <n> [--preview-bin <abs path of frontier-original-expedition-preview>]
//     [--resident-bin <abs path of frontier-experimental-expedition-prepare>]
//     [--conquest-bin <abs path of the conquest prepare CLI>]   (refused at start while the dispatch kind is unpinned)
//
// Binds 127.0.0.1 only, answers loopback peers only, bodies ≤ 16 KiB of JSON.
// Holds no key. Prints one public line when listening.
import http from 'node:http';
import path from 'node:path';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createLocalPlayRelay, errorAnswer, LOCAL_PLAY_REFUSED_PORT, ROUTES } from './local-play-relay.mjs';
import { createLocalPlayReveal, REVEAL_ROUTES } from './local-play-reveal.mjs';
import { createLocalPlayPreview, ExpeditionPreviewError, LOCAL_PLAY_PREVIEW_ROUTE } from './local-play-preview.mjs';
import { createLocalPlayResident, ExpeditionPrepareError, RESIDENT_ROUTES } from './local-play-resident.mjs';
import { createLocalPlayConquest, ConquestPrepareError, CONQUEST_ROUTES } from './local-play-conquest.mjs';
import { CONQUEST_ORDERS_ROUTE } from './local-play-conquest-orders.mjs';
import { createLocalPlayAct, LocalActError, LOCAL_ACT_ROUTES } from './local-play-act.mjs';
import { createLocalPlayMarch, LocalMarchError, LOCAL_MARCH_ROUTES } from './local-play-march.mjs';

export const MAX_BODY = 16 * 1024;

const json = (res, status, body) => {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Past the limit nothing more is kept (bounded memory); the 413 is answered
    // when the request ends, so the client always receives it.
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(Object.assign(new Error('too large'), { status: 413, body: true }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400, body: true })); }
    });
    req.on('error', reject);
  });
}

/**
 * Serve `relay` on 127.0.0.1:`port` (0 only for tests). Resolves `{server, port, close}`.
 * `reveal` (local-play-reveal.mjs, over the same pins): its three routes are served beside the Depart ones; without
 * it they are not there (404), as before. `preview` (local-play-preview.mjs): the boundary card's read-only
 * `POST /f/expedition/preview`, likewise only when given; a client that goes away cancels its one-shot read, and
 * closing the listener closes it. `resident` (local-play-resident.mjs): the return's two player-signed steps
 * (prepare, submit, status), likewise only when given and closed with the listener.
 */
export function serveLocalPlayRelay(relay, port, { reveal = null, preview = null, resident = null, conquest = null, act = null, march = null } = {}) {
  if (port !== 0 && (!(port >= 41_000 && port <= 41_999) || port === LOCAL_PLAY_REFUSED_PORT)) throw new Error('listen port must be 41000-41999 and not 41970');
  const handlers = {
    [ROUTES.info]: async () => relay.info(),
    [ROUTES.prepare]: async (body, signal) => relay.prepare(body, { signal }),
    [ROUTES.submit]: async body => relay.submit(body),
    [ROUTES.status]: async body => relay.status(body),
    ...(reveal ? {
      [REVEAL_ROUTES.context]: async body => reveal.context(body),
      [REVEAL_ROUTES.submit]: async body => reveal.submit(body),
      [REVEAL_ROUTES.status]: async body => reveal.status(body),
    } : {}),
    ...(preview ? { [LOCAL_PLAY_PREVIEW_ROUTE]: async (body, signal) => preview.inspect(body, { signal }) } : {}),
    ...(resident ? {
      [RESIDENT_ROUTES.prepare]: async (body, signal) => resident.prepare(body, { signal }),
      [RESIDENT_ROUTES.submit]: async body => resident.submit(body),
      [RESIDENT_ROUTES.status]: async body => resident.status(body),
    } : {}),
    // (local-play-conquest.mjs: the one player-signed conquest step; only when given, and it cannot be built unpinned)
    ...(conquest ? {
      [CONQUEST_ROUTES.prepare]: async (body, signal) => conquest.prepare(body, { signal }),
      [CONQUEST_ROUTES.submit]: async body => conquest.submit(body),
      [CONQUEST_ROUTES.status]: async body => conquest.status(body),
      // (the read-only reservation read, local-play-conquest-orders.mjs: it exists only inside this conquest block, so
      //  it is closed exactly while the three routes above are; it signs and sends nothing)
      [CONQUEST_ORDERS_ROUTE]: async body => conquest.orders(body),
    } : {}),
    // (local-play-act.mjs: the six page-signed economy commands; only when given — without it these are 404, as before)
    ...(act ? {
      [LOCAL_ACT_ROUTES.context]: async body => act.context(body),
      [LOCAL_ACT_ROUTES.submit]: async body => act.submit(body),
      [LOCAL_ACT_ROUTES.status]: async body => act.status(body),
    } : {}),
    // (local-play-march.mjs: the ordinary march's one page-signed Depart; only when given — it is given ONLY for the test-only trial with a
    //  pinned instance (marchFromArgs). No Reveal route: the world's keeper reveals from the public round)
    ...(march ? {
      [LOCAL_MARCH_ROUTES.capability]: async body => march.capability(body),
      [LOCAL_MARCH_ROUTES.submit]: async body => march.submit(body),
      [LOCAL_MARCH_ROUTES.status]: async body => march.status(body),
    } : {}),
  };
  const server = http.createServer(async (req, res) => {
    const peer = req.socket.remoteAddress;
    if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') return json(res, 403, { error: 'loopback only', code: 'LocalPlayLoopbackOnly' });
    const key = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    const handle = handlers[key];
    if (!handle) return json(res, 404, { error: 'not found', code: 'NotFound' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      // A client that goes away before the answer: the response closes
      // without having ended. (A request body completing is not a disconnect.)
      const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      json(res, 200, await handle(body, ac.signal));
    } catch (e) {
      // (the preview's own errors carry their own status and code, and nothing of the binary's path or output)
      if (e instanceof ExpeditionPreviewError || e instanceof ExpeditionPrepareError || e instanceof ConquestPrepareError) return json(res, e.status, { error: e.message, code: e.code });
      // (the economy routes' own refusals: their status and code, and for a send the runner refused, its signature)
      if (e instanceof LocalActError || e instanceof LocalMarchError) return json(res, e.status, { error: e.message, code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
      // (only the body reader's own two errors: a route's refusal with the same status keeps its own code)
      if (e?.body === true && (e.status === 413 || e.status === 400)) return json(res, e.status, { error: e.message, code: e.status === 413 ? 'BodyTooLarge' : 'InvalidJson' });
      const a = errorAnswer(e); json(res, a.status, a.body);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise(r => { act?.close(); march?.close(); /* (first: a submit still inside an await must find the relay closed before it could send) */ relay.close(); preview?.close(); resident?.close(); conquest?.close(); server.close(() => r()); }) }));
  });
}

const FLAGS = { '--rpc': 'rpc', '--program': 'program', '--season': 'season', '--wallet': 'wallet', '--ruleset-hash': 'rulesetHash',
  '--prepare-bin': 'prepareBin', '--cu-limit': 'cuLimit', '--loaded-limit': 'loadedLimit', '--listen-port': 'port' };
const OPTIONAL = { '--preview-bin': 'previewBin', '--resident-bin': 'residentBin', '--conquest-bin': 'conquestBin', '--conquest-capability': 'conquestCapability',
  '--runner-instance': 'runnerInstance', '--economy': 'economy', '--march-trial': 'marchTrial' };
/** `--march-trial local-march-trial-v1` (TEST-ONLY; needs `--economy`): the march capability answers `trial: true`. */
export const MARCH_TRIAL_MODE = 'local-march-trial-v1';
/**
 * `--economy page-signed-v1` (optional; off unless given, in exactly these words): serve the three routes of the
 * page-signed economy commands (local-play-act.mjs: Join, PlaceHome, Harvest, Build, Train, Muster — the relay's one
 * wallet as fee payer and actor, the stated intent rebuilt and compared, the real accounts read, ONE send). Without
 * the flag the routes are not there (404), as before, and the page says "local play is reads only". Any other value
 * refuses the start. It needs no binary: the message is built by the page with the game's own builder and checked here.
 */
export const ECONOMY_MODE = 'page-signed-v1';
/**
 * `--runner-instance <64 lowercase hex>` (optional): the instance id of the ONE runner this relay serves, as that
 * runner stated it on its own metadata line and the launcher handed it on. With it, a sent transaction can be settled
 * as "did not take effect" by that very runner's own not-found past the message's validity (local-play-relay.mjs).
 * Without it — a runner that states none — everything works as before and nothing is ever settled that way. A value
 * that is not exactly 64 lowercase hex (or is all zeros) refuses the start: a wrong id is never ignored.
 */
export const RUNNER_INSTANCE_RE = /^[0-9a-f]{64}$/;
export const CONQUEST_CAPABILITY_MAX_BYTES = 4096;
/**
 * The world capability of this start (`--conquest-capability <absolute path>`): one small JSON object, read ONCE at
 * start. It is only read here; whether it is this relay's world is decided by createLocalPlayConquest
 * (`conquestCapabilityProblems` against the relay's own program, Season and runner), and it opens nothing while an
 * opening condition is not established. Throws on anything but a readable, bounded JSON object.
 */
/**
 * At most `limit + 1` bytes of a regular file, through ONE descriptor: the kind of file is asked of that descriptor
 * (not of the path, so nothing can be swapped between a check and the read), and the read itself stops at the bound,
 * however large the file is or grows. Throws when it is not a regular file or cannot be read.
 */
export function readBounded(file, limit) {
  const fd = openSync(file, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    for (;;) { const n = readSync(fd, buffer, size, buffer.length - size, null); if (n <= 0) break; size += n; if (size === buffer.length) break; }
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}
export function readConquestCapability(file, read = readBounded) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('--conquest-capability must be an absolute path');
  let bytes; try { bytes = read(file, CONQUEST_CAPABILITY_MAX_BYTES); } catch { throw new Error('--conquest-capability cannot be read'); }
  if (!(bytes?.length > 0) || bytes.length > CONQUEST_CAPABILITY_MAX_BYTES) throw new Error('--conquest-capability must be a small JSON file');
  let value; try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('--conquest-capability is not JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('--conquest-capability must be a JSON object');
  return value;
}
/** The command line: `--local-play` and each flag exactly once; `--preview-bin` and `--resident-bin` may each be left out (then that route is not served). */
export function parseArgs(argv) {
  const cfg = {}; let localPlay = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--local-play') { if (localPlay) throw new Error('--local-play twice'); localPlay = true; continue; }
    const k = FLAGS[argv[i]] ?? OPTIONAL[argv[i]];
    if (!k || i + 1 >= argv.length || Object.hasOwn(cfg, k)) throw new Error(`bad argument ${argv[i]}`);
    cfg[k] = argv[++i];
  }
  if (Object.values(FLAGS).some(k => !Object.hasOwn(cfg, k))) throw new Error('every flag is required: ' + Object.keys(FLAGS).join(' '));
  const port = Number(cfg.port); delete cfg.port;
  const previewBin = cfg.previewBin ?? null; delete cfg.previewBin;   // (apart from the relay's closed configuration)
  const residentBin = cfg.residentBin ?? null; delete cfg.residentBin;
  const conquestBin = cfg.conquestBin ?? null; delete cfg.conquestBin;
  const conquestCapability = cfg.conquestCapability ?? null; delete cfg.conquestCapability;
  // (a capability is the conquest route's and nothing else's: without the route it is refused, not ignored)
  if (conquestCapability !== null && conquestBin === null) throw new Error('--conquest-capability needs --conquest-bin');
  if (conquestCapability !== null && !path.isAbsolute(conquestCapability)) throw new Error('--conquest-capability must be an absolute path');
  const runnerInstance = cfg.runnerInstance ?? null; delete cfg.runnerInstance;   // (apart from the relay's closed configuration, like the binaries)
  if (runnerInstance !== null && (!RUNNER_INSTANCE_RE.test(runnerInstance) || /^0{64}$/.test(runnerInstance))) throw new Error('--runner-instance must be 64 lowercase hex');
  const economyWord = cfg.economy ?? null; delete cfg.economy;   // (apart from the relay's closed configuration)
  if (economyWord !== null && economyWord !== ECONOMY_MODE) throw new Error(`--economy must be ${ECONOMY_MODE}`);
  const trialWord = cfg.marchTrial ?? null; delete cfg.marchTrial;   // (apart from the relay's closed configuration)
  if (trialWord !== null && trialWord !== MARCH_TRIAL_MODE) throw new Error(`--march-trial must be ${MARCH_TRIAL_MODE}`);
  if (trialWord !== null && economyWord === null) throw new Error('--march-trial needs --economy');
  if (String(port) !== String(Number.parseInt(port, 10))) throw new Error('--listen-port');
  return { port, cfg: { localPlay, ...cfg }, previewBin, residentBin, conquestBin, conquestCapability, runnerInstance, economy: economyWord !== null, marchTrial: trialWord !== null };
}

/**
 * The economy routes of a start, from the parsed command line: none unless `--economy page-signed-v1` was given;
 * otherwise `createLocalPlayAct` over the relay's own configuration, with the one runner instance when there is one.
 * `create` is for tests.
 */
export function actFromArgs({ cfg, economy = false, runnerInstance = null }, { create = createLocalPlayAct } = {}) {
  if (economy !== true) return null;
  return create(runnerInstance === null ? { cfg } : { cfg, runnerInstance });
}

/**
 * The ordinary march's routes of a start: ONLY with `--economy page-signed-v1`, `--march-trial local-march-trial-v1` and
 * `--runner-instance`; never otherwise (default closed). `create` is for tests.
 */
export function marchFromArgs({ cfg, economy = false, runnerInstance = null, marchTrial = false }, { create = createLocalPlayMarch } = {}) {
  // DEFAULT CLOSED: the economy flag alone serves no march. Only the test-only trial word, with the economy routes and
  // a pinned runner instance, builds it (createLocalPlayMarch refuses anything less as well).
  if (economy !== true || marchTrial !== true || runnerInstance === null) return null;
  return create({ cfg, runnerInstance, trial: true });
}

/**
 * The conquest routes of a start, from the parsed command line: none without `--conquest-bin`; otherwise the
 * capability file is read once (when given) and handed, with the relay's own configuration, to
 * createLocalPlayConquest, which holds it to the relay's pins and to the opening conditions. Every failure throws:
 * a relay asked for the route does not start without it (fail closed), it never starts with a looser one.
 *
 * What a capability is: a statement the launcher wrote for THIS start from values it checked. It is not signed and
 * proves nothing by itself; that it is this start's is the launcher's responsibility. The relay only refuses one
 * that does not name its own program, Season and runner, and then serves nothing but that capability's city.
 */
export function conquestFromArgs({ cfg, conquestBin, conquestCapability, runnerInstance = null }, { read = readBounded, create = createLocalPlayConquest } = {}) {
  if (conquestBin === null || conquestBin === undefined) {
    if (conquestCapability !== null && conquestCapability !== undefined) throw new Error('--conquest-capability needs --conquest-bin');
    return null;
  }
  const capability = conquestCapability === null || conquestCapability === undefined ? null : readConquestCapability(conquestCapability, read);
  // (the runner instance is handed on only when one was given: the call is the same as before for a runner that states none)
  return create(runnerInstance === null ? { cfg, conquestBin, capability } : { cfg, conquestBin, capability, runnerInstance });
}

/**
 * The relays of a start, from the parsed command line: the depart relay, the resident (return) relay when its binary
 * was given, and the conquest routes (`conquestFromArgs`). The ONE runner instance of the command line, when there is
 * one, goes to all three alike — they send to the same runner. `make` is for tests.
 */
export function relaysFromArgs({ cfg, residentBin = null, conquestBin = null, conquestCapability = null, runnerInstance = null },
  { relay = createLocalPlayRelay, resident = createLocalPlayResident, conquest = conquestFromArgs } = {}) {
  const pinned = runnerInstance === null ? {} : { runnerInstance };
  return { relay: relay({ cfg, ...pinned }), resident: residentBin === null ? null : resident({ cfg, residentBin, ...pinned }),
    conquest: conquest({ cfg, conquestBin, conquestCapability, runnerInstance }) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { port, cfg, previewBin, residentBin, conquestBin, conquestCapability, runnerInstance, economy, marchTrial } = parseArgs(process.argv.slice(2));
    // (the three relays that SEND: depart, resident, conquest — with the one runner instance when the command line
    //  gives one. The conquest routes throw while an opening condition is not established: asking does not open them)
    const { relay, resident, conquest } = relaysFromArgs({ cfg, residentBin, conquestBin, conquestCapability, runnerInstance });
    // (the Reveal routes over the same pins: the same wallet, program, Season and loopback runner)
    const reveal = createLocalPlayReveal({ cfg });
    const preview = previewBin === null ? null : createLocalPlayPreview({ cfg, previewBin });
    // (the page-signed economy commands: only when the command line asks for them in words)
    const act = actFromArgs({ cfg, economy, runnerInstance });
    const march = marchFromArgs({ cfg, economy, runnerInstance, marchTrial });
    const s = await serveLocalPlayRelay(relay, port, { reveal, preview, resident, conquest, act, march });
    console.log(JSON.stringify({ schema: 'frontier-local-play-relay-v1', listen: `127.0.0.1:${s.port}`, ...relay.info() }));
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (e) {
    console.error('local-play relay: ' + e.message);
    process.exit(2);
  }
}
