// Local play, an explicit opt-in of the game page: `?localPlay=1` on a loopback host, play mode only.
//
// Why a gate before the page boots: the local runner is started WITH the player's public address, and only then does
// its herald hold that player's accounts. So the page first makes its memory-only test wallet
// (fephemeral-wallet.mjs), shows the PUBLIC address, and waits. The operator starts the runner and herald for that
// address and presses Connect in this same open page (a reload or another URL would lose the wallet). The explicit
// launcher=1 gate starts that local world through the same-origin launcher on a button press; the worlds the
// launcher runs are listed (public addresses) when it refuses a start at its limit of two, or when the player asks
// with the panel's own key, and ending one is the player's own two presses on that world's row: nothing here stops
// a world, or asks anything of the launcher, by itself. A launcher's answer may also say that its world is a conquest
// world (`conquestWorld`): it is kept only when it names the dedicated program and the very Season this page then
// verifies, and is handed to the page on the identity (`cfg.localPlay.conquestWorld`, which the controller makes
// `FS.localPlay`); anything less is no conquest world to this page. Connect reads
// the herald's own records and goes on only when they are the dedicated local program's, on localnet, of the
// host-only dispatch revision, and name this wallet's Citizen. Anything else is said as it is and may be tried again,
// with the same wallet. The ordinary boot then runs once, against that herald.
//
// Scope: wallet → the real player's READS. While local play is on the controller sends nothing (no Join, SetSession,
// payment or order), restores and stores no session key, and the dev wallet stays off. Nothing here stores a secret.
import { createEphemeralWallet, isLoopbackHost, EPHEMERAL_WALLET_NAME } from './fephemeral-wallet.mjs';
import { encode as toBase58, decode as fromBase58 } from '../sdk/base58.mjs';
import { seasonAddresses } from './faddr.mjs';
import { L, onLangChange, mountLangToggle } from '../lang.mjs';
import { mountSessionNotice, pairGuideView } from './flocalplay-session.mjs';
import { confirmWorldEnd } from './flocalplay-instance.mjs';

/** The dedicated localnet program of the `localnet-expedition-sbf` build ([0x45; 32]). */
export const LOCAL_PLAY_PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
/** S1 | wide 0x4000 | host-only dispatch 0x0800. */
export const LOCAL_PLAY_PROGRAM_VERSION = 0x4804;
export const LOCAL_PLAY_CLUSTER = 'localnet';
export { EPHEMERAL_WALLET_NAME };

/** Whether this page was opened for local play: play mode, a loopback page, and exactly `localPlay=1`. */
export function localPlayRequested(cfg, loc = globalThis.location) {
  if (cfg?.mode !== 'play' || cfg.dev !== true || !isLoopbackHost(loc?.hostname)) return false;
  try { return new URL(loc.href).searchParams.get('localPlay') === '1'; } catch { return false; }
}

/** The optional self-start launcher is never enabled by a remote page or by local play alone. */
export function localLauncherRequested(cfg, loc = globalThis.location) {
  try { const u = new URL(loc.href); return localPlayRequested(cfg, loc) && u.searchParams.get('launcher') === '1' && (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { return false; }
}
/**
 * Whether the launcher that served this page prepares its worlds with the clock run faster (its `--prepare-scale`).
 * The launcher puts `prepare=accelerated` on every launcher page it serves, and sends a launcher page asked for
 * without it to the one with it, so this is the launcher's own word. It is only ever SHOWN: nothing here asks for it.
 */
export function localPreparationAccelerated(cfg, loc = globalThis.location) {
  try { return localLauncherRequested(cfg, loc) && new URL(loc.href).searchParams.get('prepare') === 'accelerated'; } catch { return false; }
}
/**
 * Whether the launcher that served this page makes NATURAL worlds (its `--world-preset local-natural-v1`): it puts
 * `world=natural` on every launcher page it serves, so the page knows before any start that a start builds a new
 * Season (up to the launcher's 210 s bound) and that the player's Join and PlaceHome come after it. Read here for the
 * wait and the text only; the start answer must then say `natural: true` as well, or the start is refused.
 */
export function localNaturalWorld(cfg, loc = globalThis.location) {
  try { return localLauncherRequested(cfg, loc) && new URL(loc.href).searchParams.get('world') === 'natural'; } catch { return false; }
}
/**
 * TEST-ONLY: whether the launcher that served this page runs the capture demo (its `--capture-demo`, natural worlds with
 * the march trial only): it puts `demo=capture` on every launcher page it serves. The start answer must then carry
 * `captureDemo: {scale}` with a valid scale, or the start is refused (`LauncherWorldMismatch`); a plain address can
 * never turn it on (the launcher redirects away a word it was not started with, and the answer decides).
 */
export function localCaptureDemoPage(cfg, loc = globalThis.location) {
  try { return localLauncherRequested(cfg, loc) && new URL(loc.href).searchParams.get('demo') === 'capture'; } catch { return false; }
}
/** The start answer's `captureDemo` → its synthetic clock scale (a whole number 10..60), or null. */
export function launcherCaptureDemo(v) {
  const s = v?.scale;
  return v !== null && typeof v === 'object' && Object.keys(v).length === 1 && Number.isInteger(s) && s >= 10 && s <= 60 ? s : null;
}
/**
 * TEST-ONLY: whether the launcher that served this page runs the ordinary march trial (its `--march-trial`, natural
 * worlds only): it puts `march=trial` on every launcher page it serves. The start answer must then say
 * `marchTrial: true` as well, or the start is refused (`LauncherWorldMismatch`). It is one of the two words the march's
 * test-only entry needs (flocalplay-march.mjs `localMarchOpen` `trialEntry`); the relay's capability is the other.
 */
export function localMarchTrialPage(cfg, loc = globalThis.location) {
  try { return localNaturalWorld(cfg, loc) && new URL(loc.href).searchParams.get('march') === 'trial'; } catch { return false; }
}
/**
 * The march's part of the identity, from a verified launcher start: the launcher's stated runner instance (the one the
 * relay's capability must name) and the test-only trial entry. Frozen; `{instance: null, trialEntry: false}` otherwise.
 */
export function launcherMarchStatement(body, { launcher = false, trialPage = false } = {}) {
  const instance = launcher && typeof body?.expiry?.instance === 'string' && /^[0-9a-f]{64}$/.test(body.expiry.instance) && !/^0{64}$/.test(body.expiry.instance) ? body.expiry.instance : null;
  return Object.freeze({ instance, trialEntry: launcher === true && trialPage === true && body?.marchTrial === true && instance !== null });
}
/** The page's wait for a natural start: past the launcher's own bound (its first line 180 s + its herald 30 s). */
export const NATURAL_START_MS = 240000;
/** What a launcher's start answer says was done to prepare the world, believed in nothing: `{accelerated, scale, chainSeconds, wallMs}` or null. */
export function launcherPrepared(value) {
  if (!value || typeof value !== 'object' || typeof value.accelerated !== 'boolean') return null;
  const whole = (n, max) => (Number.isSafeInteger(n) && n >= 0 && n <= max ? n : null);
  const scale = whole(value.scale, 100000), chainSeconds = whole(value.chainSeconds, 1e9), wallMs = whole(value.wallMs, 1e9);
  return scale === null || scale < 1 || chainSeconds === null || wallMs === null ? null : Object.freeze({ accelerated: value.accelerated, scale, chainSeconds, wallMs });
}
/** The page's statement of a conquest world (flocalplay-conquest.mjs reads it as `FS.localPlay.conquestWorld`): its schema, and the explicit local test preset. */
export const LOCAL_PLAY_CONQUEST_WORLD_SCHEMA = 'frontier-local-play-conquest-world-v1';
export const LOCAL_PLAY_CONQUEST_WORLD_PRESET = 'local-conquest-test-v1';
/**
 * What a launcher's start answer says of its world as a conquest world, believed only where it is THIS start's:
 * exactly `{schema, program, season, world_preset, free_city: {p, q, site, tile}}`, of the dedicated local program,
 * of the very Season this page has verified on the herald (`identity`), under the explicit local preset. → a frozen
 * copy, or null. Null is the closed state: to this page the world is then not a conquest world, and no siege is
 * offered. Nothing here opens the siege either: the page's and the relay's own conditions are theirs.
 */
export function launcherConquestWorld(value, identity) {
  const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x), exact = (x, keys) => plain(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
  if (!exact(value, ['schema', 'program', 'season', 'world_preset', 'free_city']) || !plain(identity)) return null;
  if (value.schema !== LOCAL_PLAY_CONQUEST_WORLD_SCHEMA || value.world_preset !== LOCAL_PLAY_CONQUEST_WORLD_PRESET) return null;
  if (value.program !== LOCAL_PLAY_PROGRAM || value.program !== identity.programId || typeof value.season !== 'string' || value.season !== identity.seasonAddress) return null;
  const f = value.free_city, whole = /^-?(0|[1-9][0-9]{0,18})$/;
  if (!exact(f, ['p', 'q', 'site', 'tile']) || typeof f.p !== 'string' || !whole.test(f.p) || typeof f.q !== 'string' || !whole.test(f.q)
      || !Number.isInteger(f.site) || f.site < 0 || f.site > 11 || !Number.isInteger(f.tile) || f.tile < 0 || f.tile > 60) return null;
  return Object.freeze({ schema: value.schema, program: value.program, season: value.season, world_preset: value.world_preset, free_city: Object.freeze({ p: f.p, q: f.q, site: f.site, tile: f.tile }) });
}
/** Launcher replies name an exact loopback origin, not a path, credential or redirect. */
export function launcherHeraldOrigin(value) {
  if (typeof value !== 'string') return null;
  const origin = localHeraldOrigin(value);
  return origin && value === origin ? origin : null;
}

/** The most worlds the launcher runs at once (its WORLD_LIMIT): the most rows the panel has. */
export const LAUNCHER_WORLDS = 2;
/** The launcher's refusals this page has a sentence for: its code → the page's. Anything else is LauncherFailed. */
const LAUNCHER_CODES = Object.freeze({ WorldLimit: 'WorldLimit', WorldStopping: 'WorldStopping', DiskFloor: 'LauncherDiskFloor', PortBusy: 'LauncherPortBusy',
  RunnerNotReady: 'LauncherRunnerNotReady', HeraldNotReady: 'LauncherHeraldNotReady', LauncherClosed: 'LauncherClosed',
  // (the opt-in preparation of a new world: whichever step refused, the world was ended; the launcher's own code is shown beside the sentence)
  PrepareUnavailable: 'LauncherPrepareFailed', PrepareClock: 'LauncherPrepareFailed', PrepareTimeout: 'LauncherPrepareFailed', PrepareHalted: 'LauncherPrepareFailed', PrepareFailed: 'LauncherPrepareFailed',
  PrepareClockNotRestored: 'LauncherPrepareFailed', PrepareNotSettled: 'LauncherPrepareFailed', RunnerRpcRefused: 'LauncherPrepareFailed' });
const isAddress = text => { try { return typeof text === 'string' && text.length <= 44 && fromBase58(text).length === 32 && toBase58(fromBase58(text)) === text; } catch { return false; } };
/**
 * The worlds a refused start lists, believed in nothing: at most the launcher's two, each a PUBLIC address, since
 * when (a time, or null) and one of three states. Everything else of the reply is dropped.
 */
export function launcherWorlds(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list.slice(0, 8) : []) {
    if (out.length === LAUNCHER_WORLDS) break;
    if (!w || typeof w !== 'object' || !isAddress(w.wallet) || out.some(x => x.wallet === w.wallet)) continue;
    out.push({ wallet: w.wallet, startedAt: Number.isFinite(w.startedAt) && w.startedAt > 0 ? w.startedAt : null, state: ['starting', 'running', 'stopping'].includes(w.state) ? w.state : 'running' });
  }
  return out;
}
/** What a refused launcher request says: `{ok: false, code, launcher}` (`launcher`: its own code, when it named one), with `worlds` at the limit. */
async function launcherRefusal(response) {
  let body = null;
  try { body = await response.json(); } catch { /* no readable reason */ }
  const launcher = typeof body?.error === 'string' ? body.error : null;
  const code = launcher !== null && Object.hasOwn(LAUNCHER_CODES, launcher) ? LAUNCHER_CODES[launcher] : 'LauncherFailed';
  return { ok: false, code, launcher, ...(code === 'WorldLimit' ? { worlds: launcherWorlds(body.worlds) } : {}) };
}

/** A herald origin an operator may name in the panel: http(s) on a loopback host, nothing else of the URL. */
export function localHeraldOrigin(text) {
  try {
    const u = new URL(String(text).trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isLoopbackHost(u.hostname) || u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Read `herald` (a createHerald client) for `address` and say whether it is this wallet's local play:
 * `{ok: true, record, season}` or `{ok: false, code}`:
 *   HeraldUnreachable  nothing answers there (not started yet)
 *   HeraldNotReady     it answers, but has no season record yet
 *   LocalPlayProgram / LocalPlayCluster / LocalPlayVersion   the season is not the dedicated local program's, on
 *                      localnet, of the host-only dispatch revision
 *   WalletNotBound     the herald has no Citizen (or no village) for this wallet: the runner was started for another
 *   WalletBindingMismatch  the Citizen it serves names another wallet
 * `natural` (only from the launcher's own start answer, `natural: true`): the world starts from the player's real Join
 * and PlaceHome, so a wallet with no Citizen and no village yet is accepted (`identity.natural`); a Citizen that is
 * there must still be this wallet's, and villages without a Citizen are refused.
 * Reads only. The records are the herald's own; nothing is assumed from the URL.
 */
export async function verifyLocalPlayHerald(herald, address, { natural = false } = {}) {
  let s;
  try { s = await herald.season(); } catch { return { ok: false, code: 'HeraldUnreachable' }; }
  if (!s?.ok) return { ok: false, code: s?.code === 'network' ? 'HeraldUnreachable' : 'HeraldNotReady' };
  if (s.record?.programId !== LOCAL_PLAY_PROGRAM) return { ok: false, code: 'LocalPlayProgram' };
  if (s.record?.cluster !== LOCAL_PLAY_CLUSTER) return { ok: false, code: 'LocalPlayCluster' };
  if (s.season?.programVersion !== LOCAL_PLAY_PROGRAM_VERSION) return { ok: false, code: 'LocalPlayVersion' };
  // The Season's identity is worked out here from the dedicated program and the record's Season id, never taken from
  // the herald: the record must name that canonical Season account, and the client is PINNED to it before the
  // player's record is read, so the client's own checks (the Citizen at this wallet's canonical address, its bytes of
  // this Season, each village owned by that Citizen) are in force for that read.
  let seasonId, addresses;
  try {
    seasonId = String(s.record.season);
    if (!/^(0|[1-9][0-9]{0,19})$/.test(seasonId) || String(s.season.seasonId) !== seasonId) return { ok: false, code: 'LocalPlaySeason' };
    addresses = seasonAddresses(LOCAL_PLAY_PROGRAM, seasonId);
  } catch { return { ok: false, code: 'LocalPlaySeason' }; }
  if (s.record.seasonAddress !== addresses.season) return { ok: false, code: 'LocalPlaySeason' };
  try { herald.pin(seasonId, addresses); } catch { return { ok: false, code: 'LocalPlaySeason' }; }
  let me;
  try { me = await herald.me(address); } catch { return { ok: false, code: 'HeraldUnreachable' }; }
  if (!me?.ok) return { ok: false, code: me?.code === 'network' ? 'HeraldUnreachable' : ['WrongKey', 'WrongSeason', 'BadRecord'].includes(me?.code) ? 'WalletBindingMismatch' : 'WalletNotBound' };
  const villages = me.holdings?.length > 0;
  if (natural !== true && (!me.citizen || !villages)) return { ok: false, code: 'WalletNotBound' };
  if (natural === true && !me.citizen && villages) return { ok: false, code: 'WalletBindingMismatch' };
  if (me.citizen) {
    let bound = null;
    try { bound = toBase58(me.citizen.wallet); } catch { /* not a wallet */ }
    if (bound !== address) return { ok: false, code: 'WalletBindingMismatch' };
  }
  const base = { address, programId: LOCAL_PLAY_PROGRAM, cluster: LOCAL_PLAY_CLUSTER, seasonId, seasonAddress: addresses.season };
  return { ok: true, record: s.record, season: s.season, identity: Object.freeze(natural === true ? { ...base, natural: true } : base) };
}

/**
 * After the gate, the page boots and reads the season again by its ordinary path. This says whether what it then
 * pinned (`pin`: fchainio.pinned()) and decoded (`season`) is still the identity the gate verified, and whether the
 * player it read (`citizen`, when one was read) is still this wallet's. Local play goes on only while it is.
 */
export function localPlayIdentityOk(identity, pin, season, citizen = undefined) {
  if (!identity || !pin || pin.programId !== identity.programId || pin.cluster !== identity.cluster || String(pin.seasonId) !== identity.seasonId
      || pin.addresses?.season !== identity.seasonAddress || season?.programVersion !== LOCAL_PLAY_PROGRAM_VERSION) return false;
  if (citizen === undefined || citizen === null) return true;
  try { return toBase58(citizen.wallet) === identity.address; } catch { return false; }
}

const WHY = {
  HeraldUnreachable: () => L`この herald にはまだつながりません。ランナーと herald を起動してから、もう一度接続してください。`,
  HeraldNotReady: () => L`herald は応答しましたが、シーズンの記録がまだありません。少し待ってからもう一度接続してください。`,
  LocalPlayProgram: () => L`この herald はローカルプレイ専用プログラムのものではありません。`,
  LocalPlayCluster: () => L`この herald は localnet のものではありません。`,
  LocalPlayVersion: () => L`この herald のシーズンは、ローカルプレイの版ではありません。`,
  WalletNotBound: () => L`この herald には、このウォレットの市民と村がありません。上のアドレスでランナーを起動してください。`,
  WalletBindingMismatch: () => L`この herald の市民は、別のウォレットのものです。`,
  LocalPlaySeason: () => L`この herald のシーズンは、ローカルプレイ専用プログラムの正規のシーズンではありません。`,
  NoEd25519: () => L`このブラウザでは試験用ウォレットを作れません（Ed25519 に対応した新しいブラウザで開いてください）。`,
  EphemeralWalletHost: () => L`ローカルプレイは、この端末（localhost / 127.0.0.1）で開いたページでだけ使えます。`,
  LauncherFailed: () => L`世界を起動できませんでした。開始サービスを確認して、もう一度押してください。`,
  LauncherTimeout: () => L`世界の準備がまだ終わりません。同じウォレットでもう一度接続を試せます。`,
  LauncherWorldMismatch: () => L`開始サービスの答えが、このページの世界の種類（最初から始める世界かどうか）と合いません。この世界には接続しません。`,
  WorldLimit: () => L`すでに2つの世界が動いています。新しい世界を始めるには、下の一覧から終了する世界を自分で選んでください（勝手には止めません）。`,
  WorldStopping: () => L`この世界は終了の処理中です。少し待ってから、もう一度押してください。`,
  LauncherDiskFloor: () => L`この端末の空き容量が足りないため、世界を用意できません（5.25 GiB 以上の空きが必要です）。`,
  LauncherPortBusy: () => L`世界に使うポートを、ほかのプログラムが使っています。少し待ってから、もう一度押してください。`,
  LauncherRunnerNotReady: () => L`世界のランナーを起動できませんでした。開始サービスの記録（runner.err）を確認してください。`,
  LauncherHeraldNotReady: () => L`世界の herald の準備が時間内に終わりませんでした。もう一度押してください。`,
  LauncherClosed: () => L`開始サービスは終了の処理中です。開始サービスを起動し直してから、ページを開き直してください。`,
  LauncherStopFailed: () => L`世界を終了できませんでした。開始サービスを確認して、もう一度押してください。`,
  LauncherListFailed: () => L`動いている世界を確認できませんでした。開始サービスを確認して、もう一度押してください。`,
  LauncherPrepareFailed: () => L`試験世界の準備（時間の早送り）を終えられませんでした。その世界は終了しました。もう一度押すと、新しい世界で準備し直します。`,
  BadHerald: () => L`herald の場所は、この端末（localhost / 127.0.0.1）の http(s) の URL にしてください。`,
};
/** The sentence of a refusal code (the code itself when it has none). */
export const localPlayWhy = code => (WHY[code]?.() ?? String(code));

/**
 * The gate. Makes (or reuses) the page's memory-only wallet, shows the preparation panel in `doc`, and resolves ONCE,
 * when a Connect has verified a herald: `{cfg, wallet, record}` with `cfg` = the page's config pointed at that herald,
 * `devWallet: false` and `localPlay: {address}`. Until then nothing of the game has booted.
 *  - one check at a time: a press while one is under way does nothing;
 *  - a refusal keeps the panel, says why and waits for another press, with the SAME wallet;
 *  - after it has resolved, presses do nothing (one boot, one set of listeners).
 * `makeHerald(base)` builds the read client (createHerald in the page); `state()` is what the panel shows.
 * With the launcher: a start it refuses at its limit comes with its worlds (`state().worlds`), and `listWorlds()` —
 * the panel's own key — asks for them at any time; `endWorld(address)` — the second press on that world's row — asks
 * the launcher to end that one world. Nothing else calls either.
 * `makeWallet` (the memory-only wallet's maker), `now` and the timeouts are the tests' to replace.
 */
export function openLocalPlayGate({ cfg, loc = globalThis.location, doc = globalThis.document, win = globalThis.window, makeHerald, subtle, request = globalThis.fetch, launcherTimeoutMs = undefined, retryDelayMs = 500,
  stopTimeoutMs = 30000, makeWallet = createEphemeralWallet, now = () => Date.now() } = {}) {
  const launcher = localLauncherRequested(cfg, loc);
  // (a launcher that prepares its worlds fast needs longer for a start: the wait is 150 s there, 70 s otherwise)
  const marchTrial = localMarchTrialPage(cfg, loc), demoPage = localCaptureDemoPage(cfg, loc);
  let claimedDemo = null;
  const accelerated = localPreparationAccelerated(cfg, loc), natural = localNaturalWorld(cfg, loc), longest = natural ? NATURAL_START_MS : accelerated ? 150000 : 70000;
  let pendingLaunch = null;
  // (launcher mode: the standing notice mounted once the world is verified; told when the key is destroyed)
  let session = null;
  const state = { phase: 'creating', address: null, herald: cfg.herald, code: null, detail: null, checks: 0, worlds: [], ended: null, listed: null, prepared: null, conquestWorld: null };
  let handle = null, checking = false, done = false, resolveReady, rejectReady, ui = null;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const paint = () => { ui?.paint(state); };
  const connect = async () => {
    if (done || checking || !handle || handle.destroyed) return state;
    let base = localHeraldOrigin(ui?.heraldValue() ?? state.herald);
    if (!launcher && !base) { state.phase = 'refused'; state.code = 'BadHerald'; paint(); return state; }
    checking = true; state.herald = base; state.phase = launcher ? 'starting' : 'checking'; state.code = null; state.detail = null; state.worlds = []; state.ended = null; state.listed = null; state.checks++; paint();
    let result, claimed = null, claimedEnd = null, claimedMarch = null;
    if (launcher) {
      const abort = new AbortController(); pendingLaunch = abort;
      const deadline = Math.min(longest, Math.max(1, launcherTimeoutMs ?? longest));
      let timer;
      try {
        result = await Promise.race([
          (async () => {
            const startOnce = () => request(new URL('/local-play/start', loc.href).href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: handle.address }), signal: abort.signal, credentials: 'omit', redirect: 'error' });
            let response = await startOnce();
            if (abort.signal.aborted || handle.destroyed) return { ok: false, code: 'EphemeralWalletDestroyed' };
            if (!response?.ok) return launcherRefusal(response);
            let body = await response.json();
            // (the TEST-ONLY contest pair: the first player waits for the second; the same press is asked again, within
            //  this start's own deadline — nothing is signed or sent meanwhile, and the key stays this page's)
            while (body?.pairWaiting === true && body?.herald === undefined) {
              if (!state.pairWaiting) { state.pairWaiting = true; paint(); }
              await new Promise(resolve => setTimeout(resolve, Math.max(1, retryDelayMs)));
              if (abort.signal.aborted || handle.destroyed) return { ok: false, code: 'EphemeralWalletDestroyed' };
              response = await startOnce();
              if (abort.signal.aborted || handle.destroyed) return { ok: false, code: 'EphemeralWalletDestroyed' };
              if (!response?.ok) return launcherRefusal(response);
              body = await response.json();
            }
            if (state.pairWaiting) { state.pairWaiting = false; paint(); }
            state.pairRole = body?.pair?.role === 'first' || body?.pair?.role === 'second' ? body.pair.role : null;
            if (abort.signal.aborted || handle.destroyed) return { ok: false, code: 'EphemeralWalletDestroyed' };
            const origin = launcherHeraldOrigin(body?.herald);
            if (!origin) return { ok: false, code: 'BadHerald' };
            base = origin; state.prepared = launcherPrepared(body?.prepared); claimed = body?.conquestWorld ?? null; claimedEnd = body?.expiry ?? null;
            // (a natural world: the page's mode, known before the start, and the launcher's answer must agree; then the
            //  player's Join and PlaceHome are still to come)
            if ((body?.natural === true) !== natural) return { ok: false, code: 'LauncherWorldMismatch' };
            // (the same for the test-only march trial: the page's `march=trial` and the answer's `marchTrial` agree)
            if ((body?.marchTrial === true) !== marchTrial) return { ok: false, code: 'LauncherWorldMismatch' };
            // (and for the test-only capture demo: the page's `demo=capture` and a valid `captureDemo` in the answer agree)
            claimedDemo = launcherCaptureDemo(body?.captureDemo);
            if ((claimedDemo !== null) !== demoPage || (body?.captureDemo !== undefined && claimedDemo === null)) return { ok: false, code: 'LauncherWorldMismatch' };
            claimedMarch = launcherMarchStatement(body, { launcher: true, trialPage: marchTrial });
            while (!abort.signal.aborted && !handle.destroyed) {
              const checked = await verifyLocalPlayHerald(makeHerald(base), handle.address, { natural });
              if (abort.signal.aborted || handle.destroyed) return { ok: false, code: 'EphemeralWalletDestroyed' };
              if (checked.ok || !['HeraldUnreachable', 'HeraldNotReady', 'WalletNotBound'].includes(checked.code)) return checked;
              await new Promise(resolve => setTimeout(resolve, Math.max(1, retryDelayMs)));
            }
            return { ok: false, code: 'EphemeralWalletDestroyed' };
          })(),
          new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve({ ok: false, code: 'LauncherTimeout' }); }, deadline); }),
        ]);
      } catch { result = { ok: false, code: 'LauncherFailed' }; }
      finally { clearTimeout(timer); abort.abort(); if (pendingLaunch === abort) pendingLaunch = null; }
    } else {
      try { result = await verifyLocalPlayHerald(makeHerald(base), handle.address); } catch { result = { ok: false, code: 'HeraldUnreachable' }; }
    }
    checking = false;
    if (done) return state;
    if (handle.destroyed) { state.phase = 'destroyed'; state.code = 'EphemeralWalletDestroyed'; paint(); return state; }
    if (!result.ok) { state.phase = 'refused'; state.code = result.code; state.detail = result.code === 'LauncherPrepareFailed' ? result.launcher : null; state.worlds = result.worlds ?? []; state.prepared = null; state.conquestWorld = null; paint(); return state; }
    // (the launcher's word on its world, held to the identity this page has just verified on the herald; only then is it on the identity)
    const world = launcher ? launcherConquestWorld(claimed, result.identity) : null;
    state.conquestWorld = world;
    const identity = world ? Object.freeze({ ...result.identity, conquestWorld: world }) : result.identity;
    // (the march's statement rides on the identity only for a launcher start that stated an instance; otherwise the
    //  identity is as it always was. The controller reads it as `localPlay.march`)
    const played = launcher && claimedMarch?.instance ? Object.freeze({ ...identity, march: claimedMarch }) : identity;
    // (TEST-ONLY capture demo: its synthetic clock scale, as the start answer stated it and the gate checked it, so that a wait
    //  can be said in the wall's time and not in game minutes thirty times too long; no other world carries it)
    const playedAs = launcher && claimedDemo !== null ? Object.freeze({ ...played, clockScale: claimedDemo }) : played;
    done = true; state.herald = base; state.phase = 'connected'; paint();
    // (the gate's panel is hidden now: what stays true for the session is said on screen, launcher worlds only)
    if (launcher) { const mine = handle.address; session = mountSessionNotice({ doc, win, onCheck: () => checkKeeper(mine), demo: claimedDemo, ...(state.pairRole === 'second' && claimedDemo !== null ? { onPair: () => checkPair(mine, { herald: base, expiry: claimedEnd }) } : {}) }); }
    // (then, without holding the boot: the world's end, shown only once this herald's relay confirms the runner's own
    //  instance for this wallet — one read, dropped if the page became another wallet or herald or lost its key meanwhile)
    if (launcher && session) {
      const asked = handle.address, at = base;
      confirmWorldEnd({ expiry: claimedEnd, origin: at, wallet: asked, request, notice: session, now, still: () => !handle.destroyed && handle.address === asked && state.herald === at }).catch(() => {});
    }
    resolveReady({ cfg: { ...cfg, herald: base, relay: `${base}/gw`, devWallet: false, localPlay: playedAs }, wallet: handle, record: result.record, ...(launcher ? { prepared: state.prepared } : {}) });
    return state;
  };
  // One bounded same-origin POST to the launcher's stop or worlds route: `{ok: true, body}`, or its refusal
  // (`launcher`: the launcher's own code, when it named one; `code`: this page's, `failure` when it has none).
  const askLauncher = async (route, body, failure) => {
    const abort = new AbortController(); pendingLaunch = abort;
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await request(new URL(route, loc.href).href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal, credentials: 'omit', redirect: 'error' });
          if (response?.ok) { let answer = null; try { answer = await response.json(); } catch { /* no body */ } return { ok: true, body: answer }; }
          const refusal = await launcherRefusal(response);
          return { ok: false, launcher: refusal.launcher, code: refusal.code === 'LauncherFailed' ? failure : refusal.code };
        })(),
        new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve({ ok: false, launcher: null, code: failure }); }, Math.min(30000, Math.max(1, stopTimeoutMs))); }),
      ]);
    } catch { return { ok: false, launcher: null, code: failure }; }
    finally { clearTimeout(timer); abort.abort(); if (pendingLaunch === abort) pendingLaunch = null; }
  };
  /** After a launcher answer: whether the gate still stands (not booted, its wallet alive); says so on the panel if not. */
  const stillHere = () => {
    checking = false;
    if (done) return false;
    if (handle.destroyed) { state.phase = 'destroyed'; state.code = 'EphemeralWalletDestroyed'; paint(); return false; }
    return true;
  };
  // The explicit end of ONE listed world (the launcher's same-origin stop route, the world's public address and
  // nothing else). Only for a world the launcher itself listed, one request at a time, and never on this page's own
  // initiative: the panel calls it from the confirming press on that world's row.
  const endWorld = async address => {
    if (done || checking || !launcher || !handle || handle.destroyed || !state.worlds.some(w => w.wallet === address)) return state;
    checking = true; state.phase = 'stopping'; state.code = null; state.detail = null; state.ended = null; state.listed = null; paint();
    const result = await askLauncher('/local-play/stop', { wallet: address }, 'LauncherStopFailed');
    if (!stillHere()) return state;
    // (a world that ended by itself meanwhile is the same to the player: its place is free)
    if (!result.ok && result.launcher !== 'WorldNotFound') { state.phase = 'refused'; state.code = result.code; paint(); return state; }
    state.worlds = state.worlds.filter(w => w.wallet !== address); state.phase = 'waiting'; state.code = null; state.ended = address; paint();
    return state;
  };
  // This world's keeper, on the player's own press of the notice's key (never polled): `{state: 'reported', keeper}` with
  // the launcher's codes and numbers, `{state: 'unavailable'}`, or null once the page is another wallet or lost its key.
  const checkKeeper = async wallet => {
    if (!launcher || !handle || handle.destroyed || handle.address !== wallet) return null;
    const result = await askLauncher('/local-play/keeper', { wallet }, 'LauncherKeeperFailed');
    if (!handle || handle.destroyed || handle.address !== wallet) return null;
    return result.ok ? { state: 'reported', keeper: result.body?.keeper ?? null } : { state: 'unavailable' };
  };
  // TEST-ONLY contest pair, the second player's own press of the notice's key (never polled): the fort and nation to meet
  // over, checked again on this page (`pairGuideView`: mode, this page's own role, every number), or null once the page
  // is another wallet or lost its key. Nothing is signed or sent; the choice of nation stays the player's.
  // (`scope`: the herald and the end this page verified at its own start; an answer about any other world is not shown)
  const checkPair = async (wallet, scope) => {
    if (!launcher || !handle || handle.destroyed || handle.address !== wallet || state.pairRole !== 'second' || state.herald !== scope?.herald) return null;
    const result = await askLauncher('/local-play/pair', { wallet }, 'LauncherPairFailed');
    if (!handle || handle.destroyed || handle.address !== wallet || state.herald !== scope.herald) return null;
    return result.ok ? pairGuideView(result.body, state.pairRole, scope, now()) : { state: 'unavailable' };
  };
  // The worlds the launcher runs now, on the player's own press of the panel's key (never before a press): so a world
  // left by an earlier page can be ended, and a new one started, without first meeting the limit.
  const listWorlds = async () => {
    if (done || checking || !launcher || !handle || handle.destroyed) return state;
    checking = true; state.phase = 'listing'; state.code = null; state.detail = null; state.ended = null; state.listed = null; paint();
    const result = await askLauncher('/local-play/worlds', {}, 'LauncherListFailed');
    if (!stillHere()) return state;
    if (!result.ok) { state.phase = 'refused'; state.code = result.code; paint(); return state; }
    state.worlds = launcherWorlds(result.body?.worlds); state.listed = state.worlds.length; state.phase = 'waiting'; state.code = null; paint();
    return state;
  };
  // The panel stands before the wallet is made: a page that cannot make one says so where the operator looks.
  ui = doc ? mountPanel(doc, { onConnect: connect, onEnd: endWorld, onList: listWorlds, launcher, accelerated, natural, now }) : null;
  paint();
  (async () => {
    try {
      handle = await makeWallet({ cluster: LOCAL_PLAY_CLUSTER, hostname: loc?.hostname, localPlay: true, ...(subtle ? { subtle } : {}) });
      handle.announce(win);
      // the page going away ends the wallet: its key is dropped, the page's connection with it
      win?.addEventListener?.('pagehide', () => { pendingLaunch?.abort(); handle.destroy(); state.phase = 'destroyed'; paint(); session?.destroyed(); }, { once: true });
      state.address = handle.address; state.phase = 'waiting';
      paint();
    } catch (e) {
      state.phase = 'unavailable'; state.code = e?.code ?? 'Error'; paint();
      rejectReady(Object.assign(new Error('local play is not available'), { code: state.code }));
    }
  })();
  return { ready, connect, endWorld, listWorlds, state: () => ({ ...state }), wallet: () => handle, notice: () => session };
}

/** A listed world in a few words: since when, and what it is doing. */
function worldLine(w, at) {
  const state = w.state === 'starting' ? L`起動中` : w.state === 'stopping' ? L`終了の処理中` : L`動作中`;
  if (w.startedAt === null) return state;
  const minutes = Math.max(0, Math.floor((at - w.startedAt) / 60000));
  return minutes < 1 ? L`たった今開始・${state}` : L`${minutes}分前に開始・${state}`;
}

/**
 * The preparation panel: built with createElement only (no markup string, no inline style attribute), under its own
 * stylesheet (flocalplay.css, a same-origin file linked here: nothing of the game's own styles is changed). A full
 * overlay above the page, reachable by keyboard (the herald field and Connect are ordinary controls).
 * With the launcher it also has a key that asks which worlds are running (`onList`) and the rows of the worlds the
 * launcher listed: each row's own key only asks; the key that then appears on that row ends that world (`onEnd`),
 * the other takes the question back.
 * Every text is in the page's language (lang.mjs): the fixed ones are written by `label()` at the mount and again on
 * a language switch, the others by `paint`. The page's own language key is put on the panel too (the panel covers
 * the page's, which is not mounted until the boot), so either language can be chosen before a world is started.
 */
function mountPanel(doc, { onConnect, onEnd = () => {}, onList = () => {}, launcher = false, accelerated = false, natural = false, now = () => Date.now() }) {
  const el = (tag, cls, text) => { const x = doc.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
  const sheet = el('link'); sheet.rel = 'stylesheet'; sheet.id = 'local-play-css'; sheet.href = new URL('./flocalplay.css', import.meta.url).href;
  (doc.head ?? doc.documentElement ?? doc.body)?.append(sheet);
  const root = el('section', 'local-play-gate'); root.id = 'local-play-gate'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'local-play-title');
  const card = el('div', 'local-play-card');
  const title = el('h2'); title.id = 'local-play-title';
  const head = el('div', 'local-play-head'); head.append(title);
  // (lang.mjs's own key, "EN" / its Japanese twin, whose clicks lang.mjs takes for the whole page; only where there is a real document to hold it)
  if (typeof head.prepend === 'function') mountLangToggle(head, { className: 'local-play-lang' });
  // (with the launcher: what this world is, in short points; without it, the operator's one paragraph as before)
  const note = launcher ? el('ul', 'local-play-points') : el('p', 'local-play-note');
  // (the last point is said before anything is pressed, when the launcher that served this page prepares its worlds that way)
  const points = launcher ? Array.from({ length: accelerated ? 5 : 4 }, (_, i) => el('li', i === 4 ? 'local-play-note local-play-prepare' : 'local-play-note')) : [];
  if (launcher) note.append(...points);
  const addressLabel = el('p', 'local-play-label');
  const address = el('code', 'local-play-address'); address.id = 'local-play-address';
  const heraldLabel = el('label', 'local-play-label'); heraldLabel.htmlFor = 'local-play-herald';
  const herald = el('input', 'local-play-herald'); herald.id = 'local-play-herald'; herald.type = 'url'; herald.autocomplete = 'off'; herald.spellcheck = false;
  const button = el('button', 'btn primary local-play-connect'); button.type = 'button'; button.id = 'local-play-connect';
  const status = el('p', 'local-play-status'); status.id = 'local-play-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  heraldLabel.hidden = launcher; herald.hidden = launcher;
  // (how long the start has been under way: beside the status, not in it, so it is not read out every second)
  const elapsed = el('p', 'local-play-elapsed'); elapsed.setAttribute('aria-hidden', 'true'); elapsed.hidden = true;
  let ticking = null, since = 0;
  const tick = () => { elapsed.textContent = L`${Math.max(0, Math.round((now() - since) / 1000))}秒経過`; };
  const list = el('button', 'btn local-play-list'); list.type = 'button'; list.id = 'local-play-list'; list.hidden = !launcher;
  const worldsLabel = el('p', 'local-play-label local-play-worlds-label'); worldsLabel.id = 'local-play-worlds-label'; worldsLabel.hidden = true;
  const worlds = el('div', 'local-play-worlds'); worlds.id = 'local-play-worlds'; worlds.hidden = true; worlds.setAttribute('role', 'group'); worlds.setAttribute('aria-labelledby', 'local-play-worlds-label');
  let last = null, shown = [], armed = null, before = null;
  const again = () => { if (last) ui.paint(last); };
  // (fixed rows, only shown or hidden: nothing is built from the launcher's reply but text)
  const rows = Array.from({ length: LAUNCHER_WORLDS }, (_, i) => {
    const row = el('div', 'local-play-world'); row.hidden = true;
    const where = el('code', 'local-play-world-address'), line = el('p', 'local-play-world-line');
    const end = el('button', 'btn local-play-end'); end.type = 'button';
    const ask = el('p', 'local-play-world-ask'); ask.hidden = true;
    const yes = el('button', 'btn local-play-end-yes'); yes.type = 'button'; yes.hidden = true;
    const no = el('button', 'btn local-play-end-no'); no.type = 'button'; no.hidden = true;
    end.addEventListener('click', () => { if (!shown[i] || end.disabled) return; armed = shown[i].wallet; again(); no.focus?.(); });
    no.addEventListener('click', () => { armed = null; again(); end.focus?.(); });
    yes.addEventListener('click', () => { const w = shown[i]; if (!w || armed !== w.wallet || yes.disabled) return; armed = null; onEnd(w.wallet); });
    row.append(where, line, end, ask, yes, no); worlds.append(row);
    return { row, where, line, end, ask, yes, no };
  });
  // Every fixed text of the panel, in the language shown now.
  const label = () => {
    title.textContent = launcher ? L`新しい世界で遊ぶ` : L`ローカルプレイの準備`;
    if (!launcher) note.textContent = L`この端末だけの試験用ウォレットです。鍵はこのページのメモリにだけあり、保存されません。ページを閉じる・読み込み直すと失われます。`;
    const said = [L`この端末だけの試験用の世界です。開始ボタンで新しい世界を用意します。`,
      L`鍵は保存されないため、再読み込み・ページを閉じると今の世界は続けられません。開き直したら、新しい世界から始めてください。`,
      L`通常速度では1ターン10分です。世界の開始後も、行軍や精算にはターンの進行を待ちます。`,
      L`世界は同時に2つまでです。どの世界も、開始サービスで決めた時間（既定は開始から2時間）がたつと自動的に終わり、その進行は保存されません。上限のときは、終了する世界を自分で選びます（勝手には止めません）。`,
      L`この試験用の世界は、準備のあいだだけ世界の時間を早送りします（出発先の州を開くため）。操作できるようになる前に通常速度へ戻し、そのあとは早送りしません。`];
    points.forEach((point, i) => { point.textContent = said[i]; });
    addressLabel.textContent = launcher ? L`この世界の公開アドレス` : L`公開アドレス（ランナーの起動に使います）`;
    heraldLabel.textContent = L`herald の場所`;
    button.textContent = launcher ? L`新しい世界を開始` : L`接続`;
    list.textContent = L`動いている世界を確認`;
    worldsLabel.textContent = L`動いている世界（公開アドレス）`;
    for (const r of rows) {
      r.end.textContent = L`この世界を終了…`; r.yes.textContent = L`終了する`; r.no.textContent = L`やめる`;
      r.ask.textContent = L`この世界を終了しますか？ 元に戻せません。この世界で遊んでいるページは、続けられなくなります。`;
    }
    if (ticking !== null) tick();
  };
  label();
  // (a language switch while the panel stands: the fixed texts again, then the state's; no longer once the page has booted)
  const unlabel = onLangChange(() => { label(); again(); });
  card.append(head, note, addressLabel, address, heraldLabel, herald, button, status, elapsed, list, worldsLabel, worlds);
  root.append(card);
  button.addEventListener('click', () => { onConnect(); });
  list.addEventListener('click', () => { if (!list.disabled) onList(); });
  herald.addEventListener('keydown', e => { if (e?.key === 'Enter') onConnect(); });
  (doc.body ?? doc.documentElement)?.append(root);
  let filled = false;
  const ui = {
    heraldValue: () => herald.value,
    paint(s) {
      last = s;
      address.textContent = s.address ?? '';
      if (!filled && s.herald) { herald.value = s.herald; filled = true; }
      const idle = s.phase === 'waiting' || s.phase === 'refused';
      button.disabled = !idle; herald.disabled = !idle; list.disabled = !idle;
      root.dataset.phase = s.phase;
      shown = launcher ? (s.worlds ?? []).slice(0, LAUNCHER_WORLDS) : [];
      if (!idle || !shown.some(w => w.wallet === armed)) armed = null;
      worlds.hidden = shown.length === 0; worldsLabel.hidden = shown.length === 0;
      rows.forEach((r, i) => {
        const w = shown[i]; r.row.hidden = !w;
        if (!w) return;
        const asking = armed === w.wallet;
        r.where.textContent = w.wallet; r.line.textContent = worldLine(w, now());
        r.end.hidden = asking; r.end.disabled = !idle || w.state === 'stopping';
        r.ask.hidden = !asking; r.yes.hidden = !asking; r.no.hidden = !asking; r.yes.disabled = !idle; r.no.disabled = !idle;
      });
      const starting = s.phase === 'starting';
      if (starting && ticking === null) { since = now(); tick(); ticking = setInterval(tick, 1000); ticking?.unref?.(); }
      if (!starting && ticking !== null) { clearInterval(ticking); ticking = null; }
      elapsed.hidden = !starting;
      // (a key that was pressed is disabled while its request is under way and loses the keyboard: it gets it back when
      //  the panel is usable again — the start key after a refused start, the list key after its answer; and the row that
      //  was acted on is gone once its world has ended, so the keyboard goes on from the start key)
      if (before === 'stopping' && s.phase !== 'stopping') button.focus?.();
      if (before === 'starting' && s.phase === 'refused') button.focus?.();
      if (before === 'listing' && s.phase !== 'listing' && s.phase !== 'destroyed') list.focus?.();
      before = s.phase;
      status.textContent = s.phase === 'creating' ? L`試験用ウォレットを作っています…`
        : s.phase === 'stopping' ? L`選んだ世界を終了しています…`
        : s.phase === 'listing' ? L`動いている世界を確認しています…`
        : s.phase === 'waiting' && launcher && s.listed === 0 ? L`動いている世界はありません。`
        : s.phase === 'waiting' && launcher && s.listed > 0 ? L`動いている世界は${s.listed}個です。終了する世界があれば、下の一覧のその行で選べます。`
        : s.phase === 'waiting' && launcher && s.ended ? L`世界を終了しました。「新しい世界を開始」をもう一度押すと、新しい世界を用意します。`
        : s.phase === 'waiting' && launcher ? L`「新しい世界を開始」を押すと準備します。送信や署名はゲーム中に自分で確認します。`
        // (the TEST-ONLY contest pair: the first player waits for the second, who presses start in another tab)
        : s.phase === 'starting' && s.pairWaiting ? L`もう一人のプレイヤーを待っています。別のタブで、もう一人が「新しい世界を開始」を押すと、二人で一つの世界が始まります。待っている間、このタブは何も送信しません。`
        : s.phase === 'starting' && natural ? L`新しいシーズンを最初から作っています…（最大4分。できたら、ゲームの画面で国を選んで参加し、村を置きます）`
        : s.phase === 'starting' && accelerated ? L`世界を準備しています…（試験世界の準備として、世界の時間を早送りします。最大150秒）`
        : s.phase === 'starting' ? L`世界を準備しています…（最大70秒）`
        : s.phase === 'waiting' ? L`準備中：このアドレスでランナーと herald を起動してから「接続」を押してください。`
        : s.phase === 'checking' ? L`herald の記録を確かめています…`
        : s.phase === 'connected' ? L`接続しました：このウォレットの市民と村を読み込みます（読み取りのみ。送信はしません）。`
        : s.phase === 'destroyed' ? L`ウォレットは破棄されました。ページを開き直してください。`
        : s.code ? `${localPlayWhy(s.code)} (${s.detail ? `${s.code}: ${s.detail}` : s.code})` : '';
      if (s.phase === 'connected') { root.hidden = true; unlabel(); }
    },
  };
  return ui;
}
