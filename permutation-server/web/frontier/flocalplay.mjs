// Local play, an explicit opt-in of the game page: `?localPlay=1` on a loopback host, play mode only.
//
// Why a gate before the page boots: the local runner is started WITH the player's public address, and only then does
// its herald hold that player's accounts. So the page first makes its memory-only test wallet
// (fephemeral-wallet.mjs), shows the PUBLIC address, and waits. The operator starts the runner and herald for that
// address and presses Connect in this same open page (a reload or another URL would lose the wallet). Connect reads
// the herald's own records and goes on only when they are the dedicated local program's, on localnet, of the
// host-only dispatch revision, and name this wallet's Citizen. Anything else is said as it is and may be tried again,
// with the same wallet. The ordinary boot then runs once, against that herald.
//
// Scope: wallet → the real player's READS. While local play is on the controller sends nothing (no Join, SetSession,
// payment or order), restores and stores no session key, and the dev wallet stays off. Nothing here stores a secret.
import { createEphemeralWallet, isLoopbackHost, EPHEMERAL_WALLET_NAME } from './fephemeral-wallet.mjs';
import { encode as toBase58 } from '../sdk/base58.mjs';
import { seasonAddresses } from './faddr.mjs';
import { L } from '../lang.mjs';

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
 * Reads only. The records are the herald's own; nothing is assumed from the URL.
 */
export async function verifyLocalPlayHerald(herald, address) {
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
  if (!me.citizen || !(me.holdings?.length > 0)) return { ok: false, code: 'WalletNotBound' };
  let bound = null;
  try { bound = toBase58(me.citizen.wallet); } catch { /* not a wallet */ }
  if (bound !== address) return { ok: false, code: 'WalletBindingMismatch' };
  return { ok: true, record: s.record, season: s.season, identity: Object.freeze({ address, programId: LOCAL_PLAY_PROGRAM, cluster: LOCAL_PLAY_CLUSTER, seasonId, seasonAddress: addresses.season }) };
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
 */
export function openLocalPlayGate({ cfg, loc = globalThis.location, doc = globalThis.document, win = globalThis.window, makeHerald, subtle } = {}) {
  const state = { phase: 'creating', address: null, herald: cfg.herald, code: null, checks: 0 };
  let handle = null, checking = false, done = false, resolveReady, rejectReady, ui = null;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const paint = () => { ui?.paint(state); };
  const connect = async () => {
    if (done || checking || !handle || handle.destroyed) return state;
    const base = localHeraldOrigin(ui?.heraldValue() ?? state.herald);
    if (!base) { state.phase = 'refused'; state.code = 'BadHerald'; paint(); return state; }
    checking = true; state.herald = base; state.phase = 'checking'; state.code = null; state.checks++; paint();
    let result;
    try { result = await verifyLocalPlayHerald(makeHerald(base), handle.address); } catch { result = { ok: false, code: 'HeraldUnreachable' }; }
    checking = false;
    if (done) return state;
    if (handle.destroyed) { state.phase = 'destroyed'; state.code = 'EphemeralWalletDestroyed'; paint(); return state; }
    if (!result.ok) { state.phase = 'refused'; state.code = result.code; paint(); return state; }
    done = true; state.phase = 'connected'; paint();
    resolveReady({ cfg: { ...cfg, herald: base, relay: `${base}/gw`, devWallet: false, localPlay: result.identity }, wallet: handle, record: result.record });
    return state;
  };
  // The panel stands before the wallet is made: a page that cannot make one says so where the operator looks.
  ui = doc ? mountPanel(doc, { onConnect: connect }) : null;
  paint();
  (async () => {
    try {
      handle = await createEphemeralWallet({ cluster: LOCAL_PLAY_CLUSTER, hostname: loc?.hostname, localPlay: true, ...(subtle ? { subtle } : {}) });
      handle.announce(win);
      // the page going away ends the wallet: its key is dropped, the page's connection with it
      win?.addEventListener?.('pagehide', () => handle.destroy(), { once: true });
      state.address = handle.address; state.phase = 'waiting';
      paint();
    } catch (e) {
      state.phase = 'unavailable'; state.code = e?.code ?? 'Error'; paint();
      rejectReady(Object.assign(new Error('local play is not available'), { code: state.code }));
    }
  })();
  return { ready, connect, state: () => ({ ...state }), wallet: () => handle };
}

/**
 * The preparation panel: built with createElement only (no markup string, no inline style attribute), under its own
 * stylesheet (flocalplay.css, a same-origin file linked here: nothing of the game's own styles is changed). A full
 * overlay above the page, reachable by keyboard (the herald field and Connect are ordinary controls).
 */
function mountPanel(doc, { onConnect }) {
  const el = (tag, cls, text) => { const x = doc.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x; };
  const sheet = el('link'); sheet.rel = 'stylesheet'; sheet.id = 'local-play-css'; sheet.href = new URL('./flocalplay.css', import.meta.url).href;
  (doc.head ?? doc.documentElement ?? doc.body)?.append(sheet);
  const root = el('section', 'local-play-gate'); root.id = 'local-play-gate'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'local-play-title');
  const card = el('div', 'local-play-card');
  const title = el('h2', null, L`ローカルプレイの準備`); title.id = 'local-play-title';
  const note = el('p', 'local-play-note', L`この端末だけの試験用ウォレットです。鍵はこのページのメモリにだけあり、保存されません。ページを閉じる・読み込み直すと失われます。`);
  const addressLabel = el('p', 'local-play-label', L`公開アドレス（ランナーの起動に使います）`);
  const address = el('code', 'local-play-address'); address.id = 'local-play-address';
  const heraldLabel = el('label', 'local-play-label', L`herald の場所`); heraldLabel.htmlFor = 'local-play-herald';
  const herald = el('input', 'local-play-herald'); herald.id = 'local-play-herald'; herald.type = 'url'; herald.autocomplete = 'off'; herald.spellcheck = false;
  const button = el('button', 'btn primary local-play-connect', L`接続`); button.type = 'button'; button.id = 'local-play-connect';
  const status = el('p', 'local-play-status'); status.id = 'local-play-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  card.append(title, note, addressLabel, address, heraldLabel, herald, button, status);
  root.append(card);
  button.addEventListener('click', () => { onConnect(); });
  herald.addEventListener('keydown', e => { if (e?.key === 'Enter') onConnect(); });
  (doc.body ?? doc.documentElement)?.append(root);
  let filled = false;
  return {
    heraldValue: () => herald.value,
    paint(s) {
      address.textContent = s.address ?? '';
      if (!filled && s.herald) { herald.value = s.herald; filled = true; }
      const idle = s.phase === 'waiting' || s.phase === 'refused';
      button.disabled = !idle; herald.disabled = !idle;
      root.dataset.phase = s.phase;
      status.textContent = s.phase === 'creating' ? L`試験用ウォレットを作っています…`
        : s.phase === 'waiting' ? L`準備中：このアドレスでランナーと herald を起動してから「接続」を押してください。`
        : s.phase === 'checking' ? L`herald の記録を確かめています…`
        : s.phase === 'connected' ? L`接続しました：このウォレットの市民と村を読み込みます（読み取りのみ。送信はしません）。`
        : s.phase === 'destroyed' ? L`ウォレットは破棄されました。ページを開き直してください。`
        : s.code ? `${localPlayWhy(s.code)} (${s.code})` : '';
      if (s.phase === 'connected') root.hidden = true;
    },
  };
}
